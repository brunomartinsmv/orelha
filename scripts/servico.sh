#!/bin/zsh
# Mantém o Orelha no ar: LaunchAgent do usuário + tailscale serve na porta pública do config.json.
# Uso: scripts/servico.sh instalar | remover | status
set -euo pipefail

LABEL="com.orelha.server"
PROJECT="${0:A:h:h}"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
DOMAIN="gui/$(id -u)"
NODE="$(command -v node)"
if [ ! -f "$PROJECT/config.json" ]; then
  echo "Arquivo config.json não encontrado. Copie config.example.json para config.json e configure sua tailnet." >&2
  exit 1
fi
PORT="$("$NODE" -p "JSON.parse(require('fs').readFileSync('$PROJECT/config.json')).port")"
PUBLIC_PORT="$("$NODE" -p "JSON.parse(require('fs').readFileSync('$PROJECT/config.json')).publicPort")"

instalar() {
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
  <key>StandardOutPath</key><string>$PROJECT/data/orelha.log</string>
  <key>StandardErrorPath</key><string>$PROJECT/data/orelha.log</string>
</dict>
</plist>
PLIST
  launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
  launchctl bootstrap "$DOMAIN" "$PLIST"
  # Só acrescenta esta porta; a configuração do serve em outras portas fica como está.
  tailscale serve --bg --https="$PUBLIC_PORT" "http://127.0.0.1:$PORT"
  status
}

remover() {
  launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
  rm -f "$PLIST"
  tailscale serve --https="$PUBLIC_PORT" off || true
  echo "Serviço removido. Seus dados continuam em $PROJECT/data."
}

status() {
  launchctl print "$DOMAIN/$LABEL" 2>/dev/null | grep -E '^\s+(state|pid) =' || echo "Serviço não está carregado."
  tailscale serve status
}

case "${1:-}" in
  instalar) instalar ;;
  remover) remover ;;
  status) status ;;
  *) echo "Uso: $0 instalar | remover | status"; exit 1 ;;
esac
