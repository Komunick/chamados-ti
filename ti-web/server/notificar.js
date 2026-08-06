'use strict';
/*
 * Chamados de TI — avisos externos (e-mail e webhook/WhatsApp).
 * ---------------------------------------------------------------------------
 * Node puro, sem dependências. Tudo é OPCIONAL e desligado por padrão: o
 * arquivo ti-data/notificar-config.json (criado na primeira execução com um
 * modelo) liga cada canal.
 *
 *  - email: SMTP direto (TLS na porta 465 ou STARTTLS na 587), AUTH LOGIN.
 *    Usa o campo "email" do usuário destinatário (painel de usuários).
 *  - webhook: POST JSON numa URL sua (ex.: gateway de WhatsApp como a
 *    Evolution API, um fluxo do n8n/Zapier etc.). Recebe
 *    { evento, assunto, mensagem, chamadoId, para: { nome, email, celular } }.
 *
 * Os envios são "dispara e esquece": falha vira uma linha no console e nunca
 * derruba a requisição que originou o aviso.
 */
const fs = require('fs');
const path = require('path');
const tls = require('tls');
const net = require('net');
const http = require('http');
const https = require('https');
const d = require('./db');

const CONFIG_FILE = path.join(d.DATA_DIR, 'notificar-config.json');

const MODELO = {
  _leia: 'Avisos externos do Chamados de TI. Ligue um canal trocando "ativo" para true. ' +
    'email: SMTP (porta 465 TLS direto; 587 STARTTLS). webhook: POST JSON para WhatsApp/n8n/Zapier.',
  email: { ativo: false, host: 'smtp.exemplo.com', porta: 465, usuario: '', senha: '', de: 'Chamados TI <ti@empresa.com.br>' },
  webhook: { ativo: false, url: 'https://exemplo.com/webhook-chamados' },
};

function carregarConfig() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
  } catch (e) {
    if (e.code === 'ENOENT') {
      try { fs.writeFileSync(CONFIG_FILE, JSON.stringify(MODELO, null, 2)); } catch (_) { /* ignore */ }
    } else {
      console.error('[Chamados TI] notificar-config.json inválido: ' + e.message + ' (avisos externos desligados)');
    }
    return { email: { ativo: false }, webhook: { ativo: false } };
  }
}

// Lida a cada envio: dá para ligar/desligar sem reiniciar o servidor.
function config() { return carregarConfig(); }

