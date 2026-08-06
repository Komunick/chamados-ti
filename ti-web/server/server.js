'use strict';
/*
 * Chamados de TI — servidor HTTP (Brazil Transports).
 * ---------------------------------------------------------------------------
 * Node puro, SEM dependências externas (não precisa de npm install).
 *  - Serve os arquivos estáticos do app (index.html, app.js, styles.css).
 *  - API /api/*: autenticação, chamados, comentários, notificações, usuários.
 *  - SSE em /api/events para atualização em tempo real dos navegadores.
 *
 * Papéis: solicitante (abre chamados e comenta), ti (atende e recebe as
 * notificações), admin (tudo + usuários).
 *
 * Status do chamado: pendente → em_andamento → finalizado (livre para voltar).
 * Toda mudança fica no histórico do chamado com autor e data/hora — é assim
 * que alterações manuais são detectadas (GET /api/historico).
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const d = require('./db');
// Regras dos itens do Home Office — o mesmo arquivo que o navegador carrega,
// para a conferência da tela e a do servidor não divergirem.
const regrasHO = require('../regras-ho.js');
// Avisos externos (e-mail SMTP / webhook WhatsApp) — opcionais, ver
// ti-data/notificar-config.json. Falha de envio nunca derruba a requisição.
const notificar = require('./notificar');

const PORT = parseInt(process.env.PORT, 10) || 8085;
const HOST = process.env.HOST || '0.0.0.0';
const ROOT = path.join(__dirname, '..'); // pasta ti-web
// 8 MB: a foto da devolução de Home Office viaja em base64 no corpo JSON.
const BODY_LIMIT = parseInt(process.env.TI_BODY_LIMIT, 10) || 8 * 1024 * 1024;

const STATUS = ['pendente', 'em_andamento', 'finalizado'];
const PRIORIDADES = ['baixa', 'media', 'alta'];
const CATEGORIAS = ['sistema', 'equipamento', 'rede', 'acesso', 'impressora', 'outro'];
const PAPEIS = ['solicitante', 'ti', 'admin'];

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

function send(res, status, body, headers) {
  res.writeHead(status, headers || {});
  res.end(body);
}
function sendJson(res, status, obj) {
  send(res, status, JSON.stringify(obj), { 'Content-Type': 'application/json; charset=utf-8' });
}
function erro(res, status, msg) { sendJson(res, status, { error: msg }); }

// ---------------------------------------------------------------------------
// Tempo real (Server-Sent Events).
// ---------------------------------------------------------------------------
const sseClients = new Set();
let revision = 0;

function handleSSE(req, res, query) {
  const usuario = d.usuarioPorToken(query.get('token'));
  if (!usuario) return erro(res, 401, 'Sessão inválida.');
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write('retry: 3000\n\n');
  res.write(': conectado\n\n');
  sseClients.add(res);
  const ping = setInterval(() => { try { res.write(': ping\n\n'); } catch (e) { /* ignore */ } }, 25000);
  const done = () => { clearInterval(ping); sseClients.delete(res); };
  req.on('close', done);
  req.on('error', done);
}

function broadcast(evt) {
  const payload = 'data: ' + JSON.stringify(evt) + '\n\n';
  for (const res of sseClients) {
    try { res.write(payload); } catch (e) { sseClients.delete(res); }
  }
}

// O SSE é um canal único para todos os navegadores: nunca mande o CONTEÚDO de
// uma notificação por ele (avisos pessoais vazariam para quem está logado em
// outra conta). Só o sinal — cada cliente recarrega pela API, que filtra.
function avisarNovaNotificacao() {
  broadcast({ tipo: 'notificacao' });
}

function notifyChange(recurso) {
  revision += 1;
  broadcast({ tipo: 'mudanca', rev: revision, recurso });
}

// ---------------------------------------------------------------------------
// Utilidades.
// ---------------------------------------------------------------------------
function txt(v, max) {
  if (v === null || v === undefined) return '';
  return String(v).trim().slice(0, max || 200);
}
// Quem pode ALTERAR O ESTADO de um chamado (status, prioridade, urgencia,
// responsavel, categoria) — de qualquer chamado, nao so dos proprios. A pedido,
// restrito a: admin, o papel de atendimento 'ti' (hoje so o assistente 'claude')
// e o usuario 'junior'. Os demais (todos os solicitantes) apenas ABREM e
// COMENTAM chamados; nunca mexem no estado.
const ATENDENTES_EXTRA = new Set(['junior']); // solicitantes autorizados por login
function podeAtenderChamado(u) {
  return !!u && (u.papel === 'admin' || u.papel === 'ti' || ATENDENTES_EXTRA.has(u.login));
}

function publicoUsuario(u) {
  return {
    id: u.id, nome: u.nome, login: u.login, papel: u.papel,
    lider: !!u.lider, atende: podeAtenderChamado(u), criadoEm: u.criadoEm,
    // Contatos para os avisos externos (e-mail/WhatsApp) — ver server/notificar.js.
    email: u.email || null, celular: u.celular || null,
  };
}
// E-mail simples o bastante para uso interno (não vale a pena RFC completa).
function emailValido(v) { return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v); }
// Home Office: quem pode registrar saídas — líderes marcados pelo admin, TI e admin.
function gestorHomeOffice(u) {
  return !!u && (u.papel === 'ti' || u.papel === 'admin' || !!u.lider);
}
// Quem É líder de fato (a estrela que o admin marca no painel de usuários).
// Não confundir com gestorHomeOffice, que é PERMISSÃO de rota: a regra do
// celular vale pela liderança real, senão TI/admin sem a estrela levariam
// celular e a tela chamaria de "líder" quem o painel de usuários mostra que não é.
function ehLider(u) {
  return !!(u && u.lider);
}
function acharChamado(id) {
  return d.db.chamados.find((c) => c.id === id) || null;
}
/*
 * Molde único do chamado. TODA criação passa por aqui (fila normal e os dois
 * chamados que o Home Office abre), senão nasce sem prazo de SLA e fica fora
 * dos indicadores e da pill de prazo.
 */
function novoChamadoObj(usuario, campos) {
  const c = {
    id: d.novoIdChamado(),
    criadoEm: d.agora(),
    atualizadoEm: d.agora(),
    solicitante: { id: usuario.id, nome: usuario.nome },
    titulo: campos.titulo,
    descricao: campos.descricao || '',
    categoria: campos.categoria || 'outro',
    prioridade: campos.prioridade || 'media',
    urgente: !!campos.urgente,
    status: 'pendente',
    responsavel: null,
    responsavelId: null,
    finalizadoEm: null,
    comentarios: [],
    historico: [],
    anexos: [],
    avaliacao: null,
    prazoSla: null,
  };
  c.prazoSla = prazoSla(c);
  return c;
}
/*
 * Gravação preguiçosa: para dados de pouco valor (contador de leituras de
 * artigo), junta as alterações e grava uma vez a cada 30 s. Nada que precise
 * sobreviver a uma queda imediata deve usar isto — para esses, d.flush().
 */
let flushAgendado = null;
function agendarFlush() {
  if (flushAgendado) return;
  flushAgendado = setTimeout(() => {
    flushAgendado = null;
    try { d.flush(); } catch (e) { console.error('[Chamados TI] flush adiado falhou:', e.message); }
  }, 30000);
  flushAgendado.unref();
}

function historico(chamado, usuario, acao, detalhe) {
  chamado.historico.push({ em: d.agora(), por: usuario ? usuario.nome : 'sistema', acao, detalhe: detalhe || null });
  chamado.atualizadoEm = d.agora();
}
const STATUS_LABEL = { pendente: 'Pendente', em_andamento: 'Em andamento', finalizado: 'Finalizado' };
const PRIO_LABEL = { baixa: 'Baixa', media: 'Média', alta: 'Alta' };

// ---------------------------------------------------------------------------
// SLA — prazo-alvo de atendimento por prioridade (horas corridas). Urgente
// passa na frente de tudo. O prazo é recalculado quando a prioridade ou a
// urgência mudam (sempre a partir da abertura do chamado).
// ---------------------------------------------------------------------------
const SLA_HORAS = { urgente: 4, alta: 24, media: 72, baixa: 120 };
function slaHoras(chamado) {
  return chamado.urgente ? SLA_HORAS.urgente : (SLA_HORAS[chamado.prioridade] || SLA_HORAS.media);
}
// O relógio do prazo conta da abertura — ou da reabertura, quando o chamado
// voltou para a fila (senão nasceria vencido).
function prazoSla(chamado) {
  const inicio = Date.parse(chamado.reabertoEm || chamado.criadoEm);
  return new Date(inicio + slaHoras(chamado) * 3600 * 1000).toISOString();
}
function dentroDoSla(chamado) {
  if (chamado.status !== 'finalizado' || !chamado.finalizadoEm || !chamado.prazoSla) return null;
  return Date.parse(chamado.finalizadoEm) <= Date.parse(chamado.prazoSla);
}
// Migração: chamados antigos ganham o prazo na primeira subida com SLA.
{
  let backfill = false;
  for (const c of d.db.chamados) {
    if (!c.prazoSla) { c.prazoSla = prazoSla(c); backfill = true; }
    if (!Array.isArray(c.anexos)) { c.anexos = []; backfill = true; }
  }
  if (backfill) d.flush();
}

