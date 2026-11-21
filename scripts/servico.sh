#!/bin/zsh
# Implanta e mantém o Orelha no ar no macOS: LaunchAgent do usuário + tailscale serve na porta pública do config.json.
# Uso: scripts/servico.sh verificar | instalar | atualizar | reiniciar | status | logs | remover
set -euo pipefail

LABEL="com.orelha.server"
PROJECT="${0:A:h:h}"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
DOMAIN="gui/$(id -u)"
LOG="$PROJECT/data/orelha.log"
NODE_MIN=24

falha() { echo "✗ $*" >&2; exit 1; }
aviso() { echo "! $*" >&2; }
ok() { echo "✓ $*"; }

NODE="$(command -v node || true)"
[ -n "$NODE" ] || falha "Node.js não encontrado no PATH. Instale o Node $NODE_MIN ou superior."

# O app da Mac App Store não coloca a CLI no PATH; o binário dentro do app serve.
TAILSCALE="$(command -v tailscale || true)"
if [ -z "$TAILSCALE" ] && [ -x /Applications/Tailscale.app/Contents/MacOS/Tailscale ]; then
  TAILSCALE=/Applications/Tailscale.app/Contents/MacOS/Tailscale
fi

[ -f "$PROJECT/config.json" ] || falha "config.json não encontrado. Copie config.example.json para config.json e configure sua tailnet."
config() { "$NODE" -e 'const c = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")); console.log(c[process.argv[2]] ?? "")' "$PROJECT/config.json" "$1"; }
PORT="$(config port)"; PORT="${PORT:-4173}"
PUBLIC_PORT="$(config publicPort)"; PUBLIC_PORT="${PUBLIC_PORT:-8443}"
TAILNET_HOST="$(config tailnetHost)"

versao_local() { "$NODE" -p 'require(process.argv[1]).version' "$PROJECT/package.json"; }