// ---------------------------------------------------------------------------
// SMTP mínimo (AUTH LOGIN). Porta 465 = TLS direto; outras = STARTTLS.
// ---------------------------------------------------------------------------
function smtpEnviar(cfg, para, assunto, corpo) {
  return new Promise((resolve, reject) => {
    const seguro = Number(cfg.porta) === 465;
    const timeout = setTimeout(() => { try { sock.destroy(); } catch (_) { /* ignore */ } reject(new Error('SMTP: tempo esgotado')); }, 20000);
    let sock = seguro
      ? tls.connect({ host: cfg.host, port: Number(cfg.porta), servername: cfg.host })
      : net.connect({ host: cfg.host, port: Number(cfg.porta) });

    let buffer = '';
    let etapa = 0;
    let tlsFeito = seguro; // 465 já nasce cifrado; nas demais portas, STARTTLS
    const b64 = (s) => Buffer.from(String(s), 'utf8').toString('base64');
    // Remetente pode vir como "Nome <email>"; no envelope vai só o e-mail.
    const mDe = /<([^>]+)>/.exec(String(cfg.de || cfg.usuario));
    const envelopeDe = mDe ? mDe[1] : String(cfg.de || cfg.usuario).trim();

    const mensagem = [
      'From: ' + (cfg.de || cfg.usuario),
      'To: ' + para,
      'Subject: =?UTF-8?B?' + b64(assunto) + '?=',
      'MIME-Version: 1.0',
      'Content-Type: text/plain; charset=utf-8',
      'Content-Transfer-Encoding: base64',
      '',
      Buffer.from(corpo, 'utf8').toString('base64').replace(/(.{76})/g, '$1\r\n'),
      '',
    ].join('\r\n');

    // Só a primeira conclusão vale: o 'close' do socket chega depois do
    // resolve normal e não pode virar uma rejeição fantasma.
    let terminou = false;
    const falhar = (msg) => {
      if (terminou) return;
      terminou = true;
      clearTimeout(timeout);
      try { sock.destroy(); } catch (_) { /* ignore */ }
      reject(new Error(msg));
    };
    const escrever = (linha) => sock.write(linha + '\r\n');

    function tratar(codigo, texto) {
      // Qualquer 4xx/5xx encerra com erro (mensagem ajuda a diagnosticar).
      if (codigo >= 400) return falhar('SMTP ' + codigo + ': ' + texto.slice(0, 200));
      switch (etapa) {
        case 0: etapa = 1; escrever('EHLO chamados-ti'); break;
        case 1: // resposta do EHLO
          if (!tlsFeito) { etapa = 2; escrever('STARTTLS'); }
          else { etapa = 3; escrever('AUTH LOGIN'); }
          break;
        case 2: // 220 do STARTTLS → sobe TLS e refaz o EHLO (cai na etapa 1 já cifrado)
          sock.removeAllListeners('data');
          sock.removeAllListeners('error');
          tlsFeito = true;
          etapa = 1;
          sock = tls.connect({ socket: sock, servername: cfg.host }, () => escrever('EHLO chamados-ti'));
          ligarLeitura();
          break;
        case 3: etapa = 4; escrever(b64(cfg.usuario)); break;
        case 4: etapa = 5; escrever(b64(cfg.senha)); break;
        case 5: etapa = 6; escrever('MAIL FROM:<' + envelopeDe + '>'); break;
        case 6: etapa = 7; escrever('RCPT TO:<' + para + '>'); break;
        case 7: etapa = 8; escrever('DATA'); break;
        case 8: etapa = 9; sock.write(mensagem + '\r\n.\r\n'); break;
        case 9:
          // 250 aqui = mensagem ACEITA. Manda o QUIT por educação, mas conclui
          // na hora: muitos servidores fecham a conexão sem responder, e
          // esperar essa resposta prenderia a promessa até o timeout.
          etapa = 10;
          try { escrever('QUIT'); } catch (_) { /* ignore */ }
          concluir();
          break;
        default:
          concluir();
      }
    }

    function concluir() {
      if (terminou) return;
      terminou = true;
      clearTimeout(timeout);
      try { sock.end(); } catch (_) { /* ignore */ }
      resolve();
    }

    function ligarLeitura() {
      sock.on('data', (chunk) => {
        buffer += chunk.toString('utf8');
        // Processa somente respostas completas (linha final "NNN texto").
        let idx;
        while ((idx = buffer.indexOf('\r\n')) >= 0) {
          const linha = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);
          const m = /^(\d{3})([ -])(.*)$/.exec(linha);
          if (!m) continue;
          if (m[2] === '-') continue; // continuação de resposta multilinha
          tratar(Number(m[1]), m[3]);
        }
      });
      sock.on('error', (e) => falhar('SMTP: ' + e.message));
      // Conexão caiu antes da mensagem ser aceita: falha explícita em vez de
      // deixar a promessa pendurada até o timeout.
      sock.on('close', () => { if (etapa < 10) falhar('SMTP: conexão encerrada na etapa ' + etapa); });
    }
    ligarLeitura();
  });
}

// ---------------------------------------------------------------------------
// Webhook (WhatsApp/n8n/Zapier — POST JSON).
// ---------------------------------------------------------------------------
function webhookEnviar(url, payload) {
  return new Promise((resolve, reject) => {
    let alvo;
    try { alvo = new URL(url); } catch (e) { return reject(new Error('webhook: URL inválida')); }
    const mod = alvo.protocol === 'https:' ? https : http;
    const corpo = JSON.stringify(payload);
    const req = mod.request(alvo, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(corpo) },
      timeout: 10000,
    }, (res) => {
      res.resume();
      if (res.statusCode >= 200 && res.statusCode < 300) resolve();
      else reject(new Error('webhook: HTTP ' + res.statusCode));
    });
    req.on('timeout', () => { req.destroy(new Error('webhook: tempo esgotado')); });
    req.on('error', reject);
    req.end(corpo);
  });
}

// ---------------------------------------------------------------------------
// Fachada usada pelo servidor: avisa um usuário sobre um evento de chamado.
// ---------------------------------------------------------------------------
function avisar(usuario, evento, assunto, mensagem, chamadoId) {
  if (!usuario) return;
  const cfg = config();
  if (cfg.email && cfg.email.ativo && usuario.email) {
    smtpEnviar(cfg.email, usuario.email, assunto, mensagem)
      .catch((e) => console.error('[Chamados TI] e-mail para ' + usuario.email + ' falhou: ' + e.message));
  }
  if (cfg.webhook && cfg.webhook.ativo && cfg.webhook.url) {
    webhookEnviar(cfg.webhook.url, {
      evento,
      assunto,
      mensagem,
      chamadoId: chamadoId || null,
      para: { nome: usuario.nome, email: usuario.email || null, celular: usuario.celular || null },
    }).catch((e) => console.error('[Chamados TI] webhook falhou: ' + e.message));
  }
}

module.exports = { avisar, CONFIG_FILE };
