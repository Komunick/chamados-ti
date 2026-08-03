#!/usr/bin/env bash
# Controle do serviço numa VM Linux — instalar, subir, parar, atualizar, diagnosticar.
#
#   ./devops/ctl.sh {install|ensure|start|stop|restart|status|logs|update}
#
# Node puro, sem dependências: não precisa de npm install, sudo nem systemd.
# O serviço sobe com setsid (sobrevive ao fim da sessão SSH) e o cron o
# ressobe sozinho a cada 2 minutos se ele cair (subcomando `ensure`).
set -uo pipefail

AQUI="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$AQUI/.." && pwd)"
# shellcheck source=config.env
. "$AQUI/config.env"

# ---------------------------------------------------------------------------
# Configuração efetiva (ambiente > config.env > padrão).
# ---------------------------------------------------------------------------
BASE="${KOMUNICK_BASE:-$HOME/komunick}"
APP="$REPO/$APP_SUBDIR"
ENTRADA="$APP/server/server.js"
PORTA="${PORT:-$PORTA_PADRAO}"
ESCUTA="${HOST:-0.0.0.0}"
# Aceita tanto DATA_DIR quanto a variável nativa do sistema (ex.: TI_DATA_DIR),
# porque é essa que a documentação do servidor usa e alguém vai tentar.
DADOS="${DATA_DIR:-${!DATA_ENV:-$BASE/data/$DATA_SUBDIR}}"
LOG_DIR="${LOG_DIR:-$BASE/logs}"
LOG="$LOG_DIR/$SERVICO.log"
MARCA="# devops:$SERVICO"

msg() { printf '%s\n' "$*"; }
erro() { printf 'ERRO: %s\n' "$*" >&2; }

# Acha o Node. O cron roda com PATH mínimo, então procurar no nvm vem antes
# de confiar no PATH. Preferimos a v22 (a que os serviços já usam); se não
# houver, pegamos a maior instalada.
achar_node() {
  if [ -n "${NODE_BIN:-}" ]; then
    [ -x "$NODE_BIN" ] && { printf '%s' "$NODE_BIN"; return 0; }
    erro "NODE_BIN aponta para algo que não é executável: $NODE_BIN"; return 1
  fi
  local n
  n=$(ls -d "$HOME"/.nvm/versions/node/v22*/bin/node 2>/dev/null | sort -V | tail -1)
  [ -z "$n" ] && n=$(ls -d "$HOME"/.nvm/versions/node/v*/bin/node 2>/dev/null | sort -V | tail -1)
  [ -z "$n" ] && n=$(command -v node 2>/dev/null)
  [ -n "$n" ] || { erro "Node não encontrado. Instale (nvm install 22) ou preencha NODE_BIN no devops/config.env."; return 1; }
  printf '%s' "$n"
}

pid_do_servico() { pgrep -f "^.*[ ]$ENTRADA$" 2>/dev/null | head -1; }
esta_no_ar() { [ -n "$(pid_do_servico)" ]; }

porta_ocupada() {
  if command -v ss >/dev/null 2>&1; then ss -ltnH 2>/dev/null | awk '{print $4}' | grep -qE "[:.]$PORTA$"
  else netstat -ltn 2>/dev/null | awk '{print $4}' | grep -qE "[:.]$PORTA$"; fi
}

# ---------------------------------------------------------------------------
# Subcomandos.
# ---------------------------------------------------------------------------
cmd_start() {
  if esta_no_ar; then msg "$NOME_LONGO já está no ar (PID $(pid_do_servico))."; return 0; fi
  if porta_ocupada; then erro "a porta $PORTA já está ocupada por outro processo."; return 1; fi
  local node; node=$(achar_node) || return 1
  [ -f "$ENTRADA" ] || { erro "não achei $ENTRADA — o repositório está completo?"; return 1; }
  mkdir -p "$DADOS" "$LOG_DIR"
  # A subshell inteira vai para /dev/null e só depois o exec assume o log: sem
  # isso ela herda o canal do SSH e `ctl.sh start` remoto fica pendurado até o
  # serviço morrer. O setsid destaca o processo da sessão que o iniciou.
  (
    cd "$APP" || exit 1
    exec env PORT="$PORTA" HOST="$ESCUTA" "$DATA_ENV=$DADOS" \
      ${EXTRA_ENV[@]+"${EXTRA_ENV[@]}"} \
      setsid "$node" "$ENTRADA" >>"$LOG" 2>&1 </dev/null
  ) >/dev/null 2>&1 </dev/null &
  disown 2>/dev/null || true
  sleep 1
  if esta_no_ar; then
    msg "$NOME_LONGO subiu (PID $(pid_do_servico)) na porta $PORTA."
    printf '%s iniciado %s\n' "$(date '+%F %T')" "$SERVICO" >> "$LOG_DIR/devops.log"
  else
    erro "não subiu. Últimas linhas do log:"; tail -15 "$LOG" >&2; return 1
  fi
}

# Idempotente e silencioso quando já está no ar — é isto que o cron chama.
cmd_ensure() { esta_no_ar && return 0; cmd_start; }

cmd_stop() {
  local pid; pid=$(pid_do_servico)
  if [ -z "$pid" ]; then msg "$NOME_LONGO já estava parado."; return 0; fi
  kill "$pid" 2>/dev/null
  for _ in $(seq 1 20); do esta_no_ar || break; sleep 0.25; done
  if esta_no_ar; then kill -9 "$(pid_do_servico)" 2>/dev/null; sleep 0.5; fi
  esta_no_ar && { erro "não consegui parar o processo."; return 1; }
  msg "$NOME_LONGO parado."
}

