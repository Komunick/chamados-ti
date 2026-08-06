# Chamados de TI 🛠 — Brazil Transports

Lista de atendimento da TI: qualquer colaborador abre um chamado com
**prioridade** (baixa/média/alta) e marcação de **urgência**; a fila ordena
sozinha (urgentes → prioridade → mais antigo). Cada chamado tem **status**
(*Pendente → Em andamento → Finalizado*), **observações** dos colaboradores
(erros, falhas, atualizações) e **histórico completo** de quem mudou o quê.

A TI recebe **notificações insistentes na barra de tarefas do Windows** a cada
novo chamado (e também quando solicitantes mudam status ou comentam), até
marcar como vista. O **solicitante** também tem sino: é avisado quando o status
do chamado dele muda ou quando a TI escreve uma observação.

Mesma arquitetura dos outros sistemas: servidor **Node puro, sem dependências**,
dados **fora da pasta web**, acesso pela rede **ZeroTier**, senhas com scrypt,
sessões de 30 dias, tempo real por SSE.

A interface é **mobile-first** (design Google Stitch "Fila Leve"): no celular,
navegação inferior fixa, botão flutuante de novo chamado e telas em folha
deslizante; no computador, abas no topo e painel lateral. Modo claro/escuro com
preferência salva.

## O que o sistema faz

