#!/usr/bin/env bash
# Implanta e mantém o Orelha no ar no Linux: serviço de usuário do systemd + tailscale serve na porta pública do config.json.
# Uso: scripts/servico-linux.sh verificar | instalar | atualizar | reiniciar | status | logs | remover
set -euo pipefail

UNIT="orelha.service"
PROJECT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
UNIT_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
UNIT_FILE="$UNIT_DIR/$UNIT"
NODE_MIN=24

falha() { echo "✗ $*" >&2; exit 1; }
aviso() { echo "! $*" >&2; }
ok() { echo "✓ $*"; }

NODE="$(command -v node || true)"
[ -n "$NODE" ] || falha "Node.js não encontrado no PATH. Instale o Node $NODE_MIN ou superior."
TAILSCALE="$(command -v tailscale || true)"

[ -f "$PROJECT/config.json" ] || falha "config.json não encontrado. Copie config.example.json para config.json e configure sua tailnet."
config() { "$NODE" -e 'const c = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")); console.log(c[process.argv[2]] ?? "")' "$PROJECT/config.json" "$1"; }
PORT="$(config port)"; PORT="${PORT:-4173}"
PUBLIC_PORT="$(config publicPort)"; PUBLIC_PORT="${PUBLIC_PORT:-8443}"
TAILNET_HOST="$(config tailnetHost)"

versao_local() { "$NODE" -p 'require(process.argv[1]).version' "$PROJECT/package.json"; }

