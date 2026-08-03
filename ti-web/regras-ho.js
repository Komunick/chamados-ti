'use strict';
/*
 * Chamados de TI — regras dos itens levados para Home Office.
 * ---------------------------------------------------------------------------
 * O MESMO arquivo roda dos dois lados: o navegador carrega por <script> (expõe
 * window.RegrasHO) e o servidor faz require('../regras-ho.js'). Assim a
 * conferência que o líder vê na tela e a que o servidor aplica nunca divergem —
 * a da tela é conveniência, a do servidor é a que vale.
 *
 * Regras da Brazil Transports para o Home Office:
 *   1. Monitor não sai da empresa — em nenhuma hipótese.
 *   2. Celular só pode ser levado por líder.
 *   3. Só pode sair o que estiver escrito no chamado.
 */
(function (raiz, fabrica) {
  const api = fabrica();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else raiz.RegrasHO = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  // Texto curto das regras — aparece na tela, no corpo do chamado e no termo
  // que o líder aceita. Uma fonte só, para não escrever a regra em dois lugares.
  const REGRAS = [
    'É proibido levar monitor de qualquer tipo, marca ou tamanho — em nenhuma hipótese.',
    'Celular só pode ser levado por líder.',
    'É proibido levar qualquer item que não esteja citado neste chamado.',
  ];

  // Compara sem acento, sem caixa e sem pontuação: 'Monitor 24"' → 'monitor 24'.
  function normalizar(v) {
    return String(v === null || v === undefined ? '' : v)
      .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, ' ')
      .trim();
  }

  // Itens barrados. O \b evita pegar palavra parecida — "monitoramento" não é
  // "monitor", "celulares" é. Vale para o texto já normalizado acima.
  const PROIBIDOS = [
    {
      // Monitor é proibido em qualquer modelo, marca ou tamanho — e é chamado
      // de monitor, tela, telão ou display no dia a dia. Qualquer uma dessas
      // palavras na linha já barra, mesmo acompanhada de outro item
      // ("Notebook + tela LG 24"): não existe exceção que libere um monitor.
      tipo: 'monitor',
      re: /\b(monitor(?:es)?|telas?|telinha|telao|teloes|displays?)\b/,
    },
    {
      tipo: 'celular',
      re: /\b(celular(?:es)?|cel|smartphones?|iphones?)\b/,
      soLider: true, // liberado quando o COLABORADOR que leva é líder
    },
  ];

  // Devolve 'monitor', 'celular' ou null.
  function tipoProibido(item) {
    const n = normalizar(item);
    for (const p of PROIBIDOS) if (p.re.test(n)) return p.tipo;
    return null;
  }

  // Aceita o texto do <textarea> (um item por linha) ou um array já pronto.
  function listarItens(itens) {
    return (Array.isArray(itens) ? itens : String(itens === null || itens === undefined ? '' : itens).split('\n'))
      .map((i) => String(i === null || i === undefined ? '' : i).trim())
      .filter(Boolean);
  }

  /*
   * Confere os itens contra as regras.
   *   opcoes = { colaboradorLider, colaboradorConhecido, colaboradorNome }
   * Devolve { ok, problemas: [{ item, tipo, mensagem }] }.
   */
  function validarItens(itens, opcoes) {
    const o = opcoes || {};
    const nome = o.colaboradorNome ? String(o.colaboradorNome) : 'O colaborador';
    const problemas = [];
    for (const item of listarItens(itens)) {
      const tipo = tipoProibido(item);
      if (tipo === 'monitor') {
        problemas.push({
          item,
          tipo,
          // A dica no fim evita o falso positivo virar um beco sem saída para
          // quem só estava descrevendo o notebook.
          mensagem: '“' + item + '”: é proibido levar monitor — nenhuma tela ou display sai da empresa. ' +
            'Se for a tela do próprio notebook, escreva só o aparelho (ex.: “Notebook Dell”).',
        });
      } else if (tipo === 'celular' && !o.colaboradorLider) {
        problemas.push({
          item,
          tipo,
          // Sem "marcado/marcada": o nome do colaborador não diz o gênero.
          mensagem: '“' + item + '”: celular só pode ser levado por líder — ' + (o.colaboradorConhecido
            ? nome + ' não é líder no sistema.'
            : 'escolha o colaborador na lista para o sistema conferir se ele é líder.'),
        });
      }
    }
    return { ok: problemas.length === 0, problemas };
  }

  return { REGRAS, normalizar, tipoProibido, listarItens, validarItens };
});