// Prazo (em dias) para o solicitante reabrir um chamado finalizado.
const REABRIR_DIAS = 7;
// Quantas vezes a avaliação de um chamado pode ser gravada (1 nota + correções).
const AVALIACOES_MAX = 3;

// ---------------------------------------------------------------------------
// Notificações. Sem `para`, o aviso é da equipe de TI (sino da TI e
// notificador de bandeja). Com `para: {id}`, é pessoal — aparece só no sino
// daquele usuário (ex.: solicitante sabendo que o status do chamado mudou).
// ---------------------------------------------------------------------------
const NOTIF_MAX = 2000; // agora há avisos pessoais além dos da equipe
function criarNotificacao(tipo, chamado, titulo, mensagem, para) {
  const n = {
    id: d.novoIdNotificacao(),
    em: d.agora(),
    tipo, // 'novo_chamado' | 'status' | 'comentario' | 'reaberto'
    chamadoId: chamado.id,
    titulo,
    mensagem,
    para: para ? { id: para.id } : null,
    dados: {
      chamadoId: chamado.id,
      solicitante: chamado.solicitante.nome,
      tituloChamado: chamado.titulo,
      prioridade: PRIO_LABEL[chamado.prioridade] || chamado.prioridade,
      urgente: !!chamado.urgente,
      status: STATUS_LABEL[chamado.status] || chamado.status,
    },
    reconhecidaPor: null,
  };
  d.db.notificacoes.push(n);
  /*
   * Poda pelo teto. O que já foi lido sai primeiro; aviso PENDENTE só é
   * descartado se, sozinho, ele já estourar o limite — e aí sai o mais antigo.
   * A ordem importa: cortar por posição (como antes) deixava qualquer usuário
   * empurrar para fora um alerta urgente que a TI ainda não tinha visto.
   */
  if (d.db.notificacoes.length > NOTIF_MAX) {
    const pendentes = d.db.notificacoes.filter((x) => !x.reconhecidaPor);
    const lidas = d.db.notificacoes.filter((x) => x.reconhecidaPor);
    const sobra = Math.max(0, NOTIF_MAX - pendentes.length);
    d.db.notificacoes = lidas.slice(-sobra)
      .concat(pendentes.slice(-NOTIF_MAX))
      .sort((a, b) => (a.em < b.em ? -1 : 1));
  }
  avisarNovaNotificacao();
  return n;
}

// Aviso pessoal ao solicitante do chamado (sino + e-mail/webhook, se ligados).
// Nunca avisa quem causou o evento sobre a própria ação.
function avisarSolicitante(chamado, autor, tipo, titulo, mensagem) {
  const dono = d.db.usuarios.find((u) => u.id === chamado.solicitante.id);
  if (!dono || (autor && dono.id === autor.id)) return;
  criarNotificacao(tipo, chamado, titulo, mensagem, dono);
  notificar.avisar(dono, tipo, titulo, mensagem, chamado.id);
}

// A notificação é visível para este usuário? Aviso da equipe: quem atende
// (admin, TI e os logins autorizados). Aviso pessoal: só o destinatário.
function notificacaoVisivel(n, u) {
  if (n.para) return n.para.id === u.id;
  return podeAtenderChamado(u);
}

function reconhecerNotificacoesDoChamado(chamadoId, usuario, tipos) {
  for (const n of d.db.notificacoes) {
    // Só os avisos da equipe: os pessoais são lidos pelo próprio destinatário.
    if (n.para) continue;
    if (n.chamadoId === chamadoId && !n.reconhecidaPor && (!tipos || tipos.includes(n.tipo))) {
      n.reconhecidaPor = { id: usuario ? usuario.id : 'sistema', nome: usuario ? usuario.nome : 'sistema', em: d.agora() };
    }
  }
}

// ---------------------------------------------------------------------------
// Proteção simples contra força bruta no login (por IP).
// ---------------------------------------------------------------------------
const tentativas = new Map();
function loginBloqueado(ip) {
  const t = tentativas.get(ip);
  return !!(t && t.bloqueadoAte && t.bloqueadoAte > Date.now());
}
function registrarFalhaLogin(ip) {
  const t = tentativas.get(ip) || { falhas: 0, bloqueadoAte: 0 };
  t.falhas += 1;
  if (t.falhas >= 5) { t.bloqueadoAte = Date.now() + 60 * 1000; t.falhas = 0; }
  tentativas.set(ip, t);
}
function limparFalhasLogin(ip) { tentativas.delete(ip); }

// ---------------------------------------------------------------------------
// Rotas da API.
// ---------------------------------------------------------------------------
const rotas = [];
function rota(metodo, padrao, papeis, handler) {
  const keys = [];
  const re = new RegExp('^' + padrao.replace(/:[a-zA-Z]+/g, (m) => { keys.push(m.slice(1)); return '([^/]+)'; }) + '$');
  rotas.push({ metodo, re, keys, papeis, handler });
}

// ---- autenticação ----------------------------------------------------------
rota('POST', '/api/auth/login', ['anon'], (ctx) => {
  if (loginBloqueado(ctx.ip)) return erro(ctx.res, 429, 'Muitas tentativas. Aguarde 1 minuto.');
  const login = txt(ctx.body.login, 60).toLowerCase();
  const senha = String(ctx.body.senha || '');
  const u = d.db.usuarios.find((x) => x.login === login);
  if (!u || d.hashSenha(senha, u.sal) !== u.senhaHash) {
    registrarFalhaLogin(ctx.ip);
    return erro(ctx.res, 401, 'Login ou senha inválidos.');
  }
  limparFalhasLogin(ctx.ip);
  const token = d.criarSessao(u);
  sendJson(ctx.res, 200, { token, usuario: publicoUsuario(u) });
});

rota('POST', '/api/auth/logout', null, (ctx) => {
  d.encerrarSessao(ctx.token);
  sendJson(ctx.res, 200, { ok: true });
});

rota('GET', '/api/me', null, (ctx) => {
  sendJson(ctx.res, 200, { usuario: publicoUsuario(ctx.usuario) });
});

rota('POST', '/api/auth/trocar-senha', null, (ctx) => {
  const atual = String(ctx.body.senhaAtual || '');
  const nova = String(ctx.body.novaSenha || '');
  if (d.hashSenha(atual, ctx.usuario.sal) !== ctx.usuario.senhaHash) return erro(ctx.res, 400, 'Senha atual incorreta.');
  if (nova.length < 6) return erro(ctx.res, 400, 'A nova senha precisa ter ao menos 6 caracteres.');
  ctx.usuario.sal = d.novoSal();
  ctx.usuario.senhaHash = d.hashSenha(nova, ctx.usuario.sal);
  d.flush();
  sendJson(ctx.res, 200, { ok: true });
});

// ---- usuários (admin) ------------------------------------------------------
rota('GET', '/api/usuarios', ['admin'], (ctx) => {
  sendJson(ctx.res, 200, { usuarios: d.db.usuarios.map(publicoUsuario) });
});

rota('POST', '/api/usuarios', ['admin'], (ctx) => {
  const nome = txt(ctx.body.nome, 80);
  const login = txt(ctx.body.login, 60).toLowerCase();
  const senha = String(ctx.body.senha || '');
  const papel = String(ctx.body.papel || '');
  if (!nome || !login) return erro(ctx.res, 400, 'Informe nome e login.');
  if (!/^[a-z0-9.@_-]+$/.test(login)) return erro(ctx.res, 400, 'Login: use apenas letras, números, ponto, hífen ou e-mail.');
  if (senha.length < 6) return erro(ctx.res, 400, 'A senha precisa ter ao menos 6 caracteres.');
  if (!PAPEIS.includes(papel)) return erro(ctx.res, 400, 'Papel inválido.');
  if (d.db.usuarios.some((u) => u.login === login)) return erro(ctx.res, 409, 'Já existe um usuário com esse login.');
  const email = txt(ctx.body.email, 120).toLowerCase();
  if (email && !emailValido(email)) return erro(ctx.res, 400, 'E-mail inválido.');
  const u = d.criarUsuarioObj(nome, login, senha, papel);
  u.lider = !!ctx.body.lider;
  u.email = email || null;
  u.celular = txt(ctx.body.celular, 25) || null;
  d.db.usuarios.push(u);
  d.flush();
  notifyChange('usuarios');
  sendJson(ctx.res, 200, { usuario: publicoUsuario(u) });
});

rota('PUT', '/api/usuarios/:id', ['admin'], (ctx) => {
  const u = d.db.usuarios.find((x) => x.id === ctx.params.id);
  if (!u) return erro(ctx.res, 404, 'Usuário não encontrado.');
  if (ctx.body.nome !== undefined) u.nome = txt(ctx.body.nome, 80) || u.nome;
  if (ctx.body.papel !== undefined) {
    if (!PAPEIS.includes(ctx.body.papel)) return erro(ctx.res, 400, 'Papel inválido.');
    if (u.papel === 'admin' && ctx.body.papel !== 'admin' &&
        d.db.usuarios.filter((x) => x.papel === 'admin').length <= 1) {
      return erro(ctx.res, 400, 'Não é possível rebaixar o único admin.');
    }
    u.papel = ctx.body.papel;
  }
  if (ctx.body.novaSenha) {
    if (String(ctx.body.novaSenha).length < 6) return erro(ctx.res, 400, 'A senha precisa ter ao menos 6 caracteres.');
    u.sal = d.novoSal();
    u.senhaHash = d.hashSenha(String(ctx.body.novaSenha), u.sal);
  }
  if (ctx.body.lider !== undefined) u.lider = !!ctx.body.lider;
  if (ctx.body.email !== undefined) {
    const email = txt(ctx.body.email, 120).toLowerCase();
    if (email && !emailValido(email)) return erro(ctx.res, 400, 'E-mail inválido.');
    u.email = email || null;
  }
  if (ctx.body.celular !== undefined) u.celular = txt(ctx.body.celular, 25) || null;
  d.flush();
  notifyChange('usuarios');
  sendJson(ctx.res, 200, { usuario: publicoUsuario(u) });
});

