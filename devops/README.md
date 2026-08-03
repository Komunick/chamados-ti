# devops — deploy do Chamados de TI numa VM Linux

Tudo que é preciso para colocar este sistema no ar numa VM, versionado junto com
o código: quem clona o repositório já leva o deploy junto.

| | |
|---|---|
| Runtime | **Node puro, sem dependências** — não existe `npm install` |
| Porta padrão | **8085** |
| Dados | `~/komunick/data/ti-data` (fora do repositório, nunca versionado) |
| Auto-início | **cron do usuário** — sem `sudo`, sem `systemd` |
| Log | `~/komunick/logs/chamados-ti.log` |

## Instalar numa VM nova

```bash
# 1. Node 22 (uma vez por VM), se ainda não houver
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
. ~/.nvm/nvm.sh && nvm install 22

# 2. Clonar e instalar
mkdir -p ~/komunick/repos && cd ~/komunick/repos
git clone https://github.com/Komunick/chamados-ti.git
cd chamados-ti
bash devops/ctl.sh install
```

O `install` cria as pastas de dados e log, sobe o serviço e instala o cron
(`@reboot` + a cada 2 minutos, que ressobe se cair). Ao final ele imprime o
endereço. Se a VM tiver firewall ativo, peça a quem tem sudo:
`ufw allow 8085/tcp`.

Na primeira execução o sistema cria o usuário **admin / admin123** — troque a senha e cadastre os usuários pelo próprio site.

## Dia a dia

```bash
bash devops/ctl.sh status      # porta, PID, commit, Node em uso e resposta HTTP
bash devops/ctl.sh logs 60     # últimas 60 linhas do log
bash devops/ctl.sh update      # git pull + reinicia
bash devops/ctl.sh restart
```

**`update` é o comando de deploy.** `git pull` sozinho não basta: o Node mantém
o código já carregado em memória, então sem reiniciar a VM continua servindo a
versão antiga. O `update` faz as duas coisas.

## Ajustar portas e caminhos

Os valores ficam em [`config.env`](config.env) e podem ser sobrescritos por
variável de ambiente sem editar arquivo nenhum:

```bash
PORT=9085 DATA_DIR=/dados/chamados-ti bash devops/ctl.sh start
KOMUNICK_BASE=/srv/komunick bash devops/ctl.sh install
```

| Variável | Para quê |
|---|---|
| `PORT` | porta HTTP (padrão 8085) |
| `HOST` | interface de escuta (padrão `0.0.0.0`) |
| `DATA_DIR` ou `TI_DATA_DIR` | pasta dos dados (padrão `$KOMUNICK_BASE/data/ti-data`) |
| `KOMUNICK_BASE` | raiz de dados e logs (padrão `~/komunick`) |
| `NODE_BIN` | fixa o binário do Node, se a VM tiver várias versões |

Sem `NODE_BIN`, o script procura nesta ordem: nvm v22 → maior versão instalada
no nvm → `node` do `PATH`. A busca no nvm vem primeiro de propósito: o cron roda
com `PATH` mínimo e não enxergaria o Node instalado no perfil do usuário. O
`status` mostra qual binário está sendo usado.

### Variáveis da aplicação que precisam sobreviver ao reinício

Sobrescrever na linha de comando só vale para aquela execução: quando o serviço
cai e o cron o ressobe, essas variáveis somem. Para que valham sempre, coloque-as
no array `EXTRA_ENV` do `config.env` — o `ctl.sh` as repassa em toda subida.

## Dados e backup

Os dados vivem **fora** do repositório, em `~/komunick/data/ti-data`:

- `chamados-ti.json` — a base, gravada de forma atômica com fsync;
- `backups/` — snapshots rotativos automáticos **apenas do chamados-ti.json**;
- `ho-anexos/` (fotos das devoluções de Home Office) — arquivos enviados pelos usuários, que os snapshots **não** cobrem.

Atualizar o código nunca toca nesses arquivos. Para um backup completo, copie a
pasta inteira (com o serviço parado) — restaurar só o JSON deixa os anexos
apontando para arquivos que não existem mais.

Se o arquivo for encontrado corrompido, o servidor **não** re-semeia: ele move o
arquivo para quarentena e aborta, para não sobrescrever dados. Nesse caso,
restaure um arquivo de `backups/` com o nome `chamados-ti.json` e suba de novo.

## Se algo der errado

| Sintoma | O que olhar |
|---|---|
| `install` diz que a porta está ocupada | `ss -ltnp \| grep 8085` — outro serviço ou uma instância antiga |
| Serviço cai sozinho e volta | é o cron fazendo o trabalho dele; veja o motivo em `logs` |
| Cron não sobe no boot | `crontab -l` deve ter duas linhas com `# devops:chamados-ti` |
| Node não encontrado pelo cron | preencha `NODE_BIN` no `config.env` com o caminho absoluto |
| Site responde mas sem os dados certos | confira `status`: a linha `dados` aponta para a pasta esperada? |
| Variável da aplicação "some" sozinha | ela estava só na sessão; mova para `EXTRA_ENV` no `config.env` |

## Convivência com a instalação legada da `mint-vm`

Na VM atual quem sobe este serviço ainda é o script antigo
`~/komunick/bin/ensure.sh`, chamado pelo cron a cada 2 minutos. Enquanto for
assim, duas coisas mudam:

- **O log é outro.** O legado escreve em `~/komunick/logs/ti.log`, e não no
  `chamados-ti.log` que o `ctl.sh` mostra. Se `logs` vier vazio, procure lá.
- **`stop` não segura.** O `ctl.sh` para o processo, mas em até 2 minutos o
  `ensure.sh` legado o levanta de novo. Isso é perigoso para copiar dados: use
  `~/komunick/bin/stop-all.sh` ou comente a linha do cron antes de copiar.
  `restart` e `update` são seguros, porque não deixam janela aberta.

Por isso o `install` detecta o `ensure.sh` legado e **não** instala o cron
próprio — para não haver dois donos do mesmo processo. Para migrar de vez,
remova a linha correspondente do `ensure.sh` e rode
`bash devops/ctl.sh install-cron`.
