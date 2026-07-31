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
    aba: 'chamados',     // 'chamados' | 'homeoffice' | 'devolucao'
    homeoffice: [],      // registros visíveis ao usuário
    colaboradores: [],   // nomes para o líder escolher
    abertoId: null,      // chamado aberto no painel
    sse: null,
    atualizacaoPendente: false,
  };

  const STATUS_LABEL = { pendente: 'Pendente', em_andamento: 'Em andamento', finalizado: 'Finalizado' };
  const PRIO_LABEL = { baixa: 'Baixa', media: 'Média', alta: 'Alta' };
  const PRIO_PESO = { alta: 3, media: 2, baixa: 1 };
  const CAT_LABEL = { sistema: 'Sistema / software', equipamento: 'Equipamento', rede: 'Rede / internet', acesso: 'Acesso / senha', impressora: 'Impressora', outro: 'Outro' };

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

  function filtrar() {
    let lista = estado.chamados;
    if (estado.filtro === 'fila') lista = lista.filter((c) => c.status !== 'finalizado');
    else if (estado.filtro !== 'todos') lista = lista.filter((c) => c.status === estado.filtro);
    if (estado.busca) {
      const t = estado.busca.toLowerCase();
      const hit = (v) => v != null && String(v).toLowerCase().includes(t);
      lista = lista.filter((c) => hit(c.id) || hit(c.titulo) || hit(c.descricao) || hit(c.solicitante.nome) || hit(c.responsavel) || hit(CAT_LABEL[c.categoria]));
    }
    return ordenar(lista, estado.filtro);
  }

  function cartao(c) {
    // Cartão do design Stitch: nº em mono discreta, título semibold, meta
    // (solicitante · setor · idade), pill de prioridade e status como pill
    // colorida (select estilizado, mantém a troca rápida de status).
    return `
      <div class="cartao${c.urgente && c.status !== 'finalizado' ? ' urgente' : ''}" data-id="${c.id}">
        <div class="c-info">
          <div class="c-topo">
            <span class="num">${esc(c.id)}</span>
            ${c.urgente ? '<span class="pill pill-urgente">🚨 Urgente</span>' : ''}
            <span class="c-idade">aberto ${diasDesde(c.criadoEm)}</span>
          </div>
          <div class="c-titulo">${esc(c.titulo)}</div>
          <div class="c-sub">
            ${esc(c.solicitante.nome)} · ${esc(CAT_LABEL[c.categoria] || c.categoria)}
            ${c.responsavel ? ' · atendido por ' + esc(c.responsavel) : ''}
          </div>
        </div>
        <div class="c-lado">
          <span class="c-coment" title="Observações">💬 ${c.comentarios.length}</span>
          <span class="pill pri-${c.prioridade}">${c.prioridade === 'alta' ? '▲' : c.prioridade === 'media' ? '■' : '▼'} ${PRIO_LABEL[c.prioridade]}</span>
          <select class="status-sel st-${c.status}" data-status="${c.id}">
            <option value="pendente"${c.status === 'pendente' ? ' selected' : ''}>Pendente</option>
            <option value="em_andamento"${c.status === 'em_andamento' ? ' selected' : ''}>Em andamento</option>
            <option value="finalizado"${c.status === 'finalizado' ? ' selected' : ''}>Finalizado</option>
          </select>
        </div>
      </div>`;
  }

  function desenharLista() {
    const lista = filtrar();
    const n = (f) => estado.chamados.filter((c) => f === 'todos' ? true : f === 'fila' ? c.status !== 'finalizado' : c.status === f).length;
    $('c-fila').textContent = n('fila');
    $('c-pend').textContent = n('pendente');
    $('c-and').textContent = n('em_andamento');
    $('c-fin').textContent = n('finalizado');
    $('c-tod').textContent = n('todos');
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
    if (estado.usuario && estado.usuario.papel !== 'solicitante') atualizarSino();
    carregarHomeOffice().catch(() => { /* aba segue com os dados anteriores */ });
  }

  // ---------------------------------------------------------------------------
  // Home Office — líderes registram a saída; o colaborador informa a devolução.
  // ---------------------------------------------------------------------------
  function gestorHO() {
    const u = estado.usuario;
    return !!u && (u.papel === 'ti' || u.papel === 'admin' || u.lider);
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

  async function carregarHomeOffice() {
    if (!estado.usuario) return;
    const r = await api('/api/homeoffice');
    estado.homeoffice = r.registros || [];
    if (gestorHO() && !estado.colaboradores.length) {
      try { estado.colaboradores = (await api('/api/homeoffice/colaboradores')).colaboradores || []; }
      catch (e) { /* sem lista, o campo aceita texto livre */ }
    }
    const emUso = estado.homeoffice.filter((x) => x.status === 'em_uso');
    $('c-ho').textContent = emUso.length;
    $('c-dev').textContent = meusHO().filter((x) => x.status === 'em_uso').length;
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
          <div class="c-sub">Itens: ${esc(r.itens.join(', '))}</div>
          <div class="c-sub">Levado em ${dataCurta(r.dataLevada)} · devolver até <strong>${dataCurta(r.prazoDevolucao)}</strong> · registrado por ${esc(r.registradoPor.nome)}</div>
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
        <div class="secao" style="margin-top:0">Registrar saída para Home Office</div>
        <div class="campo"><label>Colaborador</label>
          <input id="ho-colab" list="ho-colabs" placeholder="Digite o nome ou escolha na lista…" autocomplete="off">
          <datalist id="ho-colabs">${estado.colaboradores.map((c) => `<option value="${esc(c.nome)}">`).join('')}</datalist>
        </div>
        <div class="campo"><label>Itens levados (um por linha)</label>
          <textarea id="ho-itens" rows="3" placeholder="Ex.:&#10;Notebook Dell + carregador&#10;Monitor 24&quot;"></textarea>
        </div>
        <div class="campo-linha">
          <div class="campo"><label>Data em que está levando</label><input id="ho-data" type="date" value="${hojeISO()}"></div>
          <div class="campo"><label>Prazo de devolução (automático)</label><input id="ho-prazo" disabled></div>
        </div>
        <div class="acoes"><button class="btn btn-verde" id="ho-registrar">Registrar Home Office</button></div>
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
    $('ho-registrar').addEventListener('click', async () => {
      const nome = $('ho-colab').value.trim();
      const itens = $('ho-itens').value;
      if (!nome) { aviso('Informe o colaborador.', 'erro'); $('ho-colab').focus(); return; }
      if (!itens.trim()) { aviso('Informe os itens levados.', 'erro'); $('ho-itens').focus(); return; }
      const conhecido = estado.colaboradores.find((c) => c.nome.toLowerCase() === nome.toLowerCase());
      try {
        await api('/api/homeoffice', { method: 'POST', body: {
          colaboradorId: conhecido ? conhecido.id : undefined,
          colaboradorNome: nome,
          itens,
          dataLevada: $('ho-data').value,
        } });
        aviso('Home Office registrado — devolução em até 3 dias.');
        $('ho-colab').value = ''; $('ho-itens').value = '';
        await carregarHomeOffice();
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
      <div class="desc" style="margin-bottom:16px">Aqui aparecem os equipamentos registrados no seu nome para Home Office.
      Ao devolver, clique em <strong>Informar devolução</strong>, anexe uma foto dos aparelhos e confirme — um chamado é aberto para a TI conferir.</div>
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
      <div class="desc">Itens levados em ${dataCurta(r.dataLevada)}:<br>• ${r.itens.map(esc).join('<br>• ')}</div>
      <div class="campo" style="margin-top:12px"><label>Foto dos aparelhos devolvidos *</label>
        <input id="dv-foto" type="file" accept="image/*" capture="environment">
      </div>
      <img id="dv-preview" class="ho-preview" alt="" hidden>
      <div class="campo"><label>Observação (opcional)</label>
        <textarea id="dv-obs" rows="3" placeholder="Ex.: devolvido completo, sem avarias…"></textarea>
      </div>
      <div class="acoes">
        <button class="btn" id="dv-cancelar">Cancelar</button>
        <button class="btn btn-verde" id="dv-enviar">Confirmar devolução</button>
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
    $('aba-chamados').hidden = aba !== 'chamados';
    $('aba-homeoffice').hidden = aba !== 'homeoffice';
    $('aba-devolucao').hidden = aba !== 'devolucao';
    if (aba === 'homeoffice') desenharHomeOffice();
    if (aba === 'devolucao') desenharDevolucao();
  }

  // ---------------------------------------------------------------------------
  // Painel lateral.
  // ---------------------------------------------------------------------------
  function abrirPainel(titulo) {
    $('painel-titulo').textContent = titulo;
    $('painel-fundo').hidden = false;
    $('painel').classList.add('aberto');
    $('painel').setAttribute('aria-hidden', 'false');
    return $('painel-corpo');
  }
  function fecharPainel() {
    estado.abertoId = null;
    $('painel-fundo').hidden = true;
    $('painel').classList.remove('aberto');
    $('painel').setAttribute('aria-hidden', 'true');
    setTimeout(() => { $('painel-corpo').innerHTML = ''; }, 200);
    if (estado.atualizacaoPendente) { estado.atualizacaoPendente = false; carregar(); }
  }

  async function abrirChamado(id) {
    const r = await api('/api/chamados/' + id);
    estado.abertoId = id;
    desenharChamado(r.chamado);
  }

  function desenharChamado(c) {
    const corpo = abrirPainel(c.id + ' · ' + c.titulo);
    corpo.innerHTML = `
      <div class="meta">
        <span class="pill st-${c.status}">${STATUS_LABEL[c.status]}</span>
        <span class="pill pri-${c.prioridade}">${PRIO_LABEL[c.prioridade]}</span>
        ${c.urgente ? '<span class="pill pill-urgente">🚨 URGENTE</span>' : ''}
        <span class="num">${esc(CAT_LABEL[c.categoria] || c.categoria)}</span>
      </div>
      <div class="c-sub" style="margin-bottom:12px">
        Solicitante: <strong>${esc(c.solicitante.nome)}</strong> · aberto em ${dataFmt(c.criadoEm)}
        ${c.responsavel ? ' · responsável: <strong>' + esc(c.responsavel) + '</strong>' : ''}
        ${c.finalizadoEm ? ' · finalizado em ' + dataFmt(c.finalizadoEm) : ''}
      </div>
      ${c.descricao ? `<div class="desc">${esc(c.descricao)}</div>` : ''}

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
      <label class="chk"><input type="checkbox" id="d-urgente"${c.urgente ? ' checked' : ''}> 🚨 Urgente (prioridade máxima na fila)</label>

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

    const salvar = async (body, msg) => {
      try {
        const r = await api('/api/chamados/' + c.id, { method: 'PUT', body });
        aviso(msg);
        desenharChamado(r.chamado);
        carregar();
      } catch (e) { aviso(e.message, 'erro'); }
    };
    $('d-status').addEventListener('change', () => salvar({ status: $('d-status').value }, 'Status atualizado.'));
    $('d-prio').addEventListener('change', () => salvar({ prioridade: $('d-prio').value }, 'Prioridade atualizada.'));
    $('d-urgente').addEventListener('change', () => salvar({ urgente: $('d-urgente').checked }, $('d-urgente').checked ? 'Marcado como urgente.' : 'Urgência removida.'));
    $('d-comentar').addEventListener('click', async () => {
      const texto = $('d-novo-coment').value.trim();
      if (!texto) { aviso('Escreva a observação.', 'erro'); return; }
      try {
        const r = await api('/api/chamados/' + c.id + '/comentarios', { method: 'POST', body: { texto } });
        aviso('Observação adicionada.');
        desenharChamado(r.chamado);
        carregar();
      } catch (e) { aviso(e.message, 'erro'); }
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
      <div class="campo"><label>Descrição</label><textarea id="n-desc" rows="4" placeholder="Detalhe o problema ou pedido…"></textarea></div>
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
      <label class="chk"><input type="checkbox" id="n-urgente"> 🚨 Urgente — parou o trabalho, preciso agora</label>
      <div class="acoes">
        <button class="btn" id="n-cancelar">Cancelar</button>
        <button class="btn btn-verde" id="n-salvar">Abrir chamado</button>
      </div>`;
    $('n-cancelar').addEventListener('click', fecharPainel);
    $('n-salvar').addEventListener('click', async () => {
      const titulo = $('n-titulo').value.trim();
      if (!titulo) { aviso('Informe o título.', 'erro'); $('n-titulo').focus(); return; }
      try {
        await api('/api/chamados', { method: 'POST', body: {
          titulo,
          descricao: $('n-desc').value.trim(),
          categoria: $('n-cat').value,
          prioridade: $('n-prio').value,
          urgente: $('n-urgente').checked,
        } });
        aviso('Chamado aberto.');
        fecharPainel();
        carregar();
      } catch (e) { aviso(e.message, 'erro'); }
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
    } catch (e) { /* solicitante não tem acesso — ignora */ }
  }

  async function abrirNotificacoes() {
    let r;
    try { r = await api('/api/notificacoes'); }
    catch (e) { aviso(e.message, 'erro'); return; }
    const corpo = abrirPainel('Notificações');
    const lista = r.notificacoes || [];
    corpo.innerHTML = lista.length ? lista.map((n) => `
      <div class="coment">
        <div class="coment-quem"><strong>${esc(n.titulo)}</strong> · ${dataFmt(n.em)}</div>
        <div class="coment-texto">${esc(n.mensagem)}</div>
        <div class="acoes" style="margin-top:8px">
          <button class="btn btn-mini" data-abrir="${esc(n.chamadoId)}">Abrir chamado</button>
          ${n.reconhecidaPor
            ? '<span class="c-sub">vista por ' + esc(n.reconhecidaPor.nome) + '</span>'
            : '<button class="btn btn-verde btn-mini" data-visto="' + esc(n.id) + '">Marcar como vista</button>'}
        </div>
      </div>`).join('') : '<div class="vazio">Nenhuma notificação.</div>';
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
          <div class="acoes" style="margin-top:6px">
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
      <div class="campo"><label>Papel</label>
        <select id="u-papel">
          <option value="solicitante" selected>Solicitante (abre chamados)</option>
          <option value="ti">TI (atende e recebe notificações)</option>
          <option value="admin">Admin</option>
        </select>
      </div>
      <label class="chk"><input type="checkbox" id="u-lider"> ⭐ Líder (registra saídas para Home Office)</label>
      <div class="acoes"><button class="btn btn-verde" id="u-criar">Cadastrar usuário</button></div>`;
    $('u-criar').addEventListener('click', async () => {
      try {
        await api('/api/usuarios', { method: 'POST', body: {
          nome: $('u-nome').value.trim(), login: $('u-login').value.trim(),
          senha: $('u-senha').value, papel: $('u-papel').value,
          lider: $('u-lider').checked,
        } });
        aviso('Usuário cadastrado.');
        abrirUsuarios();
      } catch (e) { aviso(e.message, 'erro'); }
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
    $('app').hidden = true;
    $('login').hidden = false;
    $('lg-senha').value = '';
  }

  async function entrarNoApp(usuario) {
    estado.usuario = usuario;
    $('quem-nome').textContent = usuario.nome + (usuario.lider ? ' ⭐' : '');
    $('btn-usuarios').hidden = usuario.papel !== 'admin';
    $('btn-sino').style.display = usuario.papel === 'solicitante' ? 'none' : '';
    $('aba-btn-ho').hidden = !gestorHO();
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
    $('btn-sair').addEventListener('click', () => sair(false));
    $('btn-sino').addEventListener('click', abrirNotificacoes);
    $('btn-usuarios').addEventListener('click', abrirUsuarios);
    $('painel-fechar').addEventListener('click', fecharPainel);
    $('painel-fundo').addEventListener('click', fecharPainel);
    $('abas').querySelectorAll('.aba-btn').forEach((b) => {
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
