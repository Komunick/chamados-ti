# Chamados de TI 🛠 — Brazil Transports

Lista de atendimento da TI: qualquer colaborador abre um chamado com
**prioridade** (baixa/média/alta) e marcação de **urgência**; a fila ordena
sozinha (urgentes → prioridade → mais antigo). Cada chamado tem **status**
(*Pendente → Em andamento → Finalizado*), **observações** dos colaboradores
(erros, falhas, atualizações) e **histórico completo** de quem mudou o quê.

A TI recebe **notificações insistentes na barra de tarefas do Windows** a cada
novo chamado (e também quando solicitantes mudam status ou comentam), até
marcar como vista.

Mesma arquitetura dos outros sistemas: servidor **Node puro, sem dependências**,
dados **fora da pasta web**, acesso pela rede **ZeroTier**, senhas com scrypt,
sessões de 30 dias, tempo real por SSE.

## Pastas

```
Sistema-chamados-ti\
├── ti-web\               ← app + servidor (porta 8085)
│   ├── index.html / app.js / styles.css
│   ├── server\server.js + server\db.js
│   ├── start-server.bat        ← inicia o servidor (com loop de reinício)
│   ├── run-hidden.vbs          ← inicia escondido (sem janela)
│   ├── INSTALAR-AUTOINICIO.bat ← servidor sobe sozinho no boot (pede admin)
│   └── LIBERAR-FIREWALL.bat    ← libera a porta 8085 só para o ZeroTier
├── ti-data\              ← criada sozinha: chamados-ti.json, backups\
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
