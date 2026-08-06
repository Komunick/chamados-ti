'use strict';
/*
 * Chamados de TI — aplicação de página única (SPA) em JavaScript puro.
 * Lista de atendimento com prioridades/urgência, comentários e histórico.
 */
(function () {
  const TOKEN_KEY = 'ti.token';
  const $ = (id) => document.getElementById(id);

  const estado = {
    usuario: null,
    chamados: [],
    filtro: 'fila',
    busca: '',
    aba: 'chamados',     // 'chamados' | 'homeoffice' | 'devolucao' | 'painel' | 'ajuda'
    homeoffice: [],      // registros visíveis ao usuário
    posFila: {},         // id do chamado -> posição na fila de atendimento
    colaboradores: [],   // nomes para o líder escolher
    atendentes: [],      // quem pode receber atribuição de chamado
    artigos: [],         // base de conhecimento (aba Ajuda)
    abertoId: null,      // chamado aberto no painel
    sse: null,
    atualizacaoPendente: false,
  };

  const STATUS_LABEL = { pendente: 'Pendente', em_andamento: 'Em andamento', finalizado: 'Finalizado' };
  const PRIO_LABEL = { baixa: 'Baixa', media: 'Média', alta: 'Alta' };
  const PRIO_PESO = { alta: 3, media: 2, baixa: 1 };
  const CAT_LABEL = { sistema: 'Sistema / software', equipamento: 'Equipamento', rede: 'Rede / internet', acesso: 'Acesso / senha', impressora: 'Impressora', outro: 'Outro' };
  // Regras dos itens do Home Office — regras-ho.js, o mesmo arquivo que o
  // servidor usa. Se por algum motivo não carregar, a tela deixa passar e o
  // servidor barra (lá é que a regra vale de fato).
  const RegrasHO = window.RegrasHO || { REGRAS: [], validarItens: () => ({ ok: true, problemas: [] }) };

  function esc(v) {
    if (v == null) return '';
    return String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function aviso(msg, tipo) {
    const w = $('aviso-wrap');
    const el = document.createElement('div');
    el.className = 'aviso' + (tipo === 'erro' ? ' erro' : '');
    el.textContent = msg;
    w.appendChild(el);
    setTimeout(() => { el.style.opacity = '0'; el.style.transform = 'translateY(6px)'; }, 3400);
    setTimeout(() => el.remove(), 3800);
  }
  function dataFmt(iso) {
    if (!iso) return '—';
    const d = new Date(iso);
    return d.toLocaleDateString('pt-BR') + ' ' + d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
  }
  function diasDesde(iso) {
    const dias = Math.floor((Date.now() - Date.parse(iso)) / 86400000);
    if (dias <= 0) return 'hoje';
    return dias === 1 ? 'há 1 dia' : 'há ' + dias + ' dias';
  }
  // "3h", "2 dias" — usado nos prazos de SLA e no tempo médio dos relatórios.
  function duracaoCurta(ms) {
    const min = Math.round(Math.abs(ms) / 60000);
    if (min < 60) return min + ' min';
    const h = Math.round(min / 60);
    if (h < 48) return h + 'h';
    return Math.round(h / 24) + ' dias';
  }

  // ---------------------------------------------------------------------------
  // SLA — o prazo vem pronto do servidor (chamado.prazoSla). Aqui só se traduz
  // em pill: quanto falta, ou há quanto tempo estourou.
  // ---------------------------------------------------------------------------
  function sla(c) {
    if (!c.prazoSla) return null;
    const restante = Date.parse(c.prazoSla) - Date.now();
    if (c.status === 'finalizado') {
      if (!c.finalizadoEm) return null;
      const dentro = Date.parse(c.finalizadoEm) <= Date.parse(c.prazoSla);
      return dentro
        ? { classe: 'sla-ok', texto: '✔ no prazo', titulo: 'Finalizado dentro do prazo de atendimento.' }
        : { classe: 'sla-estourado', texto: '⚠ fora do prazo', titulo: 'Finalizado depois do prazo de atendimento.' };
    }
    if (restante < 0) {
      return { classe: 'sla-estourado', texto: '⚠ atrasado ' + duracaoCurta(restante), titulo: 'O prazo de atendimento venceu.' };
    }
    const classe = restante < 4 * 3600000 ? 'sla-perto' : 'sla-ok';
    return { classe, texto: '⏱ vence em ' + duracaoCurta(restante), titulo: 'Prazo de atendimento: ' + dataFmt(c.prazoSla) };
  }
  function slaPill(c) {
    const s = sla(c);
    return s ? `<span class="pill ${s.classe}" title="${esc(s.titulo)}">${s.texto}</span>` : '';
  }
  const estrelas = (n) => '★★★★★'.slice(0, n) + '☆☆☆☆☆'.slice(0, 5 - n);

  // Reduz uma foto no navegador (máx. 1600 px, JPEG) — o mesmo tratamento da
  // foto de devolução, reaproveitado pelos anexos de chamado.
  function comprimirImagem(file) {
    return new Promise((resolve, reject) => {
      if (!file) return reject(new Error('Escolha uma imagem.'));
      if (!/^image\//.test(file.type)) return reject(new Error('O anexo precisa ser uma imagem.'));
      const img = new Image();
      const url = URL.createObjectURL(file);
      img.onload = () => {
        URL.revokeObjectURL(url);
        const escala = Math.min(1, 1600 / Math.max(img.width, img.height));
        const cv = document.createElement('canvas');
        cv.width = Math.max(1, Math.round(img.width * escala));
        cv.height = Math.max(1, Math.round(img.height * escala));
        cv.getContext('2d').drawImage(img, 0, 0, cv.width, cv.height);
        resolve(cv.toDataURL('image/jpeg', 0.85));
      };
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Não foi possível ler a imagem.')); };
      img.src = url;
    });
  }

  /*
   * Liga um <input type="file"> a uma tira de miniaturas: as imagens escolhidas
   * ficam guardadas em memória (data URL) até o envio do formulário. Devolve
   * uma função que entrega a lista pronta para a API.
   */
  function ligarAnexos(inputId, tiraId, iniciais) {
    const imagens = (iniciais || []).slice();
    const input = $(inputId);
    const tira = $(tiraId);
    if (!input || !tira) return () => [];
    const desenhar = () => {
      tira.hidden = !imagens.length;
      tira.innerHTML = imagens.map((src, i) =>
        `<div class="anexo-mini"><img src="${src}" alt="Anexo ${i + 1}">
           <button type="button" class="anexo-x" data-i="${i}" aria-label="Remover anexo">✕</button></div>`).join('');
      tira.querySelectorAll('[data-i]').forEach((b) => {
        b.addEventListener('click', () => { imagens.splice(Number(b.dataset.i), 1); desenhar(); });
      });
    };
    input.addEventListener('change', async () => {
      for (const file of Array.from(input.files || []).slice(0, 5)) {
        if (imagens.length >= 5) { aviso('Máximo de 5 imagens por envio.', 'erro'); break; }
        try { imagens.push(await comprimirImagem(file)); }
        catch (e) { aviso(e.message, 'erro'); }
      }
      input.value = '';
      desenhar();
    });
    desenhar(); // pinta as que vieram de um redesenho do painel
    return () => imagens.slice();
  }

  // ---------------------------------------------------------------------------
  // API.
  // ---------------------------------------------------------------------------
  async function api(caminho, opts = {}) {
    const headers = { 'X-Token': localStorage.getItem(TOKEN_KEY) || '' };
    let body;
    if (opts.body !== undefined) { headers['Content-Type'] = 'application/json'; body = JSON.stringify(opts.body); }
    let res;
    try { res = await fetch(caminho, { method: opts.method || 'GET', headers, body }); }
    catch (e) { throw new Error('Sem conexão com o servidor. Verifique a rede (ZeroTier).'); }
    let dados = null;
    try { dados = await res.json(); } catch (e) { /* sem corpo */ }
    if (res.status === 401 && caminho !== '/api/auth/login') { sair(true); throw new Error('Sessão expirada. Entre novamente.'); }
    if (!res.ok) throw new Error((dados && dados.error) || ('Erro ' + res.status));
    return dados;
  }

  // ---------------------------------------------------------------------------
  // Lista de atendimento.
  // ---------------------------------------------------------------------------
  function ordenar(lista, filtro) {
    if (filtro === 'fila') {
      // Fila: urgentes primeiro, depois prioridade, depois o mais antigo.
      return lista.slice().sort((a, b) =>
        (b.urgente - a.urgente) ||
        (PRIO_PESO[b.prioridade] - PRIO_PESO[a.prioridade]) ||
        (a.criadoEm < b.criadoEm ? -1 : 1));
    }
    return lista.slice().sort((a, b) => (a.criadoEm < b.criadoEm ? 1 : -1));
  }

  // Posição de cada chamado NÃO finalizado na fila de atendimento (mesma ordem
  // da fila: urgentes → prioridade → mais antigo). Devolve { id: {pos, total} }.
  // É o que embasa a mensagem "seu chamado está em Nº na fila".
  function posicoesFila() {
    const fila = ordenar(estado.chamados.filter((c) => c.status !== 'finalizado'), 'fila');
    const mapa = {};
    fila.forEach((c, i) => { mapa[c.id] = { pos: i + 1, total: fila.length }; });
    return mapa;
  }
  const ordinal = (n) => n + 'º';

  // Um chamado é "meu atendimento" quando está no meu nome e ainda aberto.
  function meuAtendimento(c) {
    const u = estado.usuario;
    if (!u) return false;
    return c.status !== 'finalizado' && (c.responsavelId === u.id || c.responsavel === u.nome);
  }
  function atrasado(c) {
    return c.status !== 'finalizado' && !!c.prazoSla && Date.parse(c.prazoSla) < Date.now();
  }

  function filtrar() {
    let lista = estado.chamados;
    if (estado.filtro === 'fila') lista = lista.filter((c) => c.status !== 'finalizado');
    else if (estado.filtro === 'meus') lista = lista.filter(meuAtendimento);
    else if (estado.filtro === 'atrasados') lista = lista.filter(atrasado);
    else if (estado.filtro !== 'todos') lista = lista.filter((c) => c.status === estado.filtro);
    if (estado.busca) {
      const t = estado.busca.toLowerCase();
      const hit = (v) => v != null && String(v).toLowerCase().includes(t);
      lista = lista.filter((c) => hit(c.id) || hit(c.titulo) || hit(c.descricao) || hit(c.solicitante.nome) || hit(c.responsavel) || hit(CAT_LABEL[c.categoria]));
    }
    return ordenar(lista, estado.filtro);
  }

  // Pill de posição na fila. Só para chamados não finalizados. Quando o chamado
  // é do próprio usuário logado, a pill fica destacada e fala na 2ª pessoa.
  function filaPill(c) {
    if (c.status === 'finalizado') return '';
    const info = (estado.posFila || {})[c.id];
    if (!info) return '';
    const meu = estado.usuario && c.solicitante.id === estado.usuario.id;
    const texto = meu
      ? `🎫 Seu chamado: ${ordinal(info.pos)} na fila`
      : `🎫 ${ordinal(info.pos)} na fila`;
    return `<span class="pill pill-fila${meu ? ' pill-fila-eu' : ''}" title="Posição na fila de atendimento (de ${info.total})">${texto}</span>`;
  }

  function cartao(c) {
    // Cartão do design Stitch: nº em mono discreta, título semibold, meta
    // (solicitante · setor · idade), pill de prioridade e status como pill
    // colorida (select estilizado, mantém a troca rápida de status).
    const anexos = (c.anexos || []).length;
    return `
      <div class="cartao${c.urgente && c.status !== 'finalizado' ? ' urgente' : ''}${atrasado(c) ? ' atrasado' : ''}" data-id="${c.id}">
        <div class="c-info">
          <div class="c-topo">
            <span class="num">${esc(c.id)}</span>
            ${c.urgente ? '<span class="pill pill-urgente">🚨 Urgente</span>' : ''}
            ${filaPill(c)}
            ${slaPill(c)}
            <span class="c-idade">aberto ${diasDesde(c.criadoEm)}</span>
          </div>
          <div class="c-titulo">${esc(c.titulo)}</div>
          <div class="c-sub">
            ${esc(c.solicitante.nome)} · ${esc(CAT_LABEL[c.categoria] || c.categoria)}
            ${c.responsavel ? ' · atendido por ' + esc(c.responsavel) : ''}
            ${c.reaberturas ? ' · <strong>reaberto ' + (c.reaberturas === 1 ? '1 vez' : c.reaberturas + ' vezes') + '</strong>' : ''}
          </div>
        </div>
        <div class="c-lado">
          ${anexos ? `<span class="c-coment" title="Anexos">📎 ${anexos}</span>` : ''}
          ${c.avaliacao ? `<span class="pill pill-nota" title="Avaliação do solicitante">${estrelas(c.avaliacao.nota)}</span>` : ''}
          <span class="c-coment" title="Observações">💬 ${c.comentarios.length}</span>
          <span class="pill pri-${c.prioridade}">${c.prioridade === 'alta' ? '▲' : c.prioridade === 'media' ? '■' : '▼'} ${PRIO_LABEL[c.prioridade]}</span>
          ${podeAtender()
            ? `<select class="status-sel st-${c.status}" data-status="${c.id}">
            <option value="pendente"${c.status === 'pendente' ? ' selected' : ''}>Pendente</option>
            <option value="em_andamento"${c.status === 'em_andamento' ? ' selected' : ''}>Em andamento</option>
            <option value="finalizado"${c.status === 'finalizado' ? ' selected' : ''}>Finalizado</option>
          </select>`
            : `<span class="pill st-${c.status}">${STATUS_LABEL[c.status]}</span>`}
        </div>
      </div>`;
  }

  // Mensagem no topo da lista com a posição dos chamados do próprio usuário na
  // fila de atendimento (some quando ele não tem chamado em aberto).
  function mensagemMinhaFila() {
    const el = $('minha-fila');
    if (!el) return;
    const u = estado.usuario;
    const meus = u ? estado.chamados
      .filter((c) => c.solicitante.id === u.id && c.status !== 'finalizado')
      .map((c) => ({ c, pos: (estado.posFila[c.id] || {}).pos }))
      .filter((x) => x.pos)
      .sort((a, b) => a.pos - b.pos) : [];
    if (!meus.length) { el.hidden = true; el.innerHTML = ''; return; }
    const total = meus[0] ? (estado.posFila[meus[0].c.id].total) : 0;
    const linhas = meus.map(({ c, pos }) =>
      `<strong>${esc(c.id)}</strong> — ${esc(c.titulo)}: <strong>${ordinal(pos)}</strong> na fila`).join(' · ');
    el.hidden = false;
    el.innerHTML = `🎫 ${meus.length === 1 ? 'Seu chamado está' : 'Seus chamados estão'} na fila de atendimento `
      + `(de ${total} em espera): ${linhas}. O atendimento segue urgência, prioridade e ordem de chegada.`;
  }

  function desenharLista() {
    const lista = filtrar();
    estado.posFila = posicoesFila();
    const n = (f) => estado.chamados.filter((c) =>
      f === 'todos' ? true
        : f === 'fila' ? c.status !== 'finalizado'
        : f === 'meus' ? meuAtendimento(c)
        : f === 'atrasados' ? atrasado(c)
        : c.status === f).length;
    $('c-fila').textContent = n('fila');
    $('c-pend').textContent = n('pendente');
    $('c-and').textContent = n('em_andamento');
    $('c-fin').textContent = n('finalizado');
    $('c-tod').textContent = n('todos');
    // Chips só para quem atende: "meus atendimentos" e "atrasados".
    const meus = $('seg-meus'), atr = $('seg-atrasados');
    if (meus) { meus.hidden = !podeAtender(); $('c-meus').textContent = n('meus'); }
    if (atr) {
      const q = n('atrasados');
      atr.hidden = !podeAtender();
      atr.classList.toggle('seg-alerta', q > 0);
      $('c-atr').textContent = q;
    }
    mensagemMinhaFila();
    $('lista').innerHTML = lista.length
      ? lista.map(cartao).join('')
      : '<div class="vazio">Nenhum chamado aqui. 🎉</div>';

    $('lista').querySelectorAll('.cartao').forEach((el) => {
      el.addEventListener('click', (e) => { if (e.target.closest('select')) return; abrirChamado(el.dataset.id); });
    });
    $('lista').querySelectorAll('[data-status]').forEach((sel) => {
      sel.addEventListener('click', (e) => e.stopPropagation());
      sel.addEventListener('change', async () => {
        try {
          await api('/api/chamados/' + sel.dataset.status, { method: 'PUT', body: { status: sel.value } });
          aviso('Status atualizado: ' + STATUS_LABEL[sel.value]);
          await carregar();
        } catch (e) { aviso(e.message, 'erro'); await carregar(); }
      });
    });
  }

  async function carregar() {
    const r = await api('/api/chamados');
    estado.chamados = r.chamados;
    desenharLista();
    // O sino agora é de todos: o solicitante recebe aviso do próprio chamado.
    atualizarSino();
    if (estado.aba === 'painel') carregarPainel();
    carregarHomeOffice().catch(() => { /* aba segue com os dados anteriores */ });
  }

  // ---------------------------------------------------------------------------
  // Home Office — líderes registram a saída; o colaborador informa a devolução.
  // ---------------------------------------------------------------------------
  function gestorHO() {
    const u = estado.usuario;
    return !!u && (u.papel === 'ti' || u.papel === 'admin' || u.lider);
  }
  // Quem pode alterar o estado dos chamados (status/prioridade/urgência). O
  // servidor decide e envia em `atende`; a tela só esconde os controles de
  // quem não pode — o bloqueio de verdade é no servidor (PUT /api/chamados).
  function podeAtender() {
    return !!(estado.usuario && estado.usuario.atende);
  }
  function hojeISO() {
    const d = new Date();
    const p = (n) => String(n).padStart(2, '0');
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
  }
  function dataCurta(iso) {
    if (!iso) return '—';
    const [a, m, dd] = iso.split('-');
    return dd + '/' + m + '/' + a;
  }
  // Contador de devolução: dias até o prazo (datas locais, sem horário).
  function prazoHO(r) {
    if (r.status === 'devolvido') return { classe: 'pill-devolvido', texto: '✔ Devolvido' };
    const [a, m, dd] = r.prazoDevolucao.split('-').map(Number);
    const hoje = new Date();
    const dias = Math.round((new Date(a, m - 1, dd) - new Date(hoje.getFullYear(), hoje.getMonth(), hoje.getDate())) / 86400000);
    if (dias < 0) return { classe: 'pill-prazo-atrasado', texto: '⚠ atrasado ' + (dias === -1 ? 'há 1 dia' : 'há ' + (-dias) + ' dias'), dias };
    if (dias === 0) return { classe: 'pill-prazo-hoje', texto: '⏳ devolver hoje', dias };
    return { classe: 'pill-prazo-ok', texto: '⏳ ' + (dias === 1 ? '1 dia restante' : dias + ' dias restantes'), dias };
  }
  function ordenarHO(lista) {
    // Em uso primeiro (mais atrasado/mais perto do prazo em cima); devolvidos por último.
    return lista.slice().sort((a, b) => {
      if ((a.status === 'devolvido') !== (b.status === 'devolvido')) return a.status === 'devolvido' ? 1 : -1;
      if (a.status === 'devolvido') return a.criadoEm < b.criadoEm ? 1 : -1;
      return a.prazoDevolucao < b.prazoDevolucao ? -1 : 1;
    });
  }
  const meusHO = () => estado.homeoffice.filter((r) => r.colaborador.id === (estado.usuario && estado.usuario.id));
  const colaboradorPorNome = (nome) => {
    const n = String(nome || '').trim().toLowerCase();
    return n ? (estado.colaboradores.find((c) => c.nome.toLowerCase() === n) || null) : null;
  };

  /*
   * Confere o formulário contra as regras e pinta os avisos na tela: etiqueta
   * do colaborador (pode ou não levar celular) e lista do que está barrado.
   * Devolve o resultado para o botão decidir — o servidor confere de novo.
   */
  function conferirHO() {
    const nome = $('ho-colab') ? $('ho-colab').value.trim() : '';
    const conhecido = colaboradorPorNome(nome);
    const lider = !!(conhecido && conhecido.lider);

    const tag = $('ho-colab-tag');
    if (tag) {
      tag.hidden = !nome;
      tag.className = 'ho-tag' + (nome && lider ? ' ho-tag-lider' : '');
      tag.innerHTML = !nome ? '' : (lider
        ? '⭐ Líder — pode levar celular.'
        : (conhecido
          ? esc(conhecido.nome) + ' não é líder — <strong>não pode levar celular</strong>.'
          : 'Nome fora da lista de usuários — sem confirmação de liderança, <strong>celular não é liberado</strong>.'));
    }

    const v = RegrasHO.validarItens($('ho-itens') ? $('ho-itens').value : '', {
      colaboradorLider: lider,
      colaboradorConhecido: !!conhecido,
      colaboradorNome: conhecido ? conhecido.nome : nome,
    });
    const alerta = $('ho-alerta');
    if (alerta) {
      alerta.hidden = v.ok;
      alerta.innerHTML = v.ok ? ''
        : '<strong>Não pode sair da empresa:</strong><ul>' +
          v.problemas.map((p) => '<li>' + esc(p.mensagem) + '</li>').join('') + '</ul>';
    }
    const btn = $('ho-registrar');
    if (btn) btn.disabled = !v.ok;
    return v;
  }

  async function carregarHomeOffice() {
    if (!estado.usuario) return;
    const r = await api('/api/homeoffice');
    estado.homeoffice = r.registros || [];
    if (gestorHO() && !estado.colaboradores.length) {
      try { estado.colaboradores = (await api('/api/homeoffice/colaboradores')).colaboradores || []; }
      catch (e) { /* sem lista, o campo aceita texto livre */ }
    }
    const emUso = estado.homeoffice.filter((x) => x.status === 'em_uso');
    const meusEmUso = meusHO().filter((x) => x.status === 'em_uso').length;
    $('c-ho').textContent = emUso.length;
    $('c-dev').textContent = meusEmUso;
    // Badges da bottom nav do celular (somem quando zerados).
    const bHo = $('nav-c-ho'), bDev = $('nav-c-dev');
    if (bHo) { bHo.textContent = emUso.length; bHo.hidden = !emUso.length; }
    if (bDev) { bDev.textContent = meusEmUso; bDev.hidden = !meusEmUso; }
    if (estado.aba === 'homeoffice') desenharHomeOffice();
    if (estado.aba === 'devolucao') desenharDevolucao();
  }

  function cartaoHO(r, acoes) {
    const p = prazoHO(r);
    const token = encodeURIComponent(localStorage.getItem(TOKEN_KEY) || '');
    return `
      <div class="cartao ho-cartao${p.classe === 'pill-prazo-atrasado' ? ' urgente' : ''}" data-ho="${esc(r.id)}">
        <div class="c-info">
          <div class="c-topo">
            <span class="num">${esc(r.id)}</span>
            <span class="pill ${p.classe}">${p.texto}</span>
          </div>
          <div class="c-titulo">${esc(r.colaborador.nome)}</div>
          <div class="c-sub">Itens autorizados: ${esc(r.itens.join(', '))}</div>
          <div class="c-sub">Levado em ${dataCurta(r.dataLevada)} · devolver até <strong>${dataCurta(r.prazoDevolucao)}</strong> · registrado por ${esc(r.registradoPor.nome)}
            ${r.chamadoId ? ` · chamado <a class="ho-link" href="#" data-chamado="${esc(r.chamadoId)}">${esc(r.chamadoId)}</a>` : ''}</div>
          ${r.devolucao ? `<div class="c-sub">Devolvido em ${dataFmt(r.devolucao.em)} por ${esc(r.devolucao.por.nome)} ·
            <a class="ho-link" href="/api/homeoffice/${esc(r.id)}/imagem?token=${token}" target="_blank">ver foto</a> ·
            chamado <a class="ho-link" href="#" data-chamado="${esc(r.devolucao.chamadoId)}">${esc(r.devolucao.chamadoId)}</a>
            ${r.devolucao.observacao ? '<br>Obs.: ' + esc(r.devolucao.observacao) : ''}</div>` : ''}
        </div>
        <div class="c-lado">${acoes || ''}</div>
      </div>`;
  }

  function ligarLinksHO(raiz) {
    raiz.querySelectorAll('[data-chamado]').forEach((a) => {
      a.addEventListener('click', (e) => { e.preventDefault(); abrirChamado(a.dataset.chamado); });
    });
  }

  function listaHOHtml(lista) {
    return lista.length
      ? lista.map((r) => cartaoHO(r, r.status === 'em_uso'
          ? `<button class="btn btn-mini" data-devolver="${esc(r.id)}">Registrar devolução</button>` : '')).join('')
      : '<div class="vazio">Nenhum registro de Home Office ainda.</div>';
  }
  function ligarListaHO(raiz) {
    raiz.querySelectorAll('[data-devolver]').forEach((b) => {
      b.addEventListener('click', () => formDevolucao(b.dataset.devolver));
    });
    ligarLinksHO(raiz);
  }

  function desenharHomeOffice() {
    const el = $('ho-conteudo');
    if (!gestorHO()) { el.innerHTML = '<div class="vazio">Apenas líderes registram saídas para Home Office.</div>'; return; }
    const lista = ordenarHO(estado.homeoffice);
    // Formulário em preenchimento? Atualiza só a lista, sem apagar o que foi digitado.
    const colabEl = $('ho-colab');
    if (colabEl && ($('ho-colab').value.trim() || $('ho-itens').value.trim())) {
      const listaEl = el.querySelector('.ho-lista');
      if (listaEl) { listaEl.innerHTML = listaHOHtml(lista); ligarListaHO(listaEl); }
      return;
    }
    el.innerHTML = `
      <div class="ho-form">
        <div class="secao" style="margin-top:0">Abrir chamado de Home Office</div>
        <div class="desc desc-texto" style="margin-bottom:14px">Informe o colaborador e o que ele irá levar. O chamado é aberto no
        seu nome, a TI é avisada e o prazo de devolução é de <strong>3 dias</strong>.</div>
        <div class="ho-regras">
          <div class="ho-regras-titulo">⚠ Regras — leia antes de registrar</div>
          <ul>
            <li><strong>É proibido levar monitor</strong> — qualquer tipo, marca ou tamanho, em nenhuma hipótese.</li>
            <li><strong>Celular só pode ser levado por líder</strong> — colaborador que não é líder não leva celular.</li>
            <li><strong>Nada além do que estiver neste chamado</strong> — item que não for escrito abaixo é proibido sair.</li>
          </ul>
        </div>
        <div class="campo"><label>Colaborador</label>
          <input id="ho-colab" list="ho-colabs" placeholder="Digite o nome ou escolha na lista…" autocomplete="off">
          <datalist id="ho-colabs">${estado.colaboradores.map((c) => `<option value="${esc(c.nome)}">`).join('')}</datalist>
          <div class="ho-tag" id="ho-colab-tag" hidden></div>
        </div>
        <div class="campo"><label>Itens que ele irá levar (um por linha)</label>
          <textarea id="ho-itens" rows="3" placeholder="Ex.:&#10;Notebook Dell + carregador&#10;Mouse sem fio&#10;Headset"></textarea>
        </div>
        <div class="ho-alerta" id="ho-alerta" hidden></div>
        <div class="campo-linha">
          <div class="campo"><label>Data em que está levando</label><input id="ho-data" type="date" value="${hojeISO()}"></div>
          <div class="campo"><label>Prazo de devolução (automático)</label><input id="ho-prazo" disabled></div>
        </div>
        <label class="chk chk-termo"><input type="checkbox" id="ho-termo">
          <span>Confirmo que o colaborador levará <strong>somente</strong> os itens listados acima e está ciente das regras.</span></label>
        <div class="acoes"><button class="btn btn-verde" id="ho-registrar">Abrir chamado de Home Office</button></div>
      </div>
      <div class="secao">Equipamentos em Home Office</div>
      <div class="ho-lista">${listaHOHtml(lista)}</div>`;

    const atualizarPrazo = () => {
      const v = $('ho-data').value;
      if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) { $('ho-prazo').value = ''; return; }
      const [a, m, dd] = v.split('-').map(Number);
      const p = new Date(a, m - 1, dd + 3);
      $('ho-prazo').value = p.toLocaleDateString('pt-BR') + ' (3 dias)';
    };
    atualizarPrazo();
    $('ho-data').addEventListener('change', atualizarPrazo);
    $('ho-colab').addEventListener('input', conferirHO);
    $('ho-colab').addEventListener('change', conferirHO);
    $('ho-itens').addEventListener('input', conferirHO);
    $('ho-registrar').addEventListener('click', async () => {
      const nome = $('ho-colab').value.trim();
      const itens = $('ho-itens').value;
      if (!nome) { aviso('Informe o colaborador.', 'erro'); $('ho-colab').focus(); return; }
      if (!itens.trim()) { aviso('Informe os itens que ele irá levar.', 'erro'); $('ho-itens').focus(); return; }
      // O servidor confere de novo; aqui é só para o líder não descobrir depois.
      const conferencia = conferirHO();
      if (!conferencia.ok) { aviso(conferencia.problemas[0].mensagem, 'erro'); $('ho-itens').focus(); return; }
      if (!$('ho-termo').checked) { aviso('Confirme que ele levará somente os itens listados.', 'erro'); return; }
      const conhecido = colaboradorPorNome(nome);
      try {
        const resp = await api('/api/homeoffice', { method: 'POST', body: {
          colaboradorId: conhecido ? conhecido.id : undefined,
          colaboradorNome: nome,
          itens,
          dataLevada: $('ho-data').value,
        } });
        aviso(resp && resp.chamado
          ? 'Chamado ' + resp.chamado.id + ' aberto — devolução em até 3 dias.'
          : 'Home Office registrado — devolução em até 3 dias.');
        $('ho-colab').value = ''; $('ho-itens').value = ''; $('ho-termo').checked = false;
        await carregar();
        desenharHomeOffice();
      } catch (e) { aviso(e.message, 'erro'); }
    });
    ligarListaHO(el);
  }

  function desenharDevolucao() {
    const el = $('dev-conteudo');
    const meus = ordenarHO(meusHO());
    const emUso = meus.filter((r) => r.status === 'em_uso');
    const devolvidos = meus.filter((r) => r.status === 'devolvido');
    el.innerHTML = `
      <div class="desc desc-texto" style="margin-bottom:16px">Aqui aparecem os equipamentos registrados no seu nome para Home Office.
      Ao devolver, clique em <strong>Informar devolução</strong>, anexe uma foto dos aparelhos e confirme — a TI confere no
      mesmo chamado que o seu líder abriu. Devolva <strong>exatamente</strong> os itens da lista: levar ou trazer qualquer
      coisa fora do que está no chamado não é permitido.</div>
      ${emUso.length
        ? emUso.map((r) => cartaoHO(r, `<button class="btn btn-primario btn-mini" data-devolver="${esc(r.id)}">Informar devolução</button>`)).join('')
        : '<div class="vazio">Nenhum equipamento de Home Office pendente no seu nome. 🎉</div>'}
      ${devolvidos.length ? '<div class="secao">Devoluções anteriores</div>' + devolvidos.map((r) => cartaoHO(r, '')).join('') : ''}`;
    el.querySelectorAll('[data-devolver]').forEach((b) => {
      b.addEventListener('click', () => formDevolucao(b.dataset.devolver));
    });
    ligarLinksHO(el);
  }

  // Reduz a foto no navegador (máx. 1600 px, JPEG) — evita corpo gigante.
  function lerImagemComprimida(file) {
    return new Promise((resolve, reject) => {
      if (!file) return reject(new Error('Anexe a foto dos aparelhos.'));
      if (!/^image\//.test(file.type)) return reject(new Error('O anexo precisa ser uma imagem.'));
      const img = new Image();
      const url = URL.createObjectURL(file);
      img.onload = () => {
        URL.revokeObjectURL(url);
        const escala = Math.min(1, 1600 / Math.max(img.width, img.height));
        const cv = document.createElement('canvas');
        cv.width = Math.max(1, Math.round(img.width * escala));
        cv.height = Math.max(1, Math.round(img.height * escala));
        cv.getContext('2d').drawImage(img, 0, 0, cv.width, cv.height);
        resolve(cv.toDataURL('image/jpeg', 0.85));
      };
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Não foi possível ler a imagem.')); };
      img.src = url;
    });
  }

  function formDevolucao(id) {
    const r = estado.homeoffice.find((x) => x.id === id);
    if (!r) return;
    const corpo = abrirPainel('Devolução · ' + r.id + ' — ' + r.colaborador.nome);
    corpo.innerHTML = `
      <div class="desc">Itens autorizados na saída de ${dataCurta(r.dataLevada)} — devolva todos:<br>• ${r.itens.map(esc).join('<br>• ')}</div>
      <div class="campo" style="margin-top:12px"><label>Foto dos aparelhos devolvidos *</label>
        <input id="dv-foto" type="file" accept="image/*" capture="environment">
      </div>
      <img id="dv-preview" class="ho-preview" alt="" hidden>
      <div class="campo"><label>Observação (opcional)</label>
        <textarea id="dv-obs" rows="3" placeholder="Ex.: devolvido completo, sem avarias…"></textarea>
      </div>
      <div class="acoes">
        <button class="btn" id="dv-cancelar">Cancelar</button>
        <button class="btn btn-primario" id="dv-enviar">Confirmar devolução</button>
      </div>`;
    let imagem = null;
    $('dv-foto').addEventListener('change', async () => {
      try {
        imagem = await lerImagemComprimida($('dv-foto').files[0]);
        $('dv-preview').src = imagem;
        $('dv-preview').hidden = false;
      } catch (e) { imagem = null; $('dv-preview').hidden = true; aviso(e.message, 'erro'); }
    });
    $('dv-cancelar').addEventListener('click', fecharPainel);
    $('dv-enviar').addEventListener('click', async () => {
      if (!imagem) { aviso('Anexe a foto dos aparelhos.', 'erro'); return; }
      const btn = $('dv-enviar');
      btn.disabled = true;
      try {
        const resp = await api('/api/homeoffice/' + r.id + '/devolucao', { method: 'POST', body: {
          imagem, observacao: $('dv-obs').value.trim(),
        } });
        aviso('Devolução registrada — chamado ' + resp.chamado.id + ' aberto para a TI conferir.');
        fecharPainel();
        await carregar();
      } catch (e) { btn.disabled = false; aviso(e.message, 'erro'); }
    });
  }

  function trocarAba(aba) {
    estado.aba = aba;
    $('abas').querySelectorAll('.aba-btn').forEach((b) => b.classList.toggle('active', b.dataset.aba === aba));
    document.querySelectorAll('.bn-item').forEach((b) => b.classList.toggle('active', b.dataset.aba === aba));
    $('aba-chamados').hidden = aba !== 'chamados';
    $('aba-homeoffice').hidden = aba !== 'homeoffice';
    $('aba-devolucao').hidden = aba !== 'devolucao';
    $('aba-ajuda').hidden = aba !== 'ajuda';
    $('aba-painel').hidden = aba !== 'painel';
    if (aba === 'homeoffice') desenharHomeOffice();
    if (aba === 'devolucao') desenharDevolucao();
    if (aba === 'ajuda') carregarAjuda();
    if (aba === 'painel') carregarPainel();
  }

  // ---------------------------------------------------------------------------
  // Painel de indicadores (relatórios) — números do período para o gestor.
  // ---------------------------------------------------------------------------
  function barras(mapa, rotulos) {
    const itens = Object.entries(mapa).sort((a, b) => b[1] - a[1]);
    const max = itens.reduce((m, [, v]) => Math.max(m, v), 0) || 1;
    if (!itens.length) return '<div class="c-sub">Nada no período.</div>';
    return '<div class="barras">' + itens.map(([k, v]) => `
      <div class="barra-linha">
        <span class="barra-rot">${esc((rotulos && rotulos[k]) || k)}</span>
        <span class="barra-trilho"><span class="barra-fill" style="width:${Math.round((v / max) * 100)}%"></span></span>
        <span class="barra-val">${v}</span>
      </div>`).join('') + '</div>';
  }

  // Série diária de aberturas x finalizações, em SVG (sem biblioteca externa).
  function grafico(porDia) {
    const dias = Object.keys(porDia).sort();
    if (dias.length < 2) return '';
    const max = Math.max(1, ...dias.map((d) => Math.max(porDia[d].abertos, porDia[d].finalizados)));
    const L = 560, A = 130, pad = 8;
    const x = (i) => pad + (i * (L - pad * 2)) / (dias.length - 1);
    const y = (v) => A - pad - (v / max) * (A - pad * 2);
    const linha = (campo) => dias.map((d, i) => (i ? 'L' : 'M') + x(i).toFixed(1) + ' ' + y(porDia[d][campo]).toFixed(1)).join(' ');
    const primeiro = dias[0].slice(8) + '/' + dias[0].slice(5, 7);
    const ultimo = dias[dias.length - 1].slice(8) + '/' + dias[dias.length - 1].slice(5, 7);
    return `
      <div class="grafico">
        <svg viewBox="0 0 ${L} ${A}" preserveAspectRatio="none" role="img" aria-label="Chamados abertos e finalizados por dia">
          <path d="${linha('abertos')}" fill="none" stroke="var(--verde)" stroke-width="2.5" stroke-linejoin="round"/>
          <path d="${linha('finalizados')}" fill="none" stroke="var(--ouro)" stroke-width="2.5" stroke-linejoin="round" stroke-dasharray="5 4"/>
        </svg>
        <div class="grafico-legenda">
          <span><i class="leg leg-verde"></i> abertos</span>
          <span><i class="leg leg-ouro"></i> finalizados</span>
          <span class="grafico-datas">${primeiro} — ${ultimo} · pico ${max}/dia</span>
        </div>
      </div>`;
  }

  async function carregarPainel(dias) {
    const el = $('painel-conteudo');
    const periodo = dias || estado.painelDias || 30;
    estado.painelDias = periodo;
    el.innerHTML = '<div class="vazio">Carregando indicadores…</div>';
    let r;
    try { r = await api('/api/relatorios?dias=' + periodo); }
    catch (e) { el.innerHTML = '<div class="vazio">Não foi possível carregar os indicadores.</div>'; return; }

    const num = (v, suf) => (v === null || v === undefined ? '—' : v + (suf || ''));
    // Abaixo de 1 hora o arredondamento viraria "0h" — melhor dizer "<1h".
    const tempoMedio = r.tempoMedioHoras === null ? '—'
      : r.tempoMedioHoras < 1 ? '<1h' : r.tempoMedioHoras + 'h';
    el.innerHTML = `
      <div class="periodo">
        ${[7, 30, 90].map((p) => `<button class="seg-btn${p === periodo ? ' active' : ''}" data-periodo="${p}">${p} dias</button>`).join('')}
      </div>
      <div class="cards">
        <div class="card"><div class="card-num">${r.total}</div><div class="card-rot">Chamados no período</div></div>
        <div class="card"><div class="card-num">${r.finalizados}</div><div class="card-rot">Finalizados</div></div>
        <div class="card"><div class="card-num">${tempoMedio}</div><div class="card-rot">Tempo médio de resolução</div></div>
        <div class="card${r.slaPercentual !== null && r.slaPercentual < 80 ? ' card-alerta' : ''}">
          <div class="card-num">${num(r.slaPercentual, '%')}</div>
          <div class="card-rot">Dentro do prazo (${r.slaAvaliados} avaliados)</div></div>
        <div class="card"><div class="card-num">${r.notaMedia ? r.notaMedia + '★' : '—'}</div>
          <div class="card-rot">Nota média (${r.avaliacoes} avaliações)</div></div>
        <div class="card${r.atrasados ? ' card-alerta' : ''}"><div class="card-num">${r.atrasados}</div>
          <div class="card-rot">Abertos fora do prazo agora</div></div>
        <div class="card"><div class="card-num">${r.emAbertoTotal}</div><div class="card-rot">Em aberto (total)</div></div>
        <div class="card"><div class="card-num">${r.reaberturas}</div><div class="card-rot">Reaberturas</div></div>
      </div>

      <div class="secao">Abertos x finalizados por dia</div>
      ${grafico(r.porDia)}

      <div class="secao">Por categoria</div>
      ${barras(r.porCategoria, CAT_LABEL)}

      <div class="secao">Por prioridade</div>
      ${barras(r.porPrioridade, PRIO_LABEL)}

      <div class="secao">Carga por atendente (chamados em aberto)</div>
      ${barras(r.porResponsavel)}`;

    el.querySelectorAll('[data-periodo]').forEach((b) => {
      b.addEventListener('click', () => carregarPainel(Number(b.dataset.periodo)));
    });
  }

  // ---------------------------------------------------------------------------
  // Base de conhecimento (aba Ajuda). A TI escreve; todos consultam.
  // ---------------------------------------------------------------------------
  async function abrirArtigo(id) {
    let r;
    try { r = await api('/api/artigos/' + id); }
    catch (e) { aviso(e.message, 'erro'); return; }
    const a = r.artigo;
    const corpo = abrirPainel(a.titulo);
    corpo.innerHTML = `
      <div class="meta">
        <span class="num">${esc(CAT_LABEL[a.categoria] || a.categoria)}</span>
        ${(a.etiquetas || []).map((t) => `<span class="pill pill-fila">${esc(t)}</span>`).join('')}
      </div>
      <div class="desc">${esc(a.conteudo)}</div>
      <div class="c-sub" style="margin-top:12px">Escrito por ${esc(a.por.nome)} · atualizado em ${dataFmt(a.atualizadoEm)} · ${a.vistas || 0} leituras</div>
      ${podeAtender() ? `<div class="acoes">
        <button class="btn" id="kb-editar">Editar</button>
        <button class="btn" id="kb-excluir" style="color:var(--perigo);border-color:var(--perigo)">Excluir</button>
      </div>` : ''}`;
    const btnEd = $('kb-editar');
    if (btnEd) btnEd.addEventListener('click', () => formArtigo(a));
    const btnEx = $('kb-excluir');
    if (btnEx) btnEx.addEventListener('click', async () => {
      if (!confirm('Excluir o artigo "' + a.titulo + '"?')) return;
      try { await api('/api/artigos/' + a.id, { method: 'DELETE' }); aviso('Artigo excluído.'); fecharPainel(); carregarAjuda(); }
      catch (e) { aviso(e.message, 'erro'); }
    });
  }

  function formArtigo(artigo) {
    const a = artigo || null;
    const corpo = abrirPainel(a ? 'Editar artigo' : 'Novo artigo');
    corpo.innerHTML = `
      <div class="campo"><label>Título *</label>
        <input id="kb-titulo" maxlength="140" placeholder="Ex.: Como trocar a senha do ERP" value="${a ? esc(a.titulo) : ''}"></div>
      <div class="campo"><label>Categoria</label>
        <select id="kb-cat">
          ${Object.entries(CAT_LABEL).map(([k, v]) =>
            `<option value="${k}"${a && a.categoria === k ? ' selected' : ''}>${esc(v)}</option>`).join('')}
        </select></div>
      <div class="campo"><label>Conteúdo * (passo a passo)</label>
        <textarea id="kb-conteudo" rows="10" placeholder="1. Abra o ERP…">${a ? esc(a.conteudo) : ''}</textarea></div>
      <div class="campo"><label>Etiquetas (separadas por vírgula)</label>
        <input id="kb-tags" placeholder="senha, erp, acesso" value="${a ? esc((a.etiquetas || []).join(', ')) : ''}"></div>
      <div class="acoes">
        <button class="btn" id="kb-cancelar">Cancelar</button>
        <button class="btn btn-primario" id="kb-salvar">${a ? 'Salvar alterações' : 'Publicar artigo'}</button>
      </div>`;
    $('kb-cancelar').addEventListener('click', fecharPainel);
    $('kb-salvar').addEventListener('click', async () => {
      const body = {
        titulo: $('kb-titulo').value.trim(),
        conteudo: $('kb-conteudo').value.trim(),
        categoria: $('kb-cat').value,
        etiquetas: $('kb-tags').value,
      };
      if (!body.titulo || !body.conteudo) { aviso('Informe título e conteúdo.', 'erro'); return; }
      try {
        if (a) await api('/api/artigos/' + a.id, { method: 'PUT', body });
        else await api('/api/artigos', { method: 'POST', body });
        aviso(a ? 'Artigo atualizado.' : 'Artigo publicado.');
        fecharPainel();
        carregarAjuda();
      } catch (e) { aviso(e.message, 'erro'); }
    });
    $('kb-titulo').focus();
  }

  // Só a LISTA é redesenhada a cada busca: se o innerHTML do bloco inteiro
  // fosse trocado, o campo seria destruído e o foco (e o teclado do celular)
  // sumiria a cada tecla digitada.
  function desenharListaAjuda(termo) {
    const lista = $('kb-lista');
    if (!lista) return;
    lista.innerHTML = estado.artigos.length
      ? estado.artigos.map((a) => `
        <div class="cartao kb-cartao" data-kb="${esc(a.id)}">
          <div class="c-info">
            <div class="c-topo">
              <span class="num">${esc(a.id)}</span>
              <span class="pill pill-fila">${esc(CAT_LABEL[a.categoria] || a.categoria)}</span>
              <span class="c-idade">${a.vistas || 0} leituras</span>
            </div>
            <div class="c-titulo">${esc(a.titulo)}</div>
            <div class="c-sub">${esc(a.conteudo.slice(0, 130))}${a.conteudo.length > 130 ? '…' : ''}</div>
          </div>
        </div>`).join('')
      : `<div class="vazio">${termo ? 'Nenhum artigo encontrado para essa busca.' : 'A base de conhecimento ainda está vazia.'}</div>`;
    lista.querySelectorAll('[data-kb]').forEach((c) => {
      c.addEventListener('click', () => abrirArtigo(c.dataset.kb));
    });
  }

  async function carregarAjuda(busca) {
    const el = $('ajuda-conteudo');
    const termo = busca !== undefined ? busca : (estado.buscaKb || '');
    estado.buscaKb = termo;

    // Monta o esqueleto uma vez; nas buscas seguintes só a lista muda.
    if (!$('kb-busca')) {
      el.innerHTML = `
        <div class="desc desc-texto" style="margin-bottom:14px">Guias rápidos escritos pela TI. Procure aqui antes de abrir um
        chamado — muita coisa se resolve em um minuto.</div>
        <div class="filtros">
          <input class="busca" id="kb-busca" placeholder="Buscar na ajuda…" value="${esc(termo)}" autocomplete="off">
          ${podeAtender() ? '<button class="btn btn-primario" id="kb-novo">+ Novo artigo</button>' : ''}
        </div>
        <div class="kb-lista" id="kb-lista"><div class="vazio">Carregando…</div></div>`;
      const btnNovo = $('kb-novo');
      if (btnNovo) btnNovo.addEventListener('click', () => formArtigo(null));
      let debKb;
      $('kb-busca').addEventListener('input', () => {
        clearTimeout(debKb);
        const v = $('kb-busca').value.trim();
        debKb = setTimeout(() => carregarAjuda(v), 250);
      });
    }

    try {
      const r = await api('/api/artigos' + (termo ? '?busca=' + encodeURIComponent(termo) : ''));
      estado.artigos = r.artigos || [];
    } catch (e) {
      const lista = $('kb-lista');
      if (lista) lista.innerHTML = '<div class="vazio">Não foi possível carregar os artigos.</div>';
      return;
    }
    desenharListaAjuda(termo);
  }

  // ---------------------------------------------------------------------------
  // Painel lateral.
  // ---------------------------------------------------------------------------
  function abrirPainel(titulo) {
    estado.painelAberturas = (estado.painelAberturas || 0) + 1;
    $('painel-titulo').textContent = titulo;
    $('painel-fundo').hidden = false;
    $('painel').classList.add('aberto');
    $('painel').setAttribute('aria-hidden', 'false');
    return $('painel-corpo');
  }
  function fecharPainel() {
    estado.abertoId = null;
    estado.fotosPendentes = null;
    $('painel-fundo').hidden = true;
    $('painel').classList.remove('aberto');
    $('painel').setAttribute('aria-hidden', 'true');
    // A limpeza espera a animação — mas se o painel for reaberto nesse meio
    // tempo, o conteúdo novo não pode ser apagado por este timeout.
    const geracao = estado.painelAberturas || 0;
    setTimeout(() => {
      if ((estado.painelAberturas || 0) === geracao) $('painel-corpo').innerHTML = '';
    }, 200);
    if (estado.atualizacaoPendente) { estado.atualizacaoPendente = false; carregar(); }
  }

  async function abrirChamado(id) {
    try {
      const r = await api('/api/chamados/' + id);
      const outro = estado.abertoId !== id;
      estado.abertoId = id;
      estado.reavaliando = false;
      if (outro) estado.fotosPendentes = null; // rascunho é de cada chamado
      // A lista de atendentes muda quando o admin cadastra alguém: recarrega
      // se estiver vazia ou se o responsável atual não estiver nela.
      if (podeAtender()) {
        const falta = r.chamado.responsavelId &&
          !estado.atendentes.some((a) => a.id === r.chamado.responsavelId);
        if (!estado.atendentes.length || falta) {
          try { estado.atendentes = (await api('/api/atendentes')).atendentes || []; }
          catch (e) { /* segue com o cache */ }
        }
      }
      desenharChamado(r.chamado);
    } catch (e) { aviso(e.message, 'erro'); }
  }

  // Miniaturas dos anexos já salvos (abrem em nova aba, autenticadas por token).
  function anexosHtml(c) {
    const lista = c.anexos || [];
    if (!lista.length) return '';
    const token = encodeURIComponent(localStorage.getItem(TOKEN_KEY) || '');
    const podeApagar = (a) => podeAtender() || a.por.id === (estado.usuario && estado.usuario.id);
    return `
      <div class="secao">Anexos (${lista.length})</div>
      <div class="anexos">
        ${lista.map((a) => {
          const url = '/api/chamados/' + encodeURIComponent(c.id) + '/anexos/' + encodeURIComponent(a.id) + '?token=' + token;
          return `<div class="anexo-mini">
            <a href="${url}" target="_blank" rel="noopener" title="Enviado por ${esc(a.por.nome)} em ${dataFmt(a.em)}">
              <img src="${url}" alt="Anexo de ${esc(a.por.nome)}" loading="lazy">
            </a>
            ${podeApagar(a) ? `<button class="anexo-x" data-anexo="${esc(a.id)}" aria-label="Remover anexo">✕</button>` : ''}
          </div>`;
        }).join('')}
      </div>`;
  }

  // Bloco de avaliação: o solicitante dá a nota; os demais só leem o resultado.
  function avaliacaoHtml(c) {
    const meu = estado.usuario && c.solicitante.id === estado.usuario.id;
    if (c.avaliacao && !estado.reavaliando) {
      // Enquanto o chamado seguir finalizado o servidor aceita uma nota nova —
      // a tela precisa oferecer isso, senão um clique errado fica para sempre.
      // O servidor limita a 3 gravações; passando disso o botão some.
      const podeTrocar = meu && c.status === 'finalizado' && (c.avaliacoesFeitas || 1) < 3;
      return `
        <div class="secao">Avaliação do atendimento</div>
        <div class="avaliacao-feita">
          <div class="aval-nota">${estrelas(c.avaliacao.nota)} <span>${c.avaliacao.nota}/5</span></div>
          ${c.avaliacao.comentario ? `<div class="coment-texto">${esc(c.avaliacao.comentario)}</div>` : ''}
          <div class="c-sub">por ${esc(c.avaliacao.por.nome)} · ${dataFmt(c.avaliacao.em)}</div>
          ${podeTrocar ? '<div class="acoes"><button class="btn btn-mini" id="d-reavaliar">Corrigir avaliação</button></div>' : ''}
        </div>`;
    }
    if (!meu || c.status !== 'finalizado') return '';
    return `
      <div class="secao">Como foi o atendimento?</div>
      <div class="avaliacao">
        <div class="c-sub" style="margin-bottom:8px">Sua nota ajuda a TI a melhorar. Leva 5 segundos.</div>
        <div class="estrelas" id="d-estrelas">
          ${[1, 2, 3, 4, 5].map((n) => `<button type="button" class="estrela" data-nota="${n}" aria-label="${n} de 5">★</button>`).join('')}
        </div>
        <div class="campo" style="margin-top:10px">
          <label>Comentário (opcional)</label>
          <textarea id="d-aval-coment" rows="2" placeholder="O que foi bom? O que dá para melhorar?"></textarea>
        </div>
        <div class="acoes"><button class="btn btn-primario" id="d-avaliar" disabled>Enviar avaliação</button></div>
      </div>`;
  }

  function desenharChamado(c) {
    // O painel é redesenhado a cada alteração (status, prioridade, anexo…).
    // Guarda o que estava escrito para devolver depois — senão a observação
    // pela metade some quando a TI mexe num select.
    const mesmoChamado = estado.abertoId === c.id;
    const rascunho = {
      coment: ($('d-novo-coment') || {}).value || '',
      motivo: ($('d-reabrir-motivo') || {}).value || '',
      aval: ($('d-aval-coment') || {}).value || '',
      // As fotos escolhidas ainda não foram enviadas: vivem só na closure de
      // ligarAnexos. Sem trazê-las de volta, some tudo ao mexer num select.
      fotos: mesmoChamado && estado.fotosPendentes ? estado.fotosPendentes() : [],
      rolagem: mesmoChamado ? $('painel-corpo').scrollTop : 0,
    };
    const corpo = abrirPainel(c.id + ' · ' + c.titulo);
    estado.abertoId = c.id;
    const s = sla(c);
    const meu = estado.usuario && c.solicitante.id === estado.usuario.id;
    const podeReabrir = c.status === 'finalizado' && (podeAtender() || meu);
    corpo.innerHTML = `
      <div class="meta">
        <span class="pill st-${c.status}">${STATUS_LABEL[c.status]}</span>
        <span class="pill pri-${c.prioridade}">${PRIO_LABEL[c.prioridade]}</span>
        ${c.urgente ? '<span class="pill pill-urgente">🚨 URGENTE</span>' : ''}
        ${s ? `<span class="pill ${s.classe}" title="${esc(s.titulo)}">${s.texto}</span>` : ''}
        <span class="num">${esc(CAT_LABEL[c.categoria] || c.categoria)}</span>
      </div>
      <div class="c-sub" style="margin-bottom:12px">
        Solicitante: <strong>${esc(c.solicitante.nome)}</strong> · aberto em ${dataFmt(c.criadoEm)}
        ${c.responsavel ? ' · responsável: <strong>' + esc(c.responsavel) + '</strong>' : ''}
        ${c.finalizadoEm ? ' · finalizado em ' + dataFmt(c.finalizadoEm) : ''}
        ${c.prazoSla ? ' · prazo de atendimento: ' + dataFmt(c.prazoSla) : ''}
        ${c.reaberturas ? ' · reaberto ' + (c.reaberturas === 1 ? '1 vez' : c.reaberturas + ' vezes') : ''}
      </div>
      ${(estado.posFila[c.id] && c.status !== 'finalizado')
        ? `<div class="minha-fila" style="margin-bottom:12px">🎫 Posição na fila de atendimento:
             <strong>${ordinal(estado.posFila[c.id].pos)}</strong> de ${estado.posFila[c.id].total} em espera —
             a ordem segue urgência, prioridade e chegada.</div>`
        : ''}
      ${c.descricao ? `<div class="desc">${esc(c.descricao)}</div>` : ''}

      ${anexosHtml(c)}

      ${podeAtender() ? `
      <div class="secao">Atendimento</div>
      <div class="campo-linha">
        <div class="campo"><label>Status</label>
          <select id="d-status">
            <option value="pendente"${c.status === 'pendente' ? ' selected' : ''}>Pendente</option>
            <option value="em_andamento"${c.status === 'em_andamento' ? ' selected' : ''}>Em andamento</option>
            <option value="finalizado"${c.status === 'finalizado' ? ' selected' : ''}>Finalizado</option>
          </select>
        </div>
        <div class="campo"><label>Prioridade</label>
          <select id="d-prio">
            <option value="baixa"${c.prioridade === 'baixa' ? ' selected' : ''}>Baixa</option>
            <option value="media"${c.prioridade === 'media' ? ' selected' : ''}>Média</option>
            <option value="alta"${c.prioridade === 'alta' ? ' selected' : ''}>Alta</option>
          </select>
        </div>
      </div>
      <div class="campo"><label>Responsável pelo atendimento</label>
        <select id="d-resp">
          <option value="">— sem responsável —</option>
          ${estado.atendentes.map((a) => {
            const sel = (c.responsavelId ? c.responsavelId === a.id : c.responsavel === a.nome);
            return `<option value="${esc(a.id)}"${sel ? ' selected' : ''}>${esc(a.nome)}</option>`;
          }).join('')}
        </select>
        ${!meuAtendimento(c) ? '<div class="acoes" style="margin-top:8px"><button class="btn btn-mini" id="d-assumir">Atribuir a mim</button></div>' : ''}
      </div>
      <label class="chk"><input type="checkbox" id="d-urgente"${c.urgente ? ' checked' : ''}> 🚨 Urgente (prioridade máxima na fila)</label>
      ` : ''}

      ${avaliacaoHtml(c)}

      ${podeReabrir ? `
      <div class="secao">O problema voltou?</div>
      <div class="reabrir">
        <div class="c-sub" style="margin-bottom:8px">${meu && !podeAtender()
          ? 'Você pode reabrir este chamado em até 7 dias da finalização, mantendo todo o histórico.'
          : 'Reabrir devolve o chamado para a fila, mantendo o histórico.'}</div>
        <div class="campo"><label>O que continua acontecendo?</label>
          <textarea id="d-reabrir-motivo" rows="2" placeholder="Ex.: o notebook voltou a desligar sozinho hoje de manhã."></textarea>
        </div>
        <div class="acoes"><button class="btn" id="d-reabrir">Reabrir chamado</button></div>
      </div>` : ''}

      <div class="secao">Observações dos colaboradores (${c.comentarios.length})</div>
      <div id="d-comentarios">
        ${c.comentarios.length ? c.comentarios.map((k) => `
          <div class="coment">
            <div class="coment-quem"><strong>${esc(k.por.nome)}</strong> · ${dataFmt(k.em)}</div>
            <div class="coment-texto">${esc(k.texto)}</div>
          </div>`).join('') : '<div class="c-sub">Nenhuma observação ainda.</div>'}
      </div>
      <div class="campo coment-form" style="margin-top:10px">
        <label>Adicionar observação (erros, falhas, atualizações…)</label>
        <textarea id="d-novo-coment" placeholder="Escreva aqui…"></textarea>
        <label class="arquivo-btn" for="d-coment-fotos">📎 Anexar foto</label>
        <input id="d-coment-fotos" class="arquivo-input" type="file" accept="image/*" multiple>
        <div class="anexos" id="d-coment-tira" hidden></div>
        <div class="acoes" style="margin-top:8px"><button class="btn btn-verde" id="d-comentar">Adicionar observação</button></div>
      </div>

      <div class="secao">Histórico (quem mudou o quê)</div>
      <div class="hist">
        ${c.historico.slice().reverse().map((h) => `
          <div class="hist-item">
            <div><strong>${esc(h.por)}</strong> — ${esc(h.acao)}${h.detalhe ? ' <span class="c-sub">' + esc(h.detalhe) + '</span>' : ''}</div>
            <div class="hist-quando">${dataFmt(h.em)}</div>
          </div>`).join('')}
      </div>
      ${estado.usuario.papel === 'admin' ? '<div class="acoes"><button class="btn" id="d-excluir" style="color:var(--perigo);border-color:var(--perigo)">Excluir chamado</button></div>' : ''}
    `;

    // Devolve o que estava sendo digitado (e a posição da rolagem).
    const repor = (id, valor) => { const el = $(id); if (el && valor) el.value = valor; };
    repor('d-novo-coment', rascunho.coment);
    repor('d-reabrir-motivo', rascunho.motivo);
    repor('d-aval-coment', rascunho.aval);
    if (rascunho.rolagem) $('painel-corpo').scrollTop = rascunho.rolagem;

    const salvar = async (body, msg) => {
      try {
        const r = await api('/api/chamados/' + c.id, { method: 'PUT', body });
        aviso(msg);
        desenharChamado(r.chamado);
        carregar();
      } catch (e) { aviso(e.message, 'erro'); }
    };
    if (podeAtender()) {
      $('d-status').addEventListener('change', () => salvar({ status: $('d-status').value }, 'Status atualizado.'));
      $('d-prio').addEventListener('change', () => salvar({ prioridade: $('d-prio').value }, 'Prioridade atualizada.'));
      $('d-urgente').addEventListener('change', () => salvar({ urgente: $('d-urgente').checked }, $('d-urgente').checked ? 'Marcado como urgente.' : 'Urgência removida.'));
      const atribuir = async (body, msg) => {
        try {
          const r = await api('/api/chamados/' + c.id + '/atribuir', { method: 'POST', body });
          aviso(msg);
          desenharChamado(r.chamado);
          carregar();
        } catch (e) { aviso(e.message, 'erro'); }
      };
      $('d-resp').addEventListener('change', () => {
        const id = $('d-resp').value;
        atribuir({ responsavelId: id || null }, id ? 'Responsável atualizado.' : 'Chamado devolvido à fila.');
      });
      const btnAssumir = $('d-assumir');
      if (btnAssumir) btnAssumir.addEventListener('click', () => atribuir({}, 'Chamado atribuído a você.'));
    }

    // Anexos já salvos: remoção.
    corpo.querySelectorAll('[data-anexo]').forEach((b) => {
      b.addEventListener('click', async () => {
        if (!confirm('Remover este anexo?')) return;
        try {
          const r = await api('/api/chamados/' + c.id + '/anexos/' + b.dataset.anexo, { method: 'DELETE' });
          aviso('Anexo removido.');
          desenharChamado(r.chamado);
          carregar();
        } catch (e) { aviso(e.message, 'erro'); }
      });
    });

    // Avaliação (só aparece para o solicitante de chamado finalizado).
    const estrelasEl = $('d-estrelas');
    if (estrelasEl) {
      let nota = 0;
      const pintar = () => estrelasEl.querySelectorAll('.estrela').forEach((e) => {
        e.classList.toggle('on', Number(e.dataset.nota) <= nota);
      });
      estrelasEl.querySelectorAll('.estrela').forEach((e) => {
        e.addEventListener('click', () => { nota = Number(e.dataset.nota); pintar(); $('d-avaliar').disabled = false; });
      });
      $('d-avaliar').addEventListener('click', async () => {
        if (!nota) return;
        try {
          const r = await api('/api/chamados/' + c.id + '/avaliacao', { method: 'POST', body: {
            nota, comentario: $('d-aval-coment').value.trim(),
          } });
          aviso('Obrigado pela avaliação!');
          estado.reavaliando = false;
          desenharChamado(r.chamado);
          carregar();
        } catch (e) { aviso(e.message, 'erro'); }
      });
    }
    const btnReav = $('d-reavaliar');
    if (btnReav) btnReav.addEventListener('click', () => { estado.reavaliando = true; desenharChamado(c); });

    // Reabertura.
    const btnReabrir = $('d-reabrir');
    if (btnReabrir) btnReabrir.addEventListener('click', async () => {
      const motivo = $('d-reabrir-motivo').value.trim();
      if (!motivo) { aviso('Diga o que continua acontecendo.', 'erro'); $('d-reabrir-motivo').focus(); return; }
      try {
        const r = await api('/api/chamados/' + c.id + '/reabrir', { method: 'POST', body: { motivo } });
        aviso('Chamado reaberto — a TI foi avisada.');
        desenharChamado(r.chamado);
        carregar();
      } catch (e) { aviso(e.message, 'erro'); }
    });

    const pegarFotos = ligarAnexos('d-coment-fotos', 'd-coment-tira', rascunho.fotos);
    estado.fotosPendentes = pegarFotos;
    $('d-comentar').addEventListener('click', async () => {
      const texto = $('d-novo-coment').value.trim();
      const fotos = pegarFotos();
      if (!texto) { aviso('Escreva a observação.', 'erro'); return; }
      const btn = $('d-comentar');
      btn.disabled = true;
      try {
        const r = await api('/api/chamados/' + c.id + '/comentarios', { method: 'POST', body: { texto, anexos: fotos } });
        aviso('Observação adicionada.');
        $('d-novo-coment').value = '';   // enviada: some do rascunho
        estado.fotosPendentes = null;
        desenharChamado(r.chamado);
        carregar();
      } catch (e) { btn.disabled = false; aviso(e.message, 'erro'); }
    });
    const btnExcluir = $('d-excluir');
    if (btnExcluir) btnExcluir.addEventListener('click', async () => {
      if (!confirm('Excluir o chamado ' + c.id + '? Esta ação não pode ser desfeita.')) return;
      try { await api('/api/chamados/' + c.id, { method: 'DELETE' }); aviso('Chamado excluído.'); fecharPainel(); carregar(); }
      catch (e) { aviso(e.message, 'erro'); }
    });
  }

  // ---------------------------------------------------------------------------
  // Novo chamado.
  // ---------------------------------------------------------------------------
  function novoChamado() {
    const corpo = abrirPainel('Novo chamado');
    corpo.innerHTML = `
      <div class="campo"><label>Título *</label><input id="n-titulo" maxlength="140" placeholder="Ex.: Notebook não liga"></div>
      <!-- Sugestões da base de conhecimento conforme o título é digitado:
           muita coisa se resolve sem abrir chamado. -->
      <div class="kb-sugestoes" id="n-sugestoes" hidden></div>
      <div class="campo"><label>Descrição</label><textarea id="n-desc" rows="4" placeholder="Detalhe o problema ou pedido…"></textarea></div>
      <div class="campo">
        <label>Fotos (opcional)</label>
        <!-- Sem o atributo capture: a foto do erro quase sempre já é um print
             ou está na galeria. Sem ele o celular oferece as duas opções. -->
        <label class="arquivo-btn" for="n-fotos">📷 Anexar foto do erro ou do equipamento</label>
        <input id="n-fotos" class="arquivo-input" type="file" accept="image/*" multiple>
        <div class="anexos" id="n-tira" hidden></div>
      </div>
      <div class="campo-linha">
        <div class="campo"><label>Categoria</label>
          <select id="n-cat">
            <option value="sistema">Sistema / software</option>
            <option value="equipamento">Equipamento</option>
            <option value="rede">Rede / internet</option>
            <option value="acesso">Acesso / senha</option>
            <option value="impressora">Impressora</option>
            <option value="outro" selected>Outro</option>
          </select>
        </div>
        <div class="campo"><label>Prioridade</label>
          <select id="n-prio">
            <option value="baixa">Baixa</option>
            <option value="media" selected>Média</option>
            <option value="alta">Alta</option>
          </select>
        </div>
      </div>
      <div class="sla-aviso" id="n-sla">⏱ Prazo de atendimento previsto: <strong>3 dias</strong>.</div>
      <label class="chk"><input type="checkbox" id="n-urgente"> 🚨 Urgente — parou o trabalho, preciso agora</label>
      <div class="acoes">
        <button class="btn" id="n-cancelar">Cancelar</button>
        <button class="btn btn-primario" id="n-salvar">Abrir chamado</button>
      </div>`;

    // Prazo previsto conforme prioridade/urgência (espelha SLA_HORAS do servidor).
    const SLA_TXT = { urgente: '4 horas', alta: '1 dia', media: '3 dias', baixa: '5 dias' };
    const atualizarSla = () => {
      const chave = $('n-urgente').checked ? 'urgente' : $('n-prio').value;
      $('n-sla').innerHTML = '⏱ Prazo de atendimento previsto: <strong>' + SLA_TXT[chave] + '</strong>.';
    };
    $('n-prio').addEventListener('change', atualizarSla);
    $('n-urgente').addEventListener('change', atualizarSla);
    atualizarSla();

    // Sugestões da base de conhecimento (busca no servidor, com atraso).
    let debKb;
    $('n-titulo').addEventListener('input', () => {
      clearTimeout(debKb);
      debKb = setTimeout(async () => {
        const termo = $('n-titulo').value.trim();
        const el = $('n-sugestoes');
        if (termo.length < 4) { el.hidden = true; el.innerHTML = ''; return; }
        try {
          const r = await api('/api/artigos?busca=' + encodeURIComponent(termo));
          const lista = (r.artigos || []).slice(0, 3);
          if (!lista.length) { el.hidden = true; el.innerHTML = ''; return; }
          el.hidden = false;
          el.innerHTML = '<div class="kb-titulo">💡 Talvez resolva sem abrir chamado:</div>' +
            lista.map((a) => `
              <button type="button" class="kb-item" data-kb="${esc(a.id)}" aria-expanded="false">${esc(a.titulo)}</button>
              <div class="kb-corpo" id="kb-corpo-${esc(a.id)}" hidden>${esc(a.conteudo)}</div>`).join('');
          // Abre o artigo AQUI DENTRO. Trocar para o painel de detalhe
          // apagaria o formulário que a pessoa já começou a preencher.
          el.querySelectorAll('[data-kb]').forEach((b) => {
            b.addEventListener('click', () => {
              const corpo = $('kb-corpo-' + b.dataset.kb);
              const abrindo = corpo.hidden;
              corpo.hidden = !abrindo;
              b.setAttribute('aria-expanded', String(abrindo));
              b.classList.toggle('aberto', abrindo);
              // Conta a leitura só na primeira abertura.
              if (abrindo && !b.dataset.lido) {
                b.dataset.lido = '1';
                api('/api/artigos/' + b.dataset.kb).catch(() => { /* contador é secundário */ });
              }
            });
          });
        } catch (e) { /* sugestão é um extra: falha em silêncio */ }
      }, 350);
    });

    const pegarFotos = ligarAnexos('n-fotos', 'n-tira');
    $('n-cancelar').addEventListener('click', fecharPainel);
    $('n-salvar').addEventListener('click', async () => {
      const titulo = $('n-titulo').value.trim();
      if (!titulo) { aviso('Informe o título.', 'erro'); $('n-titulo').focus(); return; }
      const btn = $('n-salvar');
      btn.disabled = true;
      try {
        await api('/api/chamados', { method: 'POST', body: {
          titulo,
          descricao: $('n-desc').value.trim(),
          categoria: $('n-cat').value,
          prioridade: $('n-prio').value,
          urgente: $('n-urgente').checked,
          anexos: pegarFotos(),
        } });
        aviso('Chamado aberto.');
        fecharPainel();
        carregar();
      } catch (e) { btn.disabled = false; aviso(e.message, 'erro'); }
    });
    $('n-titulo').focus();
  }

  // ---------------------------------------------------------------------------
  // Notificações (sino) — para TI/admin.
  // ---------------------------------------------------------------------------
  async function atualizarSino() {
    try {
      const r = await api('/api/notificacoes/pendentes');
      const n = (r.notificacoes || []).length;
      $('sino-c').hidden = n === 0;
      $('sino-c').textContent = n;
    } catch (e) { /* sem notificações visíveis — ignora */ }
  }

  async function abrirNotificacoes() {
    let r;
    try { r = await api('/api/notificacoes'); }
    catch (e) { aviso(e.message, 'erro'); return; }
    const corpo = abrirPainel('Notificações');
    const lista = r.notificacoes || [];
    const pendentes = lista.filter((n) => !n.reconhecidaPor).length;
    corpo.innerHTML = (pendentes > 1
      ? `<div class="acoes" style="margin:0 0 12px"><button class="btn btn-mini" id="n-todas">Marcar as ${pendentes} como vistas</button></div>`
      : '') + (lista.length ? lista.map((n) => `
      <div class="coment">
        <div class="coment-quem"><strong>${esc(n.titulo)}</strong> · ${dataFmt(n.em)}</div>
        <div class="coment-texto">${esc(n.mensagem)}</div>
        <div class="acoes" style="margin-top:8px">
          <button class="btn btn-mini" data-abrir="${esc(n.chamadoId)}">Abrir chamado</button>
          ${n.reconhecidaPor
            ? '<span class="c-sub">vista por ' + esc(n.reconhecidaPor.nome) + '</span>'
            : '<button class="btn btn-verde btn-mini" data-visto="' + esc(n.id) + '">Marcar como vista</button>'}
        </div>
      </div>`).join('') : '<div class="vazio">Nenhuma notificação.</div>');
    const btnTodas = $('n-todas');
    if (btnTodas) btnTodas.addEventListener('click', async () => {
      try { await api('/api/notificacoes/reconhecer-todas', { method: 'POST' }); abrirNotificacoes(); atualizarSino(); }
      catch (e) { aviso(e.message, 'erro'); }
    });
    corpo.querySelectorAll('[data-visto]').forEach((b) => {
      b.addEventListener('click', async () => {
        try { await api('/api/notificacoes/' + b.dataset.visto + '/reconhecer', { method: 'POST' }); abrirNotificacoes(); atualizarSino(); }
        catch (e) { aviso(e.message, 'erro'); }
      });
    });
    corpo.querySelectorAll('[data-abrir]').forEach((b) => {
      b.addEventListener('click', () => abrirChamado(b.dataset.abrir));
    });
  }

  // ---------------------------------------------------------------------------
  // Usuários (admin).
  // ---------------------------------------------------------------------------
  async function abrirUsuarios() {
    let r;
    try { r = await api('/api/usuarios'); }
    catch (e) { aviso(e.message, 'erro'); return; }
    const corpo = abrirPainel('Usuários');
    corpo.innerHTML = `
      ${r.usuarios.map((u) => `
        <div class="coment">
          <div class="coment-quem"><strong>${esc(u.nome)}</strong> · <span class="num">${esc(u.login)}</span> · ${esc(u.papel)}${u.lider ? ' · <span class="pill pill-lider">⭐ líder</span>' : ''}</div>
          <div class="c-sub">${u.email ? '✉ ' + esc(u.email) : '✉ sem e-mail'}${u.celular ? ' · 📱 ' + esc(u.celular) : ''}</div>
          <div class="acoes" style="margin-top:6px">
            <button class="btn btn-mini" data-contato="${esc(u.id)}">Contatos</button>
            <button class="btn btn-mini" data-senha="${esc(u.id)}">Trocar senha</button>
            <button class="btn btn-mini" data-lider="${esc(u.id)}" data-lider-v="${u.lider ? '0' : '1'}">${u.lider ? 'Remover líder' : 'Tornar líder'}</button>
            <button class="btn btn-mini" data-remover="${esc(u.id)}" style="color:var(--perigo)">Remover</button>
          </div>
        </div>`).join('')}
      <div class="secao">Novo usuário</div>
      <div class="campo"><label>Nome</label><input id="u-nome"></div>
      <div class="campo-linha">
        <div class="campo"><label>Login</label><input id="u-login" autocapitalize="none"></div>
        <div class="campo"><label>Senha (mín. 6)</label><input id="u-senha" type="password"></div>
      </div>
      <div class="campo-linha">
        <div class="campo"><label>E-mail (avisos)</label><input id="u-email" type="email" autocapitalize="none" placeholder="nome@empresa.com.br"></div>
        <div class="campo"><label>Celular (WhatsApp)</label><input id="u-celular" placeholder="(11) 90000-0000"></div>
      </div>
      <div class="campo"><label>Papel</label>
        <select id="u-papel">
          <option value="solicitante" selected>Solicitante (abre chamados)</option>
          <option value="ti">TI (atende e recebe notificações)</option>
          <option value="admin">Admin</option>
        </select>
      </div>
      <label class="chk chk-termo"><input type="checkbox" id="u-lider"> <span>⭐ Líder (registra saídas para Home Office)</span></label>
      <div class="acoes"><button class="btn btn-verde" id="u-criar">Cadastrar usuário</button></div>`;
    $('u-criar').addEventListener('click', async () => {
      try {
        await api('/api/usuarios', { method: 'POST', body: {
          nome: $('u-nome').value.trim(), login: $('u-login').value.trim(),
          senha: $('u-senha').value, papel: $('u-papel').value,
          lider: $('u-lider').checked,
          email: $('u-email').value.trim(), celular: $('u-celular').value.trim(),
        } });
        aviso('Usuário cadastrado.');
        abrirUsuarios();
      } catch (e) { aviso(e.message, 'erro'); }
    });
    corpo.querySelectorAll('[data-contato]').forEach((b) => {
      b.addEventListener('click', async () => {
        const u = r.usuarios.find((x) => x.id === b.dataset.contato);
        const email = prompt('E-mail de ' + u.nome + ' (vazio para remover):', u.email || '');
        if (email === null) return;
        const celular = prompt('Celular/WhatsApp de ' + u.nome + ' (vazio para remover):', u.celular || '');
        if (celular === null) return;
        try {
          await api('/api/usuarios/' + u.id, { method: 'PUT', body: { email: email.trim(), celular: celular.trim() } });
          aviso('Contatos atualizados.');
          abrirUsuarios();
        } catch (e) { aviso(e.message, 'erro'); }
      });
    });
    corpo.querySelectorAll('[data-lider]').forEach((b) => {
      b.addEventListener('click', async () => {
        try {
          await api('/api/usuarios/' + b.dataset.lider, { method: 'PUT', body: { lider: b.dataset.liderV === '1' } });
          aviso(b.dataset.liderV === '1' ? 'Usuário agora é líder.' : 'Usuário deixou de ser líder.');
          abrirUsuarios();
        } catch (e) { aviso(e.message, 'erro'); }
      });
    });
    corpo.querySelectorAll('[data-senha]').forEach((b) => {
      b.addEventListener('click', async () => {
        const nova = prompt('Nova senha (mínimo 6 caracteres):');
        if (!nova) return;
        try { await api('/api/usuarios/' + b.dataset.senha, { method: 'PUT', body: { novaSenha: nova } }); aviso('Senha alterada.'); }
        catch (e) { aviso(e.message, 'erro'); }
      });
    });
    corpo.querySelectorAll('[data-remover]').forEach((b) => {
      b.addEventListener('click', async () => {
        if (!confirm('Remover este usuário?')) return;
        try { await api('/api/usuarios/' + b.dataset.remover, { method: 'DELETE' }); aviso('Usuário removido.'); abrirUsuarios(); }
        catch (e) { aviso(e.message, 'erro'); }
      });
    });
  }

  // ---------------------------------------------------------------------------
  // Tempo real.
  // ---------------------------------------------------------------------------
  function conectarSSE() {
    if (estado.sse || typeof EventSource === 'undefined') return;
    const token = localStorage.getItem(TOKEN_KEY) || '';
    estado.sse = new EventSource('/api/events?token=' + encodeURIComponent(token));
    estado.sse.addEventListener('message', () => {
      const digitando = document.activeElement &&
        (document.activeElement.tagName === 'TEXTAREA' || document.activeElement.tagName === 'INPUT');
      const painelAberto = $('painel').classList.contains('aberto');
      if (digitando || painelAberto) { estado.atualizacaoPendente = true; return; }
      carregar();
    });
  }
  function desconectarSSE() {
    if (estado.sse) { try { estado.sse.close(); } catch (e) { /* ignore */ } estado.sse = null; }
  }
  // Rede de segurança: mesmo sem SSE, atualiza a cada 60 s (fora de digitação).
  setInterval(() => {
    if (!estado.usuario) return;
    const digitando = document.activeElement &&
      (document.activeElement.tagName === 'TEXTAREA' || document.activeElement.tagName === 'INPUT');
    if (!digitando && !$('painel').classList.contains('aberto')) carregar();
  }, 60000);

  // ---------------------------------------------------------------------------
  // Sessão.
  // ---------------------------------------------------------------------------
  function sair(silencioso) {
    if (!silencioso) api('/api/auth/logout', { method: 'POST' }).catch(() => { /* ignore */ });
    localStorage.removeItem(TOKEN_KEY);
    desconectarSSE();
    estado.usuario = null;
    // Zera o que é do usuário que saiu: o filtro "Meus atendimentos" ficaria
    // ativo (e escondido) para um solicitante, mostrando uma lista vazia.
    estado.filtro = 'fila';
    estado.busca = '';
    estado.aba = 'chamados';
    estado.chamados = [];
    estado.homeoffice = [];
    estado.atendentes = [];
    estado.artigos = [];
    estado.buscaKb = '';
    $('busca').value = '';
    $('seg-status').querySelectorAll('.seg-btn').forEach((b) => b.classList.toggle('active', b.dataset.f === 'fila'));
    // O esqueleto da Ajuda tem botões que dependem do papel: remonta no próximo login.
    $('ajuda-conteudo').innerHTML = '';
    $('painel-conteudo').innerHTML = '';
    fecharPainel();
    $('app').hidden = true;
    $('login').hidden = false;
    $('lg-senha').value = '';
  }

  async function entrarNoApp(usuario) {
    estado.usuario = usuario;
    $('quem-nome').textContent = usuario.nome + (usuario.lider ? ' ⭐' : '');
    $('btn-usuarios').hidden = usuario.papel !== 'admin';
    $('btn-sino').style.display = ''; // todos têm sino (avisos do próprio chamado)
    $('aba-btn-ho').hidden = !gestorHO();
    const navHo = $('nav-btn-ho');
    if (navHo) navHo.hidden = !gestorHO();
    // Painel de indicadores: quem atende (TI/admin) e líderes acompanham.
    const verPainel = podeAtender() || gestorHO();
    $('aba-btn-painel').hidden = !verPainel;
    const navPainel = $('nav-btn-painel');
    if (navPainel) navPainel.hidden = !verPainel;
    if (podeAtender()) {
      try { estado.atendentes = (await api('/api/atendentes')).atendentes || []; }
      catch (e) { estado.atendentes = []; }
    }
    trocarAba('chamados');
    $('login').hidden = true;
    $('app').hidden = false;
    conectarSSE();
    await carregar();
  }

  async function tentarLogin() {
    const login = $('lg-login').value.trim();
    const senha = $('lg-senha').value;
    const erroEl = $('lg-erro');
    if (!login || !senha) { erroEl.textContent = 'Informe login e senha.'; erroEl.hidden = false; return; }
    try {
      const r = await api('/api/auth/login', { method: 'POST', body: { login, senha } });
      localStorage.setItem(TOKEN_KEY, r.token);
      erroEl.hidden = true;
      await entrarNoApp(r.usuario);
    } catch (e) {
      erroEl.textContent = e.message;
      erroEl.hidden = false;
    }
  }

  // ---------------------------------------------------------------------------
  // Inicialização.
  // ---------------------------------------------------------------------------
  document.addEventListener('DOMContentLoaded', async () => {
    $('btn-novo').addEventListener('click', novoChamado);
    $('btn-novo-fab').addEventListener('click', novoChamado);
    $('btn-sair').addEventListener('click', () => sair(false));
    $('btn-sino').addEventListener('click', abrirNotificacoes);
    $('btn-usuarios').addEventListener('click', abrirUsuarios);
    $('painel-fechar').addEventListener('click', fecharPainel);
    $('painel-fundo').addEventListener('click', fecharPainel);
    $('abas').querySelectorAll('.aba-btn').forEach((b) => {
      b.addEventListener('click', () => trocarAba(b.dataset.aba));
    });
    document.querySelectorAll('.bn-item').forEach((b) => {
      b.addEventListener('click', () => trocarAba(b.dataset.aba));
    });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') fecharPainel(); });
    $('lg-entrar').addEventListener('click', tentarLogin);
    ['lg-login', 'lg-senha'].forEach((id) => $(id).addEventListener('keydown', (e) => { if (e.key === 'Enter') tentarLogin(); }));
    $('seg-status').querySelectorAll('.seg-btn').forEach((b) => {
      b.addEventListener('click', () => {
        estado.filtro = b.dataset.f;
        $('seg-status').querySelectorAll('.seg-btn').forEach((x) => x.classList.toggle('active', x === b));
        desenharLista();
      });
    });
    let deb;
    $('busca').addEventListener('input', () => {
      clearTimeout(deb);
      deb = setTimeout(() => { estado.busca = $('busca').value.trim(); desenharLista(); }, 200);
    });

    // Sessão salva?
    if (localStorage.getItem(TOKEN_KEY)) {
      try {
        const r = await api('/api/me');
        await entrarNoApp(r.usuario);
        return;
      } catch (e) { localStorage.removeItem(TOKEN_KEY); }
    }
    $('login').hidden = false;
  });
})();