// Cada um edita os próprios contatos (para receber os avisos).
rota('PUT', '/api/me/contato', null, (ctx) => {
  if (ctx.body.email !== undefined) {
    const email = txt(ctx.body.email, 120).toLowerCase();
    if (email && !emailValido(email)) return erro(ctx.res, 400, 'E-mail inválido.');
    ctx.usuario.email = email || null;
  }
  if (ctx.body.celular !== undefined) ctx.usuario.celular = txt(ctx.body.celular, 25) || null;
  d.flush();
  sendJson(ctx.res, 200, { usuario: publicoUsuario(ctx.usuario) });
});

rota('DELETE', '/api/usuarios/:id', ['admin'], (ctx) => {
  const u = d.db.usuarios.find((x) => x.id === ctx.params.id);
  if (!u) return erro(ctx.res, 404, 'Usuário não encontrado.');
  if (u.id === ctx.usuario.id) return erro(ctx.res, 400, 'Você não pode remover a si mesmo.');
  if (u.papel === 'admin' && d.db.usuarios.filter((x) => x.papel === 'admin').length <= 1) {
    return erro(ctx.res, 400, 'Não é possível remover o único admin.');
  }
  d.db.usuarios = d.db.usuarios.filter((x) => x.id !== u.id);
  d.db.sessoes = d.db.sessoes.filter((s) => s.usuarioId !== u.id);
  d.flush();
  notifyChange('usuarios');
  sendJson(ctx.res, 200, { ok: true });
});

// ---- chamados ---------------------------------------------------------------
rota('GET', '/api/chamados', null, (ctx) => {
  // Todos os usuários veem a lista completa (transparência da fila de TI).
  const lista = d.db.chamados.slice().sort((a, b) => (a.criadoEm < b.criadoEm ? 1 : -1));
  sendJson(ctx.res, 200, { chamados: lista });
});

rota('POST', '/api/chamados', null, (ctx) => {
  const titulo = txt(ctx.body.titulo, 140);
  const descricao = txt(ctx.body.descricao, 4000);
  const categoria = CATEGORIAS.includes(ctx.body.categoria) ? ctx.body.categoria : 'outro';
  const prioridade = PRIORIDADES.includes(ctx.body.prioridade) ? ctx.body.prioridade : 'media';
  const urgente = !!ctx.body.urgente;
  if (!titulo) return erro(ctx.res, 400, 'Informe o título do chamado.');

  const chamado = novoChamadoObj(ctx.usuario, { titulo, descricao, categoria, prioridade, urgente });
  // Fotos da abertura: conferidas antes de gravar o chamado, para uma imagem
  // ruim não deixar chamado pela metade nem arquivo solto em disco.
  const conf = conferirAnexos(chamado, ctx.body.anexos);
  if (conf.erro) return erro(ctx.res, 400, conf.erro);
  historico(chamado, ctx.usuario, 'Chamado aberto.',
    'Prioridade ' + PRIO_LABEL[prioridade] + (urgente ? ' · URGENTE' : ''));
  gravarAnexos(chamado, ctx.usuario, conf.imagens, null);
  d.db.chamados.push(chamado);
  // Notifica a TI apenas quando quem abriu NÃO atende (a própria TI e os
  // atendentes não precisam de aviso sobre o que eles mesmos registram).
  if (!podeAtenderChamado(ctx.usuario)) {
    criarNotificacao(
      'novo_chamado', chamado,
      'Novo chamado ' + chamado.id + (urgente ? ' (URGENTE)' : ''),
      ctx.usuario.nome + ': ' + titulo +
        ' · Prioridade ' + PRIO_LABEL[prioridade] +
        (descricao ? ' — ' + descricao.slice(0, 120) : '')
    );
  }
  d.flush();
  notifyChange('chamados');
  sendJson(ctx.res, 200, { chamado });
});

rota('GET', '/api/chamados/:id', null, (ctx) => {
  const chamado = acharChamado(ctx.params.id);
  if (!chamado) return erro(ctx.res, 404, 'Chamado não encontrado.');
  sendJson(ctx.res, 200, { chamado });
});

rota('PUT', '/api/chamados/:id', null, (ctx) => {
  const chamado = acharChamado(ctx.params.id);
  if (!chamado) return erro(ctx.res, 404, 'Chamado não encontrado.');
  const b = ctx.body;
  // Estado do chamado (status/prioridade/urgencia/responsavel/categoria) so
  // pode ser mexido por quem atende (admin, TI/claude, junior). Qualquer outro
  // usuario que tente alterar esses campos leva 403 — mesmo no proprio chamado.
  const CAMPOS_ESTADO = ['status', 'prioridade', 'urgente', 'responsavel', 'categoria'];
  const tentaEstado = CAMPOS_ESTADO.some((k) => b[k] !== undefined);
  if (tentaEstado && !podeAtenderChamado(ctx.usuario)) {
    return erro(ctx.res, 403,
      'Apenas a TI (admin, Claude ou Junior) pode alterar o estado dos chamados.');
  }
  // Texto (titulo/descricao): quem atende edita qualquer um; os demais so o
  // proprio chamado.
  const podeEditarTexto = podeAtenderChamado(ctx.usuario)
    || chamado.solicitante.id === ctx.usuario.id;
  let mudou = false;

  if (b.status !== undefined && b.status !== chamado.status) {
    if (!STATUS.includes(b.status)) return erro(ctx.res, 400, 'Status inválido.');
    const de = chamado.status;
    chamado.status = b.status;
    chamado.finalizadoEm = b.status === 'finalizado' ? d.agora() : null;
    if (b.status === 'em_andamento' && !chamado.responsavel) chamado.responsavel = ctx.usuario.nome;
    historico(chamado, ctx.usuario, 'Status alterado.', STATUS_LABEL[de] + ' → ' + STATUS_LABEL[b.status]);
    if (!podeAtenderChamado(ctx.usuario)) {
      criarNotificacao('status', chamado,
        'Status alterado — ' + chamado.id,
        ctx.usuario.nome + ' mudou o status para ' + STATUS_LABEL[b.status] + ' · ' + chamado.titulo);
    }
    if (b.status === 'finalizado') reconhecerNotificacoesDoChamado(chamado.id, ctx.usuario, null);
    // O solicitante fica sabendo (sino; e-mail/webhook se ligados).
    avisarSolicitante(chamado, ctx.usuario, 'status',
      chamado.id + ' — ' + STATUS_LABEL[b.status],
      'Seu chamado "' + chamado.titulo + '" mudou para ' + STATUS_LABEL[b.status] +
        (b.status === 'finalizado' ? '. Se o problema persistir, você pode reabri-lo em até ' + REABRIR_DIAS + ' dias. Avalie o atendimento na tela do chamado.' : '.'));
    mudou = true;
  }
  if (b.prioridade !== undefined && b.prioridade !== chamado.prioridade) {
    if (!PRIORIDADES.includes(b.prioridade)) return erro(ctx.res, 400, 'Prioridade inválida.');
    historico(chamado, ctx.usuario, 'Prioridade alterada.', PRIO_LABEL[chamado.prioridade] + ' → ' + PRIO_LABEL[b.prioridade]);
    chamado.prioridade = b.prioridade;
    chamado.prazoSla = prazoSla(chamado);
    mudou = true;
  }
  if (b.urgente !== undefined && !!b.urgente !== chamado.urgente) {
    chamado.urgente = !!b.urgente;
    historico(chamado, ctx.usuario, chamado.urgente ? 'Marcado como URGENTE.' : 'Urgência removida.');
    chamado.prazoSla = prazoSla(chamado);
    mudou = true;
  }
  if (b.responsavel !== undefined) {
    const r = txt(b.responsavel, 80) || null;
    if (r !== chamado.responsavel) {
      historico(chamado, ctx.usuario, 'Responsável definido.', r || '(ninguém)');
      chamado.responsavel = r;
      // O vínculo por id vale para o nome antigo: limpa (quem quiser o id usa
      // POST /atribuir, que grava os dois campos juntos).
      const porNome = r ? d.db.usuarios.find((u) => u.nome === r && podeAtenderChamado(u)) : null;
      chamado.responsavelId = porNome ? porNome.id : null;
      mudou = true;
    }
  }
  if (b.titulo !== undefined && podeEditarTexto) {
    const t = txt(b.titulo, 140);
    if (t && t !== chamado.titulo) { historico(chamado, ctx.usuario, 'Título editado.', null); chamado.titulo = t; mudou = true; }
  }
  if (b.descricao !== undefined && podeEditarTexto) {
    const t = txt(b.descricao, 4000);
    if (t !== chamado.descricao) { historico(chamado, ctx.usuario, 'Descrição editada.', null); chamado.descricao = t; mudou = true; }
  }
  if (b.categoria !== undefined && CATEGORIAS.includes(b.categoria) && b.categoria !== chamado.categoria) {
    historico(chamado, ctx.usuario, 'Categoria alterada.', chamado.categoria + ' → ' + b.categoria);
    chamado.categoria = b.categoria;
    mudou = true;
  }

  if (mudou) { d.flush(); notifyChange('chamados'); }
  sendJson(ctx.res, 200, { chamado });
});