# Confere tudo o que a implantação precisa, sem mudar nada.
verificar() {
  local major="$("$NODE" -p 'process.versions.node.split(".")[0]')"
  (( major >= NODE_MIN )) || falha "Node $("$NODE" --version) em $NODE; o Orelha precisa do Node $NODE_MIN ou superior."
  ok "Node $("$NODE" --version) em $NODE"
  case "$NODE" in
    */.nvm/*|*/fnm*|*/.asdf/*|*/mise/*)
      aviso "Esse Node vem de um gerenciador de versões. Ao trocar ou apagar essa versão, rode 'scripts/servico.sh instalar' de novo." ;;
  esac

  [ -n "$TAILSCALE" ] || falha "CLI do Tailscale não encontrada. Instale o Tailscale ou ative a CLI em Tailscale → Settings."
  "$TAILSCALE" status >/dev/null 2>&1 || falha "Tailscale não está conectado. Abra o app e entre na sua tailnet."
  ok "Tailscale conectado ($TAILSCALE)"

  [ -n "$TAILNET_HOST" ] && [ "$TAILNET_HOST" != "seu-mac.tailnet-exemplo.ts.net" ] \
    || falha "Preencha tailnetHost no config.json com o nome da máquina na tailnet."
  local aparelhos="$("$NODE" -e 'const c = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")); console.log(Object.values(c.allowedDevices || {}).flat().length)' "$PROJECT/config.json")"
  (( aparelhos > 0 )) || falha "allowedDevices está vazio no config.json: nenhum aparelho conseguiria entrar."
  ok "config.json: $TAILNET_HOST:$PUBLIC_PORT, $aparelhos IP(s) liberado(s)"

  # Um worktree some quando é removido, e os dados em data/ iriam junto.
  if git -C "$PROJECT" rev-parse --git-dir >/dev/null 2>&1; then
    local gitdir="$(git -C "$PROJECT" rev-parse --absolute-git-dir)"
    local common="$(cd "$PROJECT" && cd "$(git rev-parse --git-common-dir)" && pwd -P)"
    if [ "$gitdir" != "$common" ] && [ -z "${ORELHA_PERMITIR_WORKTREE:-}" ]; then
      falha "$PROJECT é um worktree do Git. Instale a partir de um clone fixo (ex.: ~/orelha) ou defina ORELHA_PERMITIR_WORKTREE=1."
    fi
  fi

  (cd "$PROJECT" && "$NODE" --test test/ >/dev/null 2>&1) || falha "Os testes falharam. Rode 'npm test' para ver o motivo."
  ok "Testes passaram (versão $(versao_local))"
}

# Espera o servidor responder e confirma que é a versão do disco que está no ar.
saude() {
  local esperada="$(versao_local)" resposta=""
  for _ in {1..20}; do
    resposta="$(curl -fsS --max-time 2 "http://127.0.0.1:$PORT/api/health" 2>/dev/null || true)"
    [ -n "$resposta" ] && break
    sleep 0.5
  done
  [ -n "$resposta" ] || falha "O servidor não respondeu em http://127.0.0.1:$PORT. Veja 'scripts/servico.sh logs'."
  local no_ar="$("$NODE" -p 'JSON.parse(process.argv[1]).version ?? "?"' "$resposta")"
  [ "$no_ar" = "$esperada" ] || falha "No ar está a versão $no_ar, mas o disco tem $esperada."
  ok "Orelha $no_ar respondendo em http://127.0.0.1:$PORT"
}

instalar() {
  verificar
  mkdir -p "$PROJECT/data" "$HOME/Library/LaunchAgents"
  cat > "$PLIST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$NODE</string>
    <string>$PROJECT/server/index.js</string>
  </array>
  <key>WorkingDirectory</key><string>$PROJECT</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>ProcessType</key><string>Background</string>
  <key>StandardOutPath</key><string>$LOG</string>
  <key>StandardErrorPath</key><string>$LOG</string>
</dict>
</plist>
PLIST
  plutil -lint "$PLIST" >/dev/null || falha "O plist gerado é inválido: $PLIST"
  launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
  launchctl bootstrap "$DOMAIN" "$PLIST"
  saude
  # Só acrescenta esta porta; a configuração do serve em outras portas fica como está.
  "$TAILSCALE" serve --bg --https="$PUBLIC_PORT" "http://127.0.0.1:$PORT"
  ok "Publicado em https://$TAILNET_HOST:$PUBLIC_PORT"
}

# Traz a versão mais nova do branch atual, testa e reinicia. Dados em data/ não são tocados.
atualizar() {
  [ -f "$PLIST" ] || falha "Serviço não instalado. Rode 'scripts/servico.sh instalar' primeiro."
  [ -z "$(git -C "$PROJECT" status --porcelain --untracked-files=no)" ] \
    || falha "Há alterações não commitadas em $PROJECT. Faça commit ou descarte antes de atualizar."
  local antes="$(versao_local)"
  git -C "$PROJECT" pull --ff-only
  verificar
  launchctl kickstart -k "$DOMAIN/$LABEL"
  saude
  echo "Versão $antes → $(versao_local). Veja o que mudou em CHANGELOG.md."
}

reiniciar() {
  launchctl kickstart -k "$DOMAIN/$LABEL"
  saude
}

remover() {
  launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
  rm -f "$PLIST"
  [ -n "$TAILSCALE" ] && { "$TAILSCALE" serve --https="$PUBLIC_PORT" off || true; }
  echo "Serviço removido. Seus dados continuam em $PROJECT/data."
}

status() {
  launchctl print "$DOMAIN/$LABEL" 2>/dev/null | grep -E '^\s+(state|pid|last exit code) =' || echo "Serviço não está carregado."
  curl -fsS --max-time 2 "http://127.0.0.1:$PORT/api/health" 2>/dev/null && echo || echo "Sem resposta em http://127.0.0.1:$PORT."
  [ -n "$TAILSCALE" ] && "$TAILSCALE" serve status
}

logs() {
  [ -f "$LOG" ] || falha "Ainda não há log em $LOG."
  tail -n 100 -f "$LOG"
}

case "${1:-}" in
  verificar) verificar ;;
  instalar) instalar ;;
  atualizar) atualizar ;;
  reiniciar) reiniciar ;;
  status) status ;;
  logs) logs ;;
  remover) remover ;;
  *) echo "Uso: $0 verificar | instalar | atualizar | reiniciar | status | logs | remover"; exit 1 ;;
esac