cmd_restart() { cmd_stop; cmd_start; }

cmd_status() {
  local pid; pid=$(pid_do_servico)
  msg "$NOME_LONGO"
  msg "  repositório : $REPO"
  msg "  branch      : $(git -C "$REPO" branch --show-current 2>/dev/null || echo '(sem git)')  $(git -C "$REPO" log --oneline -1 2>/dev/null)"
  msg "  dados       : $DADOS"
  msg "  log         : $LOG"
  msg "  node        : $(achar_node 2>/dev/null || echo 'NÃO ENCONTRADO')"
  if [ -n "$pid" ]; then
    msg "  processo    : NO AR (PID $pid, desde $(ps -o lstart= -p "$pid" 2>/dev/null | sed 's/^ *//'))"
  else
    msg "  processo    : PARADO"
  fi
  msg "  porta $PORTA   : $(porta_ocupada && echo 'escutando' || echo 'fechada')"
  if command -v curl >/dev/null 2>&1; then
    local code; code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "http://127.0.0.1:$PORTA/" 2>/dev/null)
    msg "  HTTP        : ${code:-sem resposta}$([ "${code:-0}" = 200 ] && echo ' (ok)')"
  fi
}

cmd_logs() { local n="${1:-40}"; [ -f "$LOG" ] || { msg "(sem log ainda em $LOG)"; return 0; }; tail -n "$n" "$LOG"; }

cmd_update() {
  msg "== git pull =="
  git -C "$REPO" pull --ff-only || { erro "pull falhou (há alteração local?). Resolva e rode de novo."; return 1; }
  msg "== reiniciando (o Node guarda o código em memória) =="
  cmd_restart
}

# Cria as pastas, sobe pela primeira vez e deixa o cron cuidando.
cmd_install() {
  msg "Instalando $NOME_LONGO a partir de $REPO"
  mkdir -p "$DADOS" "$LOG_DIR"
  local node; node=$(achar_node) || return 1
  msg "  node: $node ($("$node" -v 2>/dev/null))"
  msg "  dados: $DADOS"
  chmod +x "$AQUI/ctl.sh" 2>/dev/null || true
  cmd_start || return 1
  cmd_install_cron
  msg ""
  msg "Pronto. Acesse http://<ip-da-vm>:$PORTA"
  msg "Se a VM tiver firewall ativo, peça a quem tem sudo: ufw allow $PORTA/tcp"
}

# Cron do usuário (sem sudo): sobe no boot e a cada 2 min se tiver caído.
cmd_install_cron() {
  command -v crontab >/dev/null 2>&1 || { erro "crontab não existe nesta VM; pule esta etapa."; return 1; }
  # Compara <repo>/<app>, não só o nome da pasta do app: dois sistemas
  # diferentes podem ter o mesmo APP_SUBDIR (patrimonio-web aparece no
  # Controle Patrimonial e no Patrimônio JB Fraga) e o guard pularia o cron do
  # segundo por engano. O ensure.sh legado guarda o caminho com $BASE literal,
  # então a comparação é pelo trecho relativo mesmo.
  local alvo="$(basename "$REPO")/$APP_SUBDIR"
  if [ -x "$BASE/bin/ensure.sh" ] && grep -qF "$alvo" "$BASE/bin/ensure.sh" 2>/dev/null; then
    msg "  aviso: $BASE/bin/ensure.sh (legado) já cuida deste serviço — não instalei cron para não duplicar."
    return 0
  fi
  # Chama por `bash ...` de propósito: o bit de execução costuma se perder no
  # caminho Windows → git → clone, e aí o cron falharia calado ("Permission
  # denied" indo para /dev/null) justo no auto-início, que é a razão de existir
  # disto tudo. Com `bash` na frente funciona mesmo sem o +x.
  local atual novo
  atual=$(crontab -l 2>/dev/null | grep -v "$MARCA")
  novo=$(printf '%s\n@reboot bash "%s/devops/ctl.sh" ensure >/dev/null 2>&1 %s\n*/2 * * * * bash "%s/devops/ctl.sh" ensure >/dev/null 2>&1 %s\n' \
    "$atual" "$REPO" "$MARCA" "$REPO" "$MARCA")
  printf '%s\n' "$novo" | grep -v '^$' | crontab - && msg "  cron instalado (@reboot + a cada 2 min)."
}

cmd_uninstall_cron() {
  crontab -l 2>/dev/null | grep -v "$MARCA" | crontab - && msg "cron removido."
}

case "${1:-}" in
  install)        cmd_install ;;
  ensure)         cmd_ensure ;;
  start)          cmd_start ;;
  stop)           cmd_stop ;;
  restart)        cmd_restart ;;
  status)         cmd_status ;;
  logs)           shift; cmd_logs "${1:-40}" ;;
  update)         cmd_update ;;
  install-cron)   cmd_install_cron ;;
  uninstall-cron) cmd_uninstall_cron ;;
  *)
    cat <<AJUDA
$NOME_LONGO — controle do serviço na VM

  ./devops/ctl.sh install         instala do zero (pastas, primeira subida e cron)
  ./devops/ctl.sh start|stop|restart
  ./devops/ctl.sh status          porta, PID, commit e resposta HTTP
  ./devops/ctl.sh logs [n]        últimas n linhas do log (padrão 40)
  ./devops/ctl.sh update          git pull + reinicia
  ./devops/ctl.sh ensure          sobe se estiver caído (é o que o cron chama)
  ./devops/ctl.sh install-cron | uninstall-cron

Ajuste os valores em devops/config.env. Detalhes em devops/README.md.
AJUDA
    exit 1 ;;
esac