rota('DELETE', '/api/chamados/:id', ['admin'], (ctx) => {
  const chamado = acharChamado(ctx.params.id);
  if (!chamado) return erro(ctx.res, 404, 'Chamado não encontrado.');
  d.db.chamados = d.db.chamados.filter((c) => c.id !== chamado.id);
  d.db.notificacoes = d.db.notificacoes.filter((n) => n.chamadoId !== chamado.id);
  d.flush();
  notifyChange('chamados');
  sendJson(ctx.res, 200, { ok: true });
});

// ---- comentários (observações dos colaboradores) ----------------------------
rota('POST', '/api/chamados/:id/comentarios', null, (ctx) => {
  const chamado = acharChamado(ctx.params.id);
  if (!chamado) return erro(ctx.res, 404, 'Chamado não encontrado.');
  const texto = txt(ctx.body.texto, 2000);
  if (!texto) return erro(ctx.res, 400, 'Escreva a observação.');
  // Confere as fotos ANTES de gravar o comentário: uma imagem recusada não
  // pode deixar a observação registrada com um erro 400 na tela do usuário.
  const conf = conferirAnexos(chamado, ctx.body.anexos);
  if (conf.erro) return erro(ctx.res, 400, conf.erro);
  const comentario = {
    id: d.novoIdComentario(),
    em: d.agora(),
    por: { id: ctx.usuario.id, nome: ctx.usuario.nome, papel: ctx.usuario.papel },
    texto,
  };
  chamado.comentarios.push(comentario);
  historico(chamado, ctx.usuario, 'Observação adicionada.', texto.slice(0, 120));
  gravarAnexos(chamado, ctx.usuario, conf.imagens, comentario.id);
  if (!podeAtenderChamado(ctx.usuario)) {
    criarNotificacao('comentario', chamado,
      'Nova observação — ' + chamado.id,
      ctx.usuario.nome + ': ' + texto.slice(0, 140) + ' · ' + chamado.titulo);
  }
  // Observação da TI avisa o solicitante (e vice-versa já cai na regra acima).
  avisarSolicitante(chamado, ctx.usuario, 'comentario',
    chamado.id + ' — nova observação',
    ctx.usuario.nome + ' escreveu no seu chamado "' + chamado.titulo + '": ' + texto.slice(0, 400));
  d.flush();
  notifyChange('chamados');
  sendJson(ctx.res, 200, { comentario, chamado });
});

// ---- anexos (fotos do problema) ---------------------------------------------
// Guardados em ti-data/anexos (fora da pasta estática) e servidos por rota
// autenticada, igual à foto da devolução de Home Office.
const ANEXOS_DIR = path.join(d.DATA_DIR, 'anexos');
fs.mkdirSync(ANEXOS_DIR, { recursive: true });
const ANEXOS_MAX = 5;          // por envio
const ANEXOS_TOTAL = 20;       // por chamado
const ANEXO_BYTES = 6 * 1024 * 1024;
const IMG_MIME = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp' };

/*
 * Confere a lista inteira ANTES de gravar qualquer coisa: assim uma imagem
 * ruim no meio do lote não deixa comentário meio-gravado nem arquivo órfão em
 * disco. Devolve { erro } ou { imagens: [{buf, ext}] }.
 */
function conferirAnexos(chamado, lista) {
  const imagens = [];
  const jaTem = Array.isArray(chamado.anexos) ? chamado.anexos.length : 0;
  if (!Array.isArray(lista) || !lista.length) return { imagens };
  if (lista.length > ANEXOS_MAX) return { erro: 'Envie no máximo ' + ANEXOS_MAX + ' imagens por vez.' };
  if (jaTem + lista.length > ANEXOS_TOTAL) {
    return { erro: 'Este chamado chegou ao limite de ' + ANEXOS_TOTAL + ' anexos.' };
  }
  for (const dataUrl of lista) {
    const m = /^data:image\/(png|jpe?g|webp);base64,([A-Za-z0-9+/=]+)$/.exec(String(dataUrl || ''));
    if (!m) return { erro: 'Anexo inválido: envie uma imagem (JPG, PNG ou WebP).' };
    const buf = Buffer.from(m[2], 'base64');
    if (!buf.length || buf.length > ANEXO_BYTES) return { erro: 'Cada imagem deve ter até 6 MB.' };
    imagens.push({ buf, ext: m[1] === 'png' ? 'png' : m[1] === 'webp' ? 'webp' : 'jpg' });
  }
  return { imagens };
}

// Grava no disco o que conferirAnexos já aprovou e anexa ao chamado.
function gravarAnexos(chamado, usuario, imagens, comentarioId) {
  if (!Array.isArray(chamado.anexos)) chamado.anexos = [];
  const salvos = [];
  for (const img of imagens) {
    const id = d.novoIdAnexo();
    const arquivo = chamado.id + '-' + id + '.' + img.ext;
    fs.writeFileSync(path.join(ANEXOS_DIR, arquivo), img.buf);
    const anexo = {
      id,
      arquivo,
      em: d.agora(),
      por: { id: usuario.id, nome: usuario.nome },
      comentarioId: comentarioId || null,
      bytes: img.buf.length,
    };
    chamado.anexos.push(anexo);
    salvos.push(anexo);
  }
  return salvos;
}

rota('POST', '/api/chamados/:id/anexos', null, (ctx) => {
  const chamado = acharChamado(ctx.params.id);
  if (!chamado) return erro(ctx.res, 404, 'Chamado não encontrado.');
  const lista = Array.isArray(ctx.body.anexos) ? ctx.body.anexos : [ctx.body.imagem].filter(Boolean);
  if (!lista.length) return erro(ctx.res, 400, 'Nenhuma imagem enviada.');
  const conf = conferirAnexos(chamado, lista);
  if (conf.erro) return erro(ctx.res, 400, conf.erro);
  const salvos = gravarAnexos(chamado, ctx.usuario, conf.imagens, txt(ctx.body.comentarioId, 20) || null);
  historico(chamado, ctx.usuario, salvos.length === 1 ? 'Anexo adicionado.' : salvos.length + ' anexos adicionados.', null);
  d.flush();
  notifyChange('chamados');
  sendJson(ctx.res, 200, { anexos: salvos, chamado });
});

// Qualquer usuário autenticado baixa o anexo — a mesma regra do chamado, que
// é público para todos (GET /api/chamados devolve a fila inteira, com as
// descrições). O anexo é parte do chamado; restringir só a foto daria uma
// falsa sensação de sigilo. Sem sessão válida, 401 no despacho.
rota('GET', '/api/chamados/:id/anexos/:anexoId', null, (ctx) => {
  const chamado = acharChamado(ctx.params.id);
  if (!chamado) return erro(ctx.res, 404, 'Chamado não encontrado.');
  const anexo = (chamado.anexos || []).find((a) => a.id === ctx.params.anexoId);
  if (!anexo) return erro(ctx.res, 404, 'Anexo não encontrado.');
  const arquivo = path.basename(anexo.arquivo);
  fs.readFile(path.join(ANEXOS_DIR, arquivo), (err, dados) => {
    if (err) return erro(ctx.res, 404, 'Arquivo não encontrado no servidor.');
    const ext = path.extname(arquivo).slice(1).toLowerCase();
    send(ctx.res, 200, dados, { 'Content-Type': IMG_MIME[ext] || 'application/octet-stream' });
  });
});

rota('DELETE', '/api/chamados/:id/anexos/:anexoId', null, (ctx) => {
  const chamado = acharChamado(ctx.params.id);
  if (!chamado) return erro(ctx.res, 404, 'Chamado não encontrado.');
  const anexo = (chamado.anexos || []).find((a) => a.id === ctx.params.anexoId);
  if (!anexo) return erro(ctx.res, 404, 'Anexo não encontrado.');
  // Quem anexou pode remover; a TI e o admin também.
  if (anexo.por.id !== ctx.usuario.id && !podeAtenderChamado(ctx.usuario)) {
    return erro(ctx.res, 403, 'Só quem anexou (ou a TI) pode remover o anexo.');
  }
  try { fs.unlinkSync(path.join(ANEXOS_DIR, path.basename(anexo.arquivo))); } catch (e) { /* ignore */ }
  chamado.anexos = chamado.anexos.filter((a) => a.id !== anexo.id);
  historico(chamado, ctx.usuario, 'Anexo removido.', null);
  d.flush();
  notifyChange('chamados');
  sendJson(ctx.res, 200, { ok: true, chamado });
});