# Confere tudo o que a implantação precisa, sem mudar nada.
verificar() {
  local major
  major="$("$NODE" -p 'process.versions.node.split(".")[0]')"
  (( major >= NODE_MIN )) || falha "Node $("$NODE" --version) em $NODE; o Orelha precisa do Node $NODE_MIN ou superior."
  ok "Node $("$NODE" --version) em $NODE"
  case "$NODE" in
    */.nvm/*|*/fnm*|*/.asdf/*|*/mise/*)
      aviso "Esse Node vem de um gerenciador de versões. Ao trocar ou apagar essa versão, rode 'scripts/servico-linux.sh instalar' de novo." ;;
  esac

  command -v systemctl >/dev/null || falha "systemctl não encontrado: este script precisa do systemd."
  systemctl --user show-environment >/dev/null 2>&1 \
    || falha "O systemd de usuário não está acessível. Entre por uma sessão normal ou SSH (não 'su') e tente de novo."
  ok "systemd de usuário disponível"
  if [ "$(loginctl show-user "$USER" -p Linger --value 2>/dev/null || true)" != "yes" ]; then
    aviso "Linger desligado: o serviço só roda enquanto você estiver logado. 'instalar' tenta ligar (loginctl enable-linger)."
  fi

  [ -n "$TAILSCALE" ] || falha "CLI do Tailscale não encontrada. Instale com https://tailscale.com/download/linux."
  "$TAILSCALE" status >/dev/null 2>&1 || falha "Tailscale não está conectado. Rode 'sudo tailscale up'."
  ok "Tailscale conectado ($TAILSCALE)"
  # No Linux, só root ou o operador configurado pode mudar o tailscale serve.
  if [ "$(id -u)" -ne 0 ]; then
    local operador
    operador="$("$TAILSCALE" debug prefs 2>/dev/null | "$NODE" -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{console.log(JSON.parse(s).OperatorUser||"")}catch{console.log("")}})' || true)"
    [ "$operador" = "$USER" ] \
      || falha "Seu usuário não é operador do Tailscale. Rode uma vez: sudo tailscale set --operator=$USER"
    ok "$USER é operador do Tailscale"
  fi

  [ -n "$TAILNET_HOST" ] && [ "$TAILNET_HOST" != "seu-mac.tailnet-exemplo.ts.net" ] \
    || falha "Preencha tailnetHost no config.json com o nome da máquina na tailnet."
  local aparelhos
  aparelhos="$("$NODE" -e 'const c = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")); console.log(Object.values(c.allowedDevices || {}).flat().length)' "$PROJECT/config.json")"
  (( aparelhos > 0 )) || falha "allowedDevices está vazio no config.json: nenhum aparelho conseguiria entrar."
  ok "config.json: $TAILNET_HOST:$PUBLIC_PORT, $aparelhos IP(s) liberado(s)"

  # Um worktree some quando é removido, e os dados em data/ iriam junto.
  if git -C "$PROJECT" rev-parse --git-dir >/dev/null 2>&1; then
    local gitdir common
    gitdir="$(git -C "$PROJECT" rev-parse --absolute-git-dir)"
    common="$(cd "$PROJECT" && cd "$(git rev-parse --git-common-dir)" && pwd -P)"
    if [ "$gitdir" != "$common" ] && [ -z "${ORELHA_PERMITIR_WORKTREE:-}" ]; then
      falha "$PROJECT é um worktree do Git. Instale a partir de um clone fixo (ex.: ~/orelha) ou defina ORELHA_PERMITIR_WORKTREE=1."
    fi
  fi

  (cd "$PROJECT" && "$NODE" --test >/dev/null 2>&1) || falha "Os testes falharam. Rode 'npm test' para ver o motivo."
  ok "Testes passaram (versão $(versao_local))"
}

# Espera o servidor responder e confirma que é a versão do disco que está no ar. Usa o próprio Node: curl nem sempre vem instalado.
saude() {
  local esperada no_ar=""
  esperada="$(versao_local)"
  for _ in $(seq 1 20); do
    no_ar="$("$NODE" -e 'fetch(process.argv[1], { signal: AbortSignal.timeout(2000) }).then((r) => r.json()).then((j) => console.log(j.version ?? "?")).catch(() => {})' "http://127.0.0.1:$PORT/api/health")"
    [ -n "$no_ar" ] && break
    sleep 0.5
  done
  [ -n "$no_ar" ] || falha "O servidor não respondeu em http://127.0.0.1:$PORT. Veja 'scripts/servico-linux.sh logs'."
  [ "$no_ar" = "$esperada" ] || falha "No ar está a versão $no_ar, mas o disco tem $esperada."
  ok "Orelha $no_ar respondendo em http://127.0.0.1:$PORT"
}

instalar() {
  verificar
  mkdir -p "$PROJECT/data" "$UNIT_DIR"
  cat > "$UNIT_FILE" <<UNIT
[Unit]
Description=Orelha, diário de leitura
After=network-online.target

[Service]
ExecStart="$NODE" "$PROJECT/server/index.js"
WorkingDirectory=$PROJECT
Restart=always
RestartSec=10

[Install]
WantedBy=default.target
UNIT
  if command -v systemd-analyze >/dev/null; then
    systemd-analyze --user verify "$UNIT_FILE" || falha "A unit gerada é inválida: $UNIT_FILE"
  fi
  # Sem linger, o systemd de usuário para quando você sai e não sobe no boot.
  if [ "$(loginctl show-user "$USER" -p Linger --value 2>/dev/null || true)" != "yes" ]; then
    loginctl enable-linger "$USER" \
      || falha "Não consegui ligar o linger. Rode: sudo loginctl enable-linger $USER"
    ok "Linger ligado: o Orelha sobe no boot, mesmo sem login"
  fi
  systemctl --user daemon-reload
  systemctl --user enable "$UNIT" >/dev/null
  systemctl --user restart "$UNIT"
  saude
  # Só acrescenta esta porta; a configuração do serve em outras portas fica como está.
  "$TAILSCALE" serve --bg --https="$PUBLIC_PORT" "http://127.0.0.1:$PORT"
  ok "Publicado em https://$TAILNET_HOST:$PUBLIC_PORT"
}

# Traz a versão mais nova do branch atual, testa e reinicia. Dados em data/ não são tocados.
atualizar() {
  [ -f "$UNIT_FILE" ] || falha "Serviço não instalado. Rode 'scripts/servico-linux.sh instalar' primeiro."
  [ -z "$(git -C "$PROJECT" status --porcelain --untracked-files=no)" ] \
    || falha "Há alterações não commitadas em $PROJECT. Faça commit ou descarte antes de atualizar."
  local antes
  antes="$(versao_local)"
  git -C "$PROJECT" pull --ff-only
  verificar
  systemctl --user restart "$UNIT"
  saude
  echo "Versão $antes → $(versao_local). Veja o que mudou em CHANGELOG.md."
}

reiniciar() {
  systemctl --user restart "$UNIT"
  saude
}

remover() {
  systemctl --user disable --now "$UNIT" 2>/dev/null || true
  rm -f "$UNIT_FILE"
  systemctl --user daemon-reload
  if [ -n "$TAILSCALE" ]; then "$TAILSCALE" serve --https="$PUBLIC_PORT" off || true; fi
  echo "Serviço removido. Seus dados continuam em $PROJECT/data. O linger continua ligado (sudo loginctl disable-linger $USER desliga)."
}

status() {
  systemctl --user --no-pager status "$UNIT" 2>/dev/null | head -n 5 || echo "Serviço não está carregado."
  "$NODE" -e 'fetch(process.argv[1], { signal: AbortSignal.timeout(2000) }).then((r) => r.text()).then(console.log).catch(() => console.log("Sem resposta em " + process.argv[1]))' "http://127.0.0.1:$PORT/api/health"
  if [ -n "$TAILSCALE" ]; then "$TAILSCALE" serve status; fi
}

logs() {
  journalctl --user -u "$UNIT" -n 100 -f
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