| Recurso | Como funciona |
|---|---|
| **Fila com posição** | Ordena por urgência → prioridade → chegada. Cada um vê em que lugar está o próprio chamado. |
| **Prazo (SLA)** | Urgente 4 h · Alta 1 dia · Média 3 dias · Baixa 5 dias. Pill no cartão mostra *vence em X* / *atrasado*; chip **⚠ Fora do prazo** filtra os estourados. |
| **Anexos** | Fotos do erro na abertura e nas observações (comprimidas no navegador, guardadas em `ti-data\anexos\`). |
| **Avaliação** | O solicitante dá 1–5 ⭐ quando o chamado é finalizado, com comentário opcional. |
| **Base de conhecimento** | Aba **Ajuda**: guias escritos pela TI. Ao digitar o título de um chamado novo, o sistema sugere artigos que talvez resolvam na hora. |
| **Painel de indicadores** | Aba **Painel** (TI, admin e líderes): volume, tempo médio, % dentro do prazo, nota média, atrasados, reaberturas, série diária e carga por atendente — 7/30/90 dias. |
| **Responsável** | *Atribuir a mim* ou escolher o técnico; chip **Meus atendimentos** filtra a carga de cada um. |
| **Reabertura** | O solicitante reabre em até **7 dias** da finalização explicando o que voltou; a TI reabre a qualquer momento. O histórico é mantido. |
| **Avisos externos** | E-mail (SMTP) e/ou webhook (WhatsApp, n8n, Zapier) — opcionais, ver abaixo. |

## Avisos por e-mail e WhatsApp (opcional)

Desligados por padrão. Na primeira execução o servidor cria
`ti-data\notificar-config.json`:

```json
{
  "email":   { "ativo": false, "host": "smtp.exemplo.com", "porta": 465,
               "usuario": "", "senha": "", "de": "Chamados TI <ti@empresa.com.br>" },
  "webhook": { "ativo": false, "url": "https://exemplo.com/webhook-chamados" }
}
```

- **email** — SMTP direto (porta 465 com TLS, ou 587 com STARTTLS). Envia para o
  e-mail cadastrado no usuário (painel 👤 → *Contatos*).
- **webhook** — `POST` JSON com `{ evento, assunto, mensagem, chamadoId, para }`
  para o seu gateway de WhatsApp ou fluxo de automação.

O arquivo é lido a cada envio: dá para ligar/desligar **sem reiniciar** o
servidor. Falha de envio vira linha no console e nunca derruba o chamado.

## Pastas

```
Sistema-chamados-ti\
├── ti-web\               ← app + servidor (porta 8085)
│   ├── index.html / app.js / styles.css
│   ├── logo-brazil-transports.svg / logo-simbolo.svg
│   ├── server\server.js + server\db.js + server\notificar.js
│   ├── start-server.bat        ← inicia o servidor (com loop de reinício)
│   ├── run-hidden.vbs          ← inicia escondido (sem janela)
│   ├── INSTALAR-AUTOINICIO.bat ← servidor sobe sozinho no boot (pede admin)
│   └── LIBERAR-FIREWALL.bat    ← libera a porta 8085 só para o ZeroTier
├── ti-data\              ← criada sozinha: chamados-ti.json, backups\,
│                            anexos\, ho-anexos\, notificar-config.json
└── notificador\          ← roda na máquina de QUEM ATENDE (a TI)
```

## Como colocar no ar (no servidor — este computador)

1. `ti-web\run-hidden.vbs` (ou `start-server.bat` para ver a janela).
   App em **http://10.13.47.131:8085** (ZeroTier) e **http://localhost:8085**.
2. `LIBERAR-FIREWALL.bat` uma vez (porta 8085 só para `10.13.47.0/24`).
3. `INSTALAR-AUTOINICIO.bat` uma vez para subir sozinho no boot.
4. Entre com **admin / admin123**, troque a senha e cadastre os usuários em 👤:
   - **Solicitante** — abre chamados e comenta;
   - **TI** — atende a fila e recebe as notificações;
   - **Admin** — tudo + usuários.

## Notificações na barra de tarefas (máquina da TI)

1. `notificador\iniciar-notificador.bat` uma vez — cria o `config.json`.
2. Edite `config.json`: servidor `http://10.13.47.131:8085`, login/senha de um
   usuário **ti** (ou admin).
3. `INSTALAR-NOTIFICADOR.bat` — passa a iniciar junto com o Windows, escondido.

O aviso repete a cada 5 minutos até ser marcado como visto (sino 🔔 no app).

O sino agora é de **todos**: o solicitante recebe aviso quando o status do
chamado dele muda ou quando a TI comenta. `GET /api/notificacoes/pendentes`
devolve `escopo: "equipe"` para TI/admin (o que o notificador consome) e
`escopo: "pessoal"` para os demais — se o notificador estiver configurado com
um usuário sem permissão de atendimento, é por aí que se percebe.

## Home Office 🏠 (saída de equipamento)

Duas abas, além da fila de chamados:

- **Home Office** — só aparece para **líderes** (papel TI/admin, ou o usuário
  marcado com ⭐ *Líder* no painel de usuários). O líder escolhe o colaborador,
  escreve os itens que ele vai levar (um por linha) e confirma o termo. Isso
  **abre um chamado** (categoria *Equipamento*) em nome do líder, avisa a TI e
  marca o prazo de devolução em **3 dias**, com contador na tela
  (*restantes → vence hoje → atrasado*).
- **Devolução Home Office** — para todos. O colaborador citado anexa a **foto**
  dos aparelhos (comprimida no navegador) e confirma; a devolução entra como
  observação **no mesmo chamado** da saída, para a TI conferir e finalizar.

### Regras aplicadas pelo sistema

1. **É proibido levar monitor** — qualquer tipo, marca ou tamanho.
2. **Celular só pode ser levado por líder** — vale a liderança de *quem leva*,
   não a de quem registra; nome digitado fora da lista de usuários não é
   considerado líder.
3. **É proibido levar qualquer item que não esteja citado no chamado.**

As regras ficam escritas na aba, entram na descrição do chamado e são
conferidas em `ti-web\regras-ho.js` — **o mesmo arquivo** que o navegador
carrega e que o servidor exige (`require`), para a tela e o servidor nunca
divergirem. A tela avisa na hora e desabilita o botão; quem barra de fato é o
servidor. Ao mudar uma regra, **reinicie o servidor** (o Node guarda o módulo
em memória).

Fotos ficam em `ti-data\ho-anexos\` e são servidas por
`/api/homeoffice/:id/imagem?token=` (fora da pasta estática).

## Integração com o assistente (Claude)

Os chamados de melhorias/sistemas pedidos ao assistente são registrados aqui, e
o assistente **atualiza o status pela API** quando começa/termina de trabalhar
(*Pendente → Em andamento → Finalizado*), usando o usuário `claude`. Mudanças
manuais feitas no site ficam no **histórico** de cada chamado
(`GET /api/historico?desde=...`), que o assistente consulta ao iniciar o
trabalho — é assim que ele detecta o que você alterou.

## Detalhes técnicos

- Porta **8085** (8080 = patrimonial, 8090 = chamados financeiros).
  Variáveis: `PORT`, `HOST`, `TI_DATA_DIR`.
- Dados em `ti-data\chamados-ti.json` (gravação atômica + fsync + retry);
  snapshots rotativos em `ti-data\backups\` (40 mais recentes, 6 h + boot).
- Arquivo corrompido → quarentena + servidor aborta (não sobrescreve dados).
- Bloqueio de 1 min após 5 senhas erradas; código do servidor não é servido.