// ---- avaliação do atendimento ------------------------------------------------
// Só o solicitante avalia, e só depois de finalizado. Pode reavaliar enquanto
// o chamado seguir finalizado — o histórico guarda cada nota.
rota('POST', '/api/chamados/:id/avaliacao', null, (ctx) => {
  const chamado = acharChamado(ctx.params.id);
  if (!chamado) return erro(ctx.res, 404, 'Chamado não encontrado.');
  if (chamado.solicitante.id !== ctx.usuario.id) return erro(ctx.res, 403, 'Só quem abriu o chamado avalia o atendimento.');
  if (chamado.status !== 'finalizado') return erro(ctx.res, 400, 'A avaliação fica disponível quando o chamado é finalizado.');
  const nota = parseInt(ctx.body.nota, 10);
  if (!(nota >= 1 && nota <= 5)) return erro(ctx.res, 400, 'Dê uma nota de 1 a 5 estrelas.');
  const comentario = txt(ctx.body.comentario, 500);
  const antes = chamado.avaliacao;
  // Reenviar a MESMA avaliação (duplo clique, recarregar a tela) não muda nada.
  if (antes && antes.nota === nota && (antes.comentario || '') === comentario) {
    return sendJson(ctx.res, 200, { chamado });
  }
  // Corrigir é permitido, mas com teto: sem ele, um laço de reavaliações
  // encheria o histórico e a fila de avisos da TI (cada envio grava a base).
  chamado.avaliacoesFeitas = (chamado.avaliacoesFeitas || 0) + 1;
  if (chamado.avaliacoesFeitas > AVALIACOES_MAX) {
    chamado.avaliacoesFeitas = AVALIACOES_MAX;
    return erro(ctx.res, 400, 'Você já corrigiu esta avaliação o máximo de vezes. Fale com a TI pelas observações.');
  }
  chamado.avaliacao = { nota, comentario: comentario || null, em: d.agora(), por: { id: ctx.usuario.id, nome: ctx.usuario.nome } };
  historico(chamado, ctx.usuario, antes ? 'Avaliação corrigida.' : 'Atendimento avaliado.',
    (antes ? antes.nota + '/5 → ' : '') + nota + '/5' + (comentario ? ' — ' + comentario.slice(0, 100) : ''));
  // Só a PRIMEIRA avaliação vira aviso na fila da TI; correções ficam no
  // histórico do chamado, que é onde a TI vai olhar de todo jeito.
  if (!antes) {
    criarNotificacao('avaliacao', chamado,
      'Avaliação ' + nota + '/5 — ' + chamado.id,
      ctx.usuario.nome + ' avaliou o atendimento com ' + nota + ' de 5' + (comentario ? ': ' + comentario.slice(0, 140) : '') + ' · ' + chamado.titulo);
  }
  d.flush();
  notifyChange('chamados');
  sendJson(ctx.res, 200, { chamado });
});

// ---- reabertura controlada ---------------------------------------------------
// O solicitante reabre em até REABRIR_DIAS dias após a finalização, mantendo
// todo o histórico. A TI reabre a qualquer momento (é ela quem manda no estado).
rota('POST', '/api/chamados/:id/reabrir', null, (ctx) => {
  const chamado = acharChamado(ctx.params.id);
  if (!chamado) return erro(ctx.res, 404, 'Chamado não encontrado.');
  if (chamado.status !== 'finalizado') return erro(ctx.res, 400, 'Este chamado não está finalizado.');
  const dono = chamado.solicitante.id === ctx.usuario.id;
  const atende = podeAtenderChamado(ctx.usuario);
  if (!dono && !atende) return erro(ctx.res, 403, 'Só quem abriu o chamado (ou a TI) pode reabri-lo.');
  if (dono && !atende) {
    const dias = (Date.now() - Date.parse(chamado.finalizadoEm || chamado.atualizadoEm)) / 86400000;
    if (dias > REABRIR_DIAS) {
      return erro(ctx.res, 400, 'O prazo de ' + REABRIR_DIAS + ' dias para reabrir passou. Abra um novo chamado.');
    }
  }
  const motivo = txt(ctx.body.motivo, 1000);
  if (!motivo) return erro(ctx.res, 400, 'Diga o que continua acontecendo para a TI entender.');
  chamado.status = 'pendente';
  chamado.finalizadoEm = null;
  chamado.reabertoEm = d.agora();
  chamado.reaberturas = (chamado.reaberturas || 0) + 1;
  // Prazo novo a partir da REABERTURA: senão o chamado volta para a fila já
  // vencido (o prazo original contava da abertura, semanas atrás).
  chamado.prazoSla = new Date(Date.parse(chamado.reabertoEm) + slaHoras(chamado) * 3600 * 1000).toISOString();
  chamado.comentarios.push({
    id: d.novoIdComentario(),
    em: d.agora(),
    por: { id: ctx.usuario.id, nome: ctx.usuario.nome, papel: ctx.usuario.papel },
    texto: 'Chamado reaberto: ' + motivo,
  });
  historico(chamado, ctx.usuario, 'Chamado reaberto.', motivo.slice(0, 120));
  criarNotificacao('reaberto', chamado,
    'Chamado reaberto — ' + chamado.id,
    ctx.usuario.nome + ' reabriu: ' + motivo.slice(0, 140) + ' · ' + chamado.titulo);
  avisarSolicitante(chamado, ctx.usuario, 'reaberto',
    chamado.id + ' — reaberto',
    'Seu chamado "' + chamado.titulo + '" foi reaberto por ' + ctx.usuario.nome + ': ' + motivo.slice(0, 300));
  d.flush();
  notifyChange('chamados');
  sendJson(ctx.res, 200, { chamado });
});

// ---- atribuição de responsável ----------------------------------------------
// "Assumir" (sem corpo) ou atribuir a um usuário que atende (responsavelId).
rota('POST', '/api/chamados/:id/atribuir', null, (ctx) => {
  const chamado = acharChamado(ctx.params.id);
  if (!chamado) return erro(ctx.res, 404, 'Chamado não encontrado.');
  if (!podeAtenderChamado(ctx.usuario)) return erro(ctx.res, 403, 'Apenas a TI atribui responsável.');
  let alvo = ctx.usuario;
  if (ctx.body.responsavelId) {
    const u = d.db.usuarios.find((x) => x.id === ctx.body.responsavelId);
    if (!u) return erro(ctx.res, 404, 'Usuário não encontrado.');
    if (!podeAtenderChamado(u)) return erro(ctx.res, 400, 'Esse usuário não faz atendimento.');
    alvo = u;
  } else if (ctx.body.responsavelId === null) {
    // Liberar o chamado (voltar para a fila sem dono).
    if (chamado.responsavel) historico(chamado, ctx.usuario, 'Responsável removido.', chamado.responsavel);
    chamado.responsavel = null;
    chamado.responsavelId = null;
    d.flush();
    notifyChange('chamados');
    return sendJson(ctx.res, 200, { chamado });
  }
  chamado.responsavel = alvo.nome;
  chamado.responsavelId = alvo.id;
  if (chamado.status === 'pendente') {
    chamado.status = 'em_andamento';
    historico(chamado, ctx.usuario, 'Status alterado.', 'Pendente → Em andamento');
  }
  historico(chamado, ctx.usuario, 'Responsável definido.', alvo.nome);
  avisarSolicitante(chamado, ctx.usuario, 'status',
    chamado.id + ' — em atendimento',
    'Seu chamado "' + chamado.titulo + '" está sendo atendido por ' + alvo.nome + '.');
  d.flush();
  notifyChange('chamados');
  sendJson(ctx.res, 200, { chamado });
});

// Quem pode receber atribuição (para o seletor da tela).
rota('GET', '/api/atendentes', null, (ctx) => {
  const lista = d.db.usuarios.filter(podeAtenderChamado)
    .map((u) => ({ id: u.id, nome: u.nome }))
    .sort((a, b) => a.nome.localeCompare(b.nome, 'pt-BR'));
  sendJson(ctx.res, 200, { atendentes: lista });
});

