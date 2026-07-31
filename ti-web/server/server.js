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

const PORT = parseInt(process.env.PORT, 10) || 8085;
const HOST = process.env.HOST || '0.0.0.0';
const ROOT = path.join(__dirname, '..'); // pasta ti-web
const BODY_LIMIT = parseInt(process.env.TI_BODY_LIMIT, 10) || 2 * 1024 * 1024;

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
function publicoUsuario(u) {
  return { id: u.id, nome: u.nome, login: u.login, papel: u.papel, criadoEm: u.criadoEm };
}
function acharChamado(id) {
  return d.db.chamados.find((c) => c.id === id) || null;
}
function historico(chamado, usuario, acao, detalhe) {
  chamado.historico.push({ em: d.agora(), por: usuario ? usuario.nome : 'sistema', acao, detalhe: detalhe || null });
  chamado.atualizadoEm = d.agora();
}
const STATUS_LABEL = { pendente: 'Pendente', em_andamento: 'Em andamento', finalizado: 'Finalizado' };
const PRIO_LABEL = { baixa: 'Baixa', media: 'Média', alta: 'Alta' };

// ---------------------------------------------------------------------------
// Notificações (para a TI / notificador de bandeja).
// ---------------------------------------------------------------------------
function criarNotificacao(tipo, chamado, titulo, mensagem) {
  const n = {
    id: d.novoIdNotificacao(),
    em: d.agora(),
    tipo, // 'novo_chamado' | 'status' | 'comentario'
    chamadoId: chamado.id,
    titulo,
    mensagem,
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
  if (d.db.notificacoes.length > 500) d.db.notificacoes = d.db.notificacoes.slice(-400);
  broadcast({ tipo: 'notificacao', notificacao: n });
  return n;
}

function reconhecerNotificacoesDoChamado(chamadoId, usuario, tipos) {
  for (const n of d.db.notificacoes) {
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
  const u = d.criarUsuarioObj(nome, login, senha, papel);
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
  d.flush();
  notifyChange('usuarios');
  sendJson(ctx.res, 200, { usuario: publicoUsuario(u) });
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

  const chamado = {
    id: d.novoIdChamado(),
    criadoEm: d.agora(),
    atualizadoEm: d.agora(),
    solicitante: { id: ctx.usuario.id, nome: ctx.usuario.nome },
    titulo,
    descricao,
    categoria,
    prioridade,
    urgente,
    status: 'pendente',
    responsavel: null,
    finalizadoEm: null,
    comentarios: [],
    historico: [],
  };
  historico(chamado, ctx.usuario, 'Chamado aberto.',
    'Prioridade ' + PRIO_LABEL[prioridade] + (urgente ? ' · URGENTE' : ''));
  d.db.chamados.push(chamado);
  // Notifica a TI apenas quando quem abriu é solicitante (a própria TI não
  // precisa de aviso sobre o que ela mesma registrou).
  if (ctx.usuario.papel === 'solicitante') {
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
  const podeEditarTexto = ctx.usuario.papel !== 'solicitante' || chamado.solicitante.id === ctx.usuario.id;
  let mudou = false;

  if (b.status !== undefined && b.status !== chamado.status) {
    if (!STATUS.includes(b.status)) return erro(ctx.res, 400, 'Status inválido.');
    const de = chamado.status;
    chamado.status = b.status;
    chamado.finalizadoEm = b.status === 'finalizado' ? d.agora() : null;
    if (b.status === 'em_andamento' && !chamado.responsavel) chamado.responsavel = ctx.usuario.nome;
    historico(chamado, ctx.usuario, 'Status alterado.', STATUS_LABEL[de] + ' → ' + STATUS_LABEL[b.status]);
    if (ctx.usuario.papel === 'solicitante') {
      criarNotificacao('status', chamado,
        'Status alterado — ' + chamado.id,
        ctx.usuario.nome + ' mudou o status para ' + STATUS_LABEL[b.status] + ' · ' + chamado.titulo);
    }
    if (b.status === 'finalizado') reconhecerNotificacoesDoChamado(chamado.id, ctx.usuario, null);
    mudou = true;
  }
  if (b.prioridade !== undefined && b.prioridade !== chamado.prioridade) {
    if (!PRIORIDADES.includes(b.prioridade)) return erro(ctx.res, 400, 'Prioridade inválida.');
    historico(chamado, ctx.usuario, 'Prioridade alterada.', PRIO_LABEL[chamado.prioridade] + ' → ' + PRIO_LABEL[b.prioridade]);
    chamado.prioridade = b.prioridade;
    mudou = true;
  }
  if (b.urgente !== undefined && !!b.urgente !== chamado.urgente) {
    chamado.urgente = !!b.urgente;
    historico(chamado, ctx.usuario, chamado.urgente ? 'Marcado como URGENTE.' : 'Urgência removida.');
    mudou = true;
  }
  if (b.responsavel !== undefined) {
    const r = txt(b.responsavel, 80) || null;
    if (r !== chamado.responsavel) {
      historico(chamado, ctx.usuario, 'Responsável definido.', r || '(ninguém)');
      chamado.responsavel = r;
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
  const comentario = {
    id: d.novoIdComentario(),
    em: d.agora(),
    por: { id: ctx.usuario.id, nome: ctx.usuario.nome, papel: ctx.usuario.papel },
    texto,
  };
  chamado.comentarios.push(comentario);
  historico(chamado, ctx.usuario, 'Observação adicionada.', texto.slice(0, 120));
  if (ctx.usuario.papel === 'solicitante') {
    criarNotificacao('comentario', chamado,
      'Nova observação — ' + chamado.id,
      ctx.usuario.nome + ': ' + texto.slice(0, 140) + ' · ' + chamado.titulo);
  }
  d.flush();
  notifyChange('chamados');
  sendJson(ctx.res, 200, { comentario, chamado });
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
rota('GET', '/api/notificacoes', ['ti', 'admin'], (ctx) => {
  const lista = d.db.notificacoes.slice().sort((a, b) => (a.em < b.em ? 1 : -1)).slice(0, 100);
  sendJson(ctx.res, 200, { notificacoes: lista });
});

rota('GET', '/api/notificacoes/pendentes', ['ti', 'admin'], (ctx) => {
  const lista = d.db.notificacoes.filter((n) => !n.reconhecidaPor);
  sendJson(ctx.res, 200, { notificacoes: lista });
});

rota('POST', '/api/notificacoes/:id/reconhecer', ['ti', 'admin'], (ctx) => {
  const n = d.db.notificacoes.find((x) => x.id === ctx.params.id);
  if (!n) return erro(ctx.res, 404, 'Notificação não encontrada.');
  if (!n.reconhecidaPor) {
    n.reconhecidaPor = { id: ctx.usuario.id, nome: ctx.usuario.nome, em: d.agora() };
    d.flush();
    notifyChange('notificacoes');
  }
  sendJson(ctx.res, 200, { notificacao: n });
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