// ---- indicadores / relatórios ------------------------------------------------
// Números do período (padrão: 30 dias) para o painel do gestor. Aberto a
// qualquer usuário autenticado — a fila já é pública para todos.
rota('GET', '/api/relatorios', null, (ctx) => {
  const dias = Math.min(Math.max(parseInt(ctx.query.get('dias'), 10) || 30, 1), 365);
  // Período = os N dias do calendário local terminando hoje. Começar num
  // instante "agora - N dias" faria o KPI contar um pedaço de um dia a mais do
  // que o gráfico mostra, e os dois números nunca fechariam.
  const inicio = new Date();
  inicio.setHours(0, 0, 0, 0);
  inicio.setDate(inicio.getDate() - (dias - 1));
  const desde = inicio.getTime();
  const noPeriodo = d.db.chamados.filter((c) => Date.parse(c.criadoEm) >= desde);
  // "Finalizados no período" conta pela data de FECHAMENTO — é o trabalho que
  // a TI entregou nesses dias. Contar pela abertura esconderia justamente os
  // chamados antigos que demoraram (e que puxam o tempo médio para cima).
  const finalizados = d.db.chamados.filter((c) =>
    c.status === 'finalizado' && c.finalizadoEm && Date.parse(c.finalizadoEm) >= desde);

  const somaHoras = finalizados.reduce((s, c) => s + (Date.parse(c.finalizadoEm) - Date.parse(c.criadoEm)) / 3600000, 0);
  const comSla = finalizados.filter((c) => dentroDoSla(c) !== null);
  const dentro = comSla.filter((c) => dentroDoSla(c) === true).length;
  const avaliados = noPeriodo.filter((c) => c.avaliacao && c.avaliacao.nota);
  const somaNotas = avaliados.reduce((s, c) => s + c.avaliacao.nota, 0);

  const contar = (chave) => {
    const mapa = {};
    for (const c of noPeriodo) {
      const k = typeof chave === 'function' ? chave(c) : c[chave];
      if (k == null) continue;
      mapa[k] = (mapa[k] || 0) + 1;
    }
    return mapa;
  };
  // Série por dia (aberturas x finalizações), do mais antigo ao mais recente.
  // O dia é o LOCAL do servidor (-03:00): fatiar o ISO em UTC jogaria tudo o
  // que foi aberto depois das 21h para o dia seguinte.
  const porDia = {};
  const diaDe = (iso) => {
    const dt = new Date(iso);
    const p = (n) => String(n).padStart(2, '0');
    return dt.getFullYear() + '-' + p(dt.getMonth() + 1) + '-' + p(dt.getDate());
  };
  for (let i = 0; i < dias; i++) {
    const dt = new Date(inicio);
    dt.setDate(inicio.getDate() + i);
    porDia[diaDe(dt)] = { abertos: 0, finalizados: 0 };
  }
  for (const c of noPeriodo) {
    const k = diaDe(c.criadoEm);
    if (porDia[k]) porDia[k].abertos += 1;
  }
  for (const c of d.db.chamados) {
    if (!c.finalizadoEm || Date.parse(c.finalizadoEm) < desde) continue;
    const k = diaDe(c.finalizadoEm);
    if (porDia[k]) porDia[k].finalizados += 1;
  }

  // Carga por atendente (quem está com chamado aberto na mão hoje).
  const abertosAgora = d.db.chamados.filter((c) => c.status !== 'finalizado');
  const porResponsavel = {};
  for (const c of abertosAgora) {
    const k = c.responsavel || '— sem responsável';
    porResponsavel[k] = (porResponsavel[k] || 0) + 1;
  }

  sendJson(ctx.res, 200, {
    periodoDias: dias,
    total: noPeriodo.length,          // abertos NO período (bate com o gráfico)
    abertos: noPeriodo.filter((c) => c.status !== 'finalizado').length,
    finalizados: finalizados.length,  // fechados no período
    urgentes: noPeriodo.filter((c) => c.urgente).length,
    reaberturas: noPeriodo.reduce((s, c) => s + (c.reaberturas || 0), 0),
    emAbertoTotal: abertosAgora.length,
    // Fora do prazo AGORA (chamados abertos que já passaram do SLA).
    atrasados: abertosAgora.filter((c) => c.prazoSla && Date.parse(c.prazoSla) < Date.now()).length,
    tempoMedioHoras: finalizados.length ? Number((somaHoras / finalizados.length).toFixed(1)) : null,
    slaPercentual: comSla.length ? Math.round((dentro / comSla.length) * 100) : null,
    slaAvaliados: comSla.length,
    notaMedia: avaliados.length ? Number((somaNotas / avaliados.length).toFixed(1)) : null,
    avaliacoes: avaliados.length,
    porCategoria: contar('categoria'),
    porPrioridade: contar('prioridade'),
    porStatus: contar('status'),
    porResponsavel,
    porDia,
  });
});

// ---- base de conhecimento ----------------------------------------------------
// Artigos curtos que a TI escreve; a tela de novo chamado sugere os que casam
// com o título digitado, para o colaborador se resolver sem abrir chamado.
function publicoArtigo(a) { return a; }

rota('GET', '/api/artigos', null, (ctx) => {
  const busca = txt(ctx.query.get('busca'), 120).toLowerCase();
  let lista = d.db.artigos.slice();
  if (busca) {
    // Casamento por palavra: cada termo com 3+ letras vale 1 ponto no título,
    // meio ponto no corpo/etiquetas. Sem acento nem caixa.
    const norm = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
    let termos = norm(busca).split(/[^a-z0-9]+/).filter((t) => t.length >= 3);
    // Busca só com palavras curtas ("vpn" já entra acima, mas "ti" ou "erp?"
    // não): usa o texto inteiro como termo, em vez de devolver a base toda.
    if (!termos.length) termos = [norm(busca).replace(/[^a-z0-9]+/g, '')].filter(Boolean);
    if (termos.length) {
      lista = lista.map((a) => {
        const t = norm(a.titulo), c = norm(a.conteudo), e = norm((a.etiquetas || []).join(' '));
        let peso = 0;
        for (const termo of termos) {
          if (t.includes(termo)) peso += 1;
          if (e.includes(termo)) peso += 0.5;
          if (c.includes(termo)) peso += 0.5;
        }
        return { a, peso };
      }).filter((x) => x.peso > 0).sort((x, y) => y.peso - x.peso).map((x) => x.a);
    } else {
      lista = []; // busca só com pontuação: nada casa
    }
  }
  lista = lista.sort((a, b) => (busca ? 0 : (b.vistas || 0) - (a.vistas || 0)));
  sendJson(ctx.res, 200, { artigos: lista.slice(0, 30).map(publicoArtigo) });
});

rota('GET', '/api/artigos/:id', null, (ctx) => {
  const a = d.db.artigos.find((x) => x.id === ctx.params.id);
  if (!a) return erro(ctx.res, 404, 'Artigo não encontrado.');
  // Contador de leituras não justifica reescrever a base inteira a cada
  // abertura: soma em memória e o gravador preguiçoso persiste depois.
  a.vistas = (a.vistas || 0) + 1;
  agendarFlush();
  sendJson(ctx.res, 200, { artigo: publicoArtigo(a) });
});

rota('POST', '/api/artigos', null, (ctx) => {
  if (!podeAtenderChamado(ctx.usuario)) return erro(ctx.res, 403, 'Apenas a TI escreve artigos.');
  const titulo = txt(ctx.body.titulo, 140);
  const conteudo = txt(ctx.body.conteudo, 8000);
  if (!titulo || !conteudo) return erro(ctx.res, 400, 'Informe título e conteúdo do artigo.');
  const artigo = {
    id: d.novoIdArtigo(),
    titulo,
    conteudo,
    categoria: CATEGORIAS.includes(ctx.body.categoria) ? ctx.body.categoria : 'outro',
    etiquetas: String(ctx.body.etiquetas || '').split(',').map((t) => txt(t, 30)).filter(Boolean).slice(0, 10),
    criadoEm: d.agora(),
    atualizadoEm: d.agora(),
    por: { id: ctx.usuario.id, nome: ctx.usuario.nome },
    vistas: 0,
  };
  d.db.artigos.push(artigo);
  d.flush();
  notifyChange('artigos');
  sendJson(ctx.res, 200, { artigo });
});

rota('PUT', '/api/artigos/:id', null, (ctx) => {
  if (!podeAtenderChamado(ctx.usuario)) return erro(ctx.res, 403, 'Apenas a TI edita artigos.');
  const a = d.db.artigos.find((x) => x.id === ctx.params.id);
  if (!a) return erro(ctx.res, 404, 'Artigo não encontrado.');
  if (ctx.body.titulo !== undefined) a.titulo = txt(ctx.body.titulo, 140) || a.titulo;
  if (ctx.body.conteudo !== undefined) a.conteudo = txt(ctx.body.conteudo, 8000) || a.conteudo;
  if (ctx.body.categoria !== undefined && CATEGORIAS.includes(ctx.body.categoria)) a.categoria = ctx.body.categoria;
  if (ctx.body.etiquetas !== undefined) {
    a.etiquetas = String(ctx.body.etiquetas || '').split(',').map((t) => txt(t, 30)).filter(Boolean).slice(0, 10);
  }
  a.atualizadoEm = d.agora();
  d.flush();
  notifyChange('artigos');
  sendJson(ctx.res, 200, { artigo: a });
});

rota('DELETE', '/api/artigos/:id', null, (ctx) => {
  if (!podeAtenderChamado(ctx.usuario)) return erro(ctx.res, 403, 'Apenas a TI remove artigos.');
  const a = d.db.artigos.find((x) => x.id === ctx.params.id);
  if (!a) return erro(ctx.res, 404, 'Artigo não encontrado.');
  d.db.artigos = d.db.artigos.filter((x) => x.id !== a.id);
  d.flush();
  notifyChange('artigos');
  sendJson(ctx.res, 200, { ok: true });
});

// ---- histórico geral (detecção de mudanças feitas no site) ------------------
rota('GET', '/api/historico', null, (ctx) => {
  const desde = ctx.query.get('desde');
  const t = desde ? Date.parse(desde) : 0;
  const eventos = [];
  for (const c of d.db.chamados) {
    for (const h of c.historico) {
      if (t && Date.parse(h.em) <= t) continue;
      eventos.push({ chamadoId: c.id, titulo: c.titulo, status: c.status, em: h.em, por: h.por, acao: h.acao, detalhe: h.detalhe });
    }
  }
  eventos.sort((a, b) => (a.em < b.em ? 1 : -1));
  sendJson(ctx.res, 200, { eventos: eventos.slice(0, 300) });
});

// ---- notificações ------------------------------------------------------------
// Todo usuário autenticado consulta o próprio sino: TI/admin veem os avisos
// da equipe + os pessoais; os demais, apenas os pessoais.
rota('GET', '/api/notificacoes', null, (ctx) => {
  const lista = d.db.notificacoes
    .filter((n) => notificacaoVisivel(n, ctx.usuario))
    .sort((a, b) => (a.em < b.em ? 1 : -1)).slice(0, 100);
  sendJson(ctx.res, 200, { notificacoes: lista });
});

rota('GET', '/api/notificacoes/pendentes', null, (ctx) => {
  const lista = d.db.notificacoes.filter((n) => !n.reconhecidaPor && notificacaoVisivel(n, ctx.usuario));
  // `escopo` diz de quais avisos esta conta enxerga: 'equipe' (TI/admin, o que
  // o notificador de bandeja precisa) ou 'pessoal' (só os do próprio usuário).
  // Antes, uma conta errada no notificador levava 403; agora receberia 200 com
  // lista vazia — este campo mantém o diagnóstico possível.
  sendJson(ctx.res, 200, {
    notificacoes: lista,
    escopo: podeAtenderChamado(ctx.usuario) ? 'equipe' : 'pessoal',
  });
});

// Marca de uma vez tudo o que este usuário está vendo no sino.
rota('POST', '/api/notificacoes/reconhecer-todas', null, (ctx) => {
  let n = 0;
  for (const x of d.db.notificacoes) {
    if (!x.reconhecidaPor && notificacaoVisivel(x, ctx.usuario)) {
      x.reconhecidaPor = { id: ctx.usuario.id, nome: ctx.usuario.nome, em: d.agora() };
      n++;
    }
  }
  if (n) { d.flush(); notifyChange('notificacoes'); }
  sendJson(ctx.res, 200, { reconhecidas: n });
});

rota('POST', '/api/notificacoes/:id/reconhecer', null, (ctx) => {
  const n = d.db.notificacoes.find((x) => x.id === ctx.params.id);
  if (!n) return erro(ctx.res, 404, 'Notificação não encontrada.');
  if (!notificacaoVisivel(n, ctx.usuario)) return erro(ctx.res, 403, 'Esta notificação não é sua.');
  if (!n.reconhecidaPor) {
    n.reconhecidaPor = { id: ctx.usuario.id, nome: ctx.usuario.nome, em: d.agora() };
    d.flush();
    notifyChange('notificacoes');
  }
  sendJson(ctx.res, 200, { notificacao: n });
});

// ---- home office -------------------------------------------------------------
// Líderes registram os equipamentos que um colaborador leva para casa; o
// sistema abre um prazo de 3 dias e o colaborador informa a devolução (com
// foto) pela aba própria — o que também abre um chamado para a TI conferir.
const HO_ANEXOS_DIR = path.join(d.DATA_DIR, 'ho-anexos');
fs.mkdirSync(HO_ANEXOS_DIR, { recursive: true });
const HO_PRAZO_DIAS = 3;
const HO_IMG_MIME = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp' };

function acharHO(id) {
  return d.db.homeoffice.find((r) => r.id === id) || null;
}
function somarDias(iso, dias) {
  const [a, m, dd] = iso.split('-').map(Number);
  const dt = new Date(a, m - 1, dd + dias);
  const p = (n) => String(n).padStart(2, '0');
  return dt.getFullYear() + '-' + p(dt.getMonth() + 1) + '-' + p(dt.getDate());
}
function dataBR(iso) {
  const [a, m, dd] = String(iso).split('-');
  return dd + '/' + m + '/' + a;
}
// Corpo do chamado que o líder abre para o colaborador. A lista de itens daqui
// é o que vale: nada que não esteja escrito nela pode sair da empresa.
function descricaoChamadoHO(reg, lider) {
  return 'Saída de equipamento para Home Office registrada por ' + lider.nome + '.\n' +
    'Colaborador: ' + reg.colaborador.nome + '\n' +
    'Levado em: ' + dataBR(reg.dataLevada) + '\n' +
    'Devolver até: ' + dataBR(reg.prazoDevolucao) + ' (' + HO_PRAZO_DIAS + ' dias)\n\n' +
    'Itens autorizados a sair — somente estes:\n- ' + reg.itens.join('\n- ') + '\n\n' +
    'Regras:\n- ' + regrasHO.REGRAS.join('\n- ') + '\n\n' +
    'A devolução é informada pelo colaborador na aba "Devolução Home Office", com foto dos aparelhos.';
}

// Nomes para o líder escolher na lista (todos os usuários, menos contas de
// serviço). Vai junto se é líder — a tela usa isso para a regra do celular.
rota('GET', '/api/homeoffice/colaboradores', null, (ctx) => {
  if (!gestorHomeOffice(ctx.usuario)) return erro(ctx.res, 403, 'Apenas líderes registram Home Office.');
  const lista = d.db.usuarios
    .filter((u) => u.login !== 'admin' && u.login !== 'claude')
    .map((u) => ({ id: u.id, nome: u.nome, lider: ehLider(u) }))
    .sort((a, b) => a.nome.localeCompare(b.nome, 'pt-BR'));
  sendJson(ctx.res, 200, { colaboradores: lista });
});

rota('GET', '/api/homeoffice', null, (ctx) => {
  let lista = d.db.homeoffice;
  if (!gestorHomeOffice(ctx.usuario)) {
    lista = lista.filter((r) => r.colaborador.id === ctx.usuario.id);
  }
  lista = lista.slice().sort((a, b) => (a.criadoEm < b.criadoEm ? 1 : -1));
  sendJson(ctx.res, 200, { registros: lista, gestor: gestorHomeOffice(ctx.usuario) });
});

rota('POST', '/api/homeoffice', null, (ctx) => {
  if (!gestorHomeOffice(ctx.usuario)) return erro(ctx.res, 403, 'Apenas líderes registram Home Office.');
  const b = ctx.body;
  let colaborador = null;
  let usuarioColab = null; // conta do colaborador, quando ele existe no sistema
  if (b.colaboradorId) {
    const u = d.db.usuarios.find((x) => x.id === b.colaboradorId);
    if (!u) return erro(ctx.res, 400, 'Colaborador não encontrado.');
    usuarioColab = u;
    colaborador = { id: u.id, nome: u.nome };
  } else {
    const nome = txt(b.colaboradorNome, 80);
    if (!nome) return erro(ctx.res, 400, 'Informe o colaborador.');
    // Se o nome digitado bate com um usuário, vincula (permite a devolução por ele).
    const u = d.db.usuarios.find((x) => x.nome.toLowerCase() === nome.toLowerCase());
    usuarioColab = u || null;
    colaborador = { id: u ? u.id : null, nome: u ? u.nome : nome };
  }
  const itens = (Array.isArray(b.itens) ? b.itens : String(b.itens || '').split('\n'))
    .map((i) => txt(i, 120)).filter(Boolean).slice(0, 20);
  if (!itens.length) return erro(ctx.res, 400, 'Informe ao menos um item levado.');

  // Regras da casa. Vale a liderança de QUEM LEVA (o colaborador), não a de
  // quem registra: um líder não pode liberar celular para um não-líder.
  const conferencia = regrasHO.validarItens(itens, {
    colaboradorLider: ehLider(usuarioColab),
    colaboradorConhecido: !!usuarioColab,
    colaboradorNome: colaborador.nome,
  });
  if (!conferencia.ok) {
    return erro(ctx.res, 400, conferencia.problemas.map((p) => p.mensagem).join(' '));
  }

  const dataLevada = /^\d{4}-\d{2}-\d{2}$/.test(String(b.dataLevada || '')) ? b.dataLevada : null;
  if (!dataLevada) return erro(ctx.res, 400, 'Informe a data em que os itens foram levados.');

  const registro = {
    id: d.novoIdHomeOffice(),
    criadoEm: d.agora(),
    registradoPor: { id: ctx.usuario.id, nome: ctx.usuario.nome },
    colaborador,
    itens,
    dataLevada,
    prazoDevolucao: somarDias(dataLevada, HO_PRAZO_DIAS),
    status: 'em_uso', // 'em_uso' | 'devolvido' (atraso é derivado do prazo)
    devolucao: null,
    chamadoId: null,
  };

  // O líder abre o chamado em nome do colaborador: a TI fica sabendo do que
  // saiu e o chamado passa a ser a lista oficial de itens autorizados.
  const chamado = novoChamadoObj(ctx.usuario, {
    titulo: txt('Home Office — ' + colaborador.nome, 140),
    descricao: txt(descricaoChamadoHO(registro, ctx.usuario), 4000),
    categoria: 'equipamento',
    prioridade: 'media',
  });
  historico(chamado, ctx.usuario, 'Chamado aberto.',
    'Saída de equipamento para Home Office (' + registro.id + ') — devolver até ' + dataBR(registro.prazoDevolucao) + '.');
  d.db.chamados.push(chamado);
  registro.chamadoId = chamado.id;
  criarNotificacao('novo_chamado', chamado,
    'Home Office — ' + chamado.id,
    ctx.usuario.nome + ' registrou saída de equipamento para ' + colaborador.nome +
      ': ' + itens.join(', ').slice(0, 120) + ' · devolver até ' + dataBR(registro.prazoDevolucao));

  d.db.homeoffice.push(registro);
  d.flush();
  notifyChange('homeoffice');
  notifyChange('chamados');
  sendJson(ctx.res, 200, { registro, chamado });
});

rota('POST', '/api/homeoffice/:id/devolucao', null, (ctx) => {
  const reg = acharHO(ctx.params.id);
  if (!reg) return erro(ctx.res, 404, 'Registro não encontrado.');
  if (reg.status === 'devolvido') return erro(ctx.res, 400, 'Este registro já foi devolvido.');
  const ehColaborador = reg.colaborador.id === ctx.usuario.id;
  if (!ehColaborador && !gestorHomeOffice(ctx.usuario)) {
    return erro(ctx.res, 403, 'Somente o colaborador citado (ou um líder) informa a devolução.');
  }
  const m = /^data:image\/(png|jpe?g|webp);base64,([A-Za-z0-9+/=]+)$/.exec(String(ctx.body.imagem || ''));
  if (!m) return erro(ctx.res, 400, 'Anexe a foto dos aparelhos devolvidos.');
  const buf = Buffer.from(m[2], 'base64');
  if (!buf.length || buf.length > 6 * 1024 * 1024) return erro(ctx.res, 400, 'A imagem deve ter até 6 MB.');
  const ext = m[1] === 'png' ? 'png' : m[1] === 'webp' ? 'webp' : 'jpg';
  const arquivo = reg.id + '-' + Date.now() + '.' + ext;
  fs.writeFileSync(path.join(HO_ANEXOS_DIR, arquivo), buf);

  const observacao = txt(ctx.body.observacao, 1000);
  const textoFoto = 'Foto dos aparelhos anexada no registro ' + reg.id + ' (aba Home Office).';

  // Um chamado por ciclo: a devolução volta no chamado que o líder abriu na
  // saída, para a TI conferir na mesma conversa. Registros antigos (feitos
  // antes do chamado de saída existir) continuam abrindo um chamado próprio.
  let chamado = reg.chamadoId ? acharChamado(reg.chamadoId) : null;
  if (chamado) {
    chamado.comentarios.push({
      id: d.novoIdComentario(),
      em: d.agora(),
      por: { id: ctx.usuario.id, nome: ctx.usuario.nome, papel: ctx.usuario.papel },
      texto: 'Devolução informada por ' + ctx.usuario.nome + '.\n' + textoFoto +
        (observacao ? '\nObservação: ' + observacao : ''),
    });
    if (chamado.status === 'finalizado') { chamado.status = 'pendente'; chamado.finalizadoEm = null; }
    historico(chamado, ctx.usuario, 'Devolução informada.', 'TI: conferir os itens devolvidos (' + reg.id + ').');
    criarNotificacao('comentario', chamado,
      'Devolução Home Office — ' + chamado.id,
      ctx.usuario.nome + ' informou a devolução dos aparelhos (' + reg.id + '): ' + reg.itens.join(', ').slice(0, 140));
  } else {
    chamado = novoChamadoObj(ctx.usuario, {
      titulo: txt('Devolução Home Office ' + reg.id + ' — ' + reg.colaborador.nome, 140),
      descricao: txt('Devolução dos aparelhos levados para Home Office em ' + dataBR(reg.dataLevada) + ':\n- ' +
        reg.itens.join('\n- ') + (observacao ? '\n\nObservação: ' + observacao : '') +
        '\n\n' + textoFoto, 4000),
      categoria: 'equipamento',
      prioridade: 'media',
    });
    historico(chamado, ctx.usuario, 'Chamado aberto.', 'Devolução de equipamentos de Home Office (' + reg.id + ').');
    d.db.chamados.push(chamado);
    criarNotificacao('novo_chamado', chamado,
      'Devolução Home Office — ' + chamado.id,
      ctx.usuario.nome + ' informou a devolução dos aparelhos (' + reg.id + '): ' + reg.itens.join(', ').slice(0, 140));
  }

  reg.status = 'devolvido';
  reg.devolucao = {
    em: d.agora(),
    por: { id: ctx.usuario.id, nome: ctx.usuario.nome },
    chamadoId: chamado.id,
    imagem: arquivo,
    observacao: observacao || null,
  };
  d.flush();
  notifyChange('homeoffice');
  notifyChange('chamados');
  sendJson(ctx.res, 200, { registro: reg, chamado });
});

// A foto é servida daqui (ti-data fica fora da pasta estática); o <a>/<img>
// autentica pelo ?token=, que o despacho já aceita.
rota('GET', '/api/homeoffice/:id/imagem', null, (ctx) => {
  const reg = acharHO(ctx.params.id);
  if (!reg || !reg.devolucao || !reg.devolucao.imagem) return erro(ctx.res, 404, 'Sem imagem para este registro.');
  const arquivo = path.basename(reg.devolucao.imagem);
  fs.readFile(path.join(HO_ANEXOS_DIR, arquivo), (err, dados) => {
    if (err) return erro(ctx.res, 404, 'Imagem não encontrada no servidor.');
    const ext = path.extname(arquivo).slice(1).toLowerCase();
    send(ctx.res, 200, dados, { 'Content-Type': HO_IMG_MIME[ext] || 'application/octet-stream' });
  });
});

rota('DELETE', '/api/homeoffice/:id', ['admin'], (ctx) => {
  const reg = acharHO(ctx.params.id);
  if (!reg) return erro(ctx.res, 404, 'Registro não encontrado.');
  if (reg.devolucao && reg.devolucao.imagem) {
    try { fs.unlinkSync(path.join(HO_ANEXOS_DIR, path.basename(reg.devolucao.imagem))); } catch (e) { /* ignore */ }
  }
  d.db.homeoffice = d.db.homeoffice.filter((r) => r.id !== reg.id);
  d.flush();
  notifyChange('homeoffice');
  sendJson(ctx.res, 200, { ok: true });
});

// ---- backup ------------------------------------------------------------------
rota('GET', '/api/export', ['admin'], (ctx) => {
  sendJson(ctx.res, 200, d.db);
});

// ---------------------------------------------------------------------------
// Despacho HTTP.
// ---------------------------------------------------------------------------
function handleApi(req, res) {
  const chunks = [];
  let size = 0;
  let tooBig = false;
  req.on('data', (c) => {
    if (tooBig) return;
    size += c.length;
    if (size > BODY_LIMIT) {
      tooBig = true;
      erro(res, 413, 'Requisição grande demais.');
      req.destroy();
      return;
    }
    chunks.push(c);
  });
  req.on('end', () => {
    if (res.writableEnded) return;
    let body = {};
    if (chunks.length) {
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); }
      catch (e) { return erro(res, 400, 'JSON inválido no corpo da requisição.'); }
    }
    const u = new URL(req.url, 'http://x');
    const urlPath = u.pathname;
    const query = u.searchParams;
    const ip = (req.socket && req.socket.remoteAddress) || '?';
    const token = req.headers['x-token'] || query.get('token') || '';

    for (const r of rotas) {
      if (r.metodo !== req.method) continue;
      const m = r.re.exec(urlPath);
      if (!m) continue;
      const params = {};
      r.keys.forEach((k, i) => { try { params[k] = decodeURIComponent(m[i + 1]); } catch (e) { params[k] = m[i + 1]; } });

      const anon = Array.isArray(r.papeis) && r.papeis.includes('anon');
      let usuario = null;
      if (!anon) {
        usuario = d.usuarioPorToken(token);
        if (!usuario) return erro(res, 401, 'Sessão inválida ou expirada. Entre novamente.');
        if (Array.isArray(r.papeis) && r.papeis.length && !r.papeis.includes(usuario.papel)) {
          return erro(res, 403, 'Seu perfil não tem permissão para esta ação.');
        }
      }
      try {
        return r.handler({ req, res, usuario, body, params, query, ip, token });
      } catch (e) {
        console.error('[Chamados TI] erro na rota ' + req.method + ' ' + urlPath + ':', e);
        return erro(res, 500, 'Erro interno do servidor.');
      }
    }
    erro(res, 404, 'Rota não encontrada.');
  });
  req.on('error', () => { if (!res.writableEnded) send(res, 400, 'Erro na requisição'); });
}

function serveStatic(req, res) {
  let urlPath;
  try { urlPath = decodeURIComponent(req.url.split('?')[0]); }
  catch (e) { return send(res, 400, 'Bad request'); }
  if (urlPath === '/' || urlPath === '') urlPath = '/index.html';

  const filePath = path.normalize(path.join(ROOT, urlPath));
  if (filePath !== ROOT && !filePath.startsWith(ROOT + path.sep)) {
    return send(res, 403, 'Forbidden');
  }
  const blocked = [path.join(ROOT, 'server')];
  if (blocked.some((b) => filePath === b || filePath.startsWith(b + path.sep))) {
    return send(res, 403, 'Forbidden');
  }
  fs.readFile(filePath, (err, data) => {
    if (err) return send(res, 404, 'Não encontrado');
    const ext = path.extname(filePath).toLowerCase();
    send(res, 200, data, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
  });
}

const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  if (u.pathname === '/api/events' && req.method === 'GET') {
    return handleSSE(req, res, u.searchParams);
  }
  if (u.pathname === '/api' || u.pathname.startsWith('/api/')) {
    return handleApi(req, res);
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return send(res, 405, 'Método não permitido');
  }
  serveStatic(req, res);
});

server.listen(PORT, HOST, () => {
  console.log(`[Chamados TI] servidor no ar em http://${HOST}:${PORT}`);
  console.log(`[Chamados TI] dados em: ${d.DATA_FILE}`);
});

// Snapshot automático periódico + limpeza de sessões vencidas.
setInterval(() => {
  try { d.snapshot('auto'); } catch (e) { /* ignore */ }
  try { d.limparSessoes(); } catch (e) { /* ignore */ }
}, 6 * 60 * 60 * 1000).unref();
