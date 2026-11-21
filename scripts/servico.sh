#!/bin/zsh
# Implanta e mantém o Orelha no ar no macOS: LaunchAgent do usuário + tailscale serve na porta pública do config.json.
# Uso: scripts/servico.sh verificar | instalar | atualizar | reiniciar | backup | status | logs | remover
set -euo pipefail

LABEL="com.orelha.server"
BACKUP_LABEL="com.orelha.backup"
PROJECT="${0:A:h:h}"
AGENTS="$HOME/Library/LaunchAgents"
PLIST="$AGENTS/$LABEL.plist"
BACKUP_PLIST="$AGENTS/$BACKUP_LABEL.plist"
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

# Pastas temporárias e worktrees de teste somem ao sair, com sucesso ou falha.
TMP=""
limpar() {
  [ -n "$TMP" ] || return 0
  if [ -d "$TMP/candidata" ]; then git -C "$PROJECT" worktree remove --force "$TMP/candidata" 2>/dev/null || true; fi
  rm -rf "$TMP"
}
trap limpar EXIT
tmpdir() { [ -n "$TMP" ] || TMP="$(mktemp -d)"; }

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

  (cd "$PROJECT" && "$NODE" --test >/dev/null 2>&1) || falha "Os testes falharam. Rode 'npm test' para ver o motivo."
  ok "Testes passaram (versão $(versao_local))"
}

# Imprime "versão pid" de quem responde na porta local, ou nada.
health() {
  "$NODE" -e 'fetch(process.argv[1], { signal: AbortSignal.timeout(2000) }).then((r) => r.json()).then((j) => console.log(`${j.version ?? "?"} ${j.pid ?? "?"}`)).catch(() => {})' "http://127.0.0.1:$PORT/api/health"
}
pid_do_servico() {
  local pid="$(launchctl print "$DOMAIN/$LABEL" 2>/dev/null | awk '$1 == "pid" && $2 == "=" { print $3; exit }')"
  echo "${pid:-0}"
}
carregado() { launchctl print "$DOMAIN/$LABEL" >/dev/null 2>&1; }

# Espera o processo do serviço responder e confere que é ele (pelo pid) e que roda a versão do disco.
# Devolve erro em vez de sair, para quem chamou poder desfazer.
saude() {
  local esperada="$(versao_local)" resposta="" servico=0
  for _ in {1..20}; do
    servico="$(pid_do_servico)"
    resposta="$(health)"
    [ -n "$resposta" ] && [ "$servico" != 0 ] && [ "${resposta#* }" = "$servico" ] && break
    sleep 0.5
  done
  if [ -z "$resposta" ]; then
    aviso "O servidor não respondeu em http://127.0.0.1:$PORT. Veja 'scripts/servico.sh logs'."; return 1
  fi
  if [ "${resposta#* }" != "$servico" ]; then
    aviso "Quem responde em :$PORT é o processo ${resposta#* }, não o serviço (pid $servico). Outro programa ocupa a porta."; return 1
  fi
  if [ "${resposta% *}" != "$esperada" ]; then
    aviso "No ar está a versão ${resposta% *}, mas o disco tem $esperada."; return 1
  fi
  ok "Orelha $esperada respondendo em http://127.0.0.1:$PORT (pid $servico)"
}

# Um clone novo vem sem data/. Se o serviço atual roda de outra pasta que tem o banco, instalar daqui mostraria a estante vazia.
checar_dados() {
  [ -f "$PLIST" ] || return 0
  local antigo="$(/usr/libexec/PlistBuddy -c 'Print :WorkingDirectory' "$PLIST" 2>/dev/null || true)"
  [ -n "$antigo" ] && [ "$antigo" != "$PROJECT" ] || return 0
  if [ -f "$antigo/data/orelha.sqlite" ] && [ ! -f "$PROJECT/data/orelha.sqlite" ] && [ -z "${ORELHA_BANCO_NOVO:-}" ]; then
    falha "O serviço atual roda de $antigo, onde estão seus dados, e este clone não tem banco. Para atualizar aquela instalação: cd $antigo && scripts/servico.sh atualizar. Para mudar de pasta, pare o serviço e copie $antigo/data para $PROJECT/data antes. Para começar do zero de propósito: ORELHA_BANCO_NOVO=1."
  fi
}

# Se algo já responde na porta e não é este serviço, o teste de saúde poderia conversar com o processo errado.
checar_porta() {
  local resposta="$(health)"
  [ -n "$resposta" ] || return 0
  if ! carregado || [ "$(pid_do_servico)" = 0 ]; then
    falha "A porta $PORT já está em uso por outro processo (pid ${resposta#* }), e o $LABEL não está rodando. Pare esse processo ou mude 'port' no config.json."
  fi
}

# Caminhos com &, < ou > quebrariam o XML do plist.
xml() { local s="$1"; s="${s//&/&amp;}"; s="${s//</&lt;}"; s="${s//>/&gt;}"; print -r -- "$s"; }

escrever_plists() {
  local dir="$1" node="$(xml "$NODE")" projeto="$(xml "$PROJECT")" log="$(xml "$LOG")"
  cat > "$dir/$LABEL.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$node</string>
    <string>$projeto/server/index.js</string>
  </array>
  <key>WorkingDirectory</key><string>$projeto</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>ProcessType</key><string>Background</string>
  <key>Umask</key><integer>63</integer>
  <key>StandardOutPath</key><string>$log</string>
  <key>StandardErrorPath</key><string>$log</string>
</dict>
</plist>
PLIST
  cat > "$dir/$BACKUP_LABEL.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$BACKUP_LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$node</string>
    <string>$projeto/scripts/backup.js</string>
  </array>
  <key>WorkingDirectory</key><string>$projeto</string>
  <key>StartCalendarInterval</key><dict><key>Hour</key><integer>4</integer><key>Minute</key><integer>0</integer></dict>
  <key>ProcessType</key><string>Background</string>
  <key>Umask</key><integer>63</integer>
  <key>StandardOutPath</key><string>$log</string>
  <key>StandardErrorPath</key><string>$log</string>
</dict>
</plist>
PLIST
}

# Recarrega um LaunchAgent a partir do plist em disco.
recarregar() {
  launchctl bootout "$DOMAIN/$1" 2>/dev/null || true
  launchctl bootstrap "$DOMAIN" "$AGENTS/$1.plist"
}

# Volta os plists anteriores (ou remove os novos, se não havia nenhum) e tenta subir o serviço antigo.
desfazer_plists() {
  local anterior="$1" nome
  for nome in "$LABEL" "$BACKUP_LABEL"; do
    launchctl bootout "$DOMAIN/$nome" 2>/dev/null || true
    if [ -f "$anterior/$nome.plist" ]; then
      cp -p "$anterior/$nome.plist" "$AGENTS/$nome.plist"
      launchctl bootstrap "$DOMAIN" "$AGENTS/$nome.plist" || true
    else
      rm -f "$AGENTS/$nome.plist"
    fi
  done
}

instalar() {
  verificar
  checar_dados
  checar_porta
  mkdir -p "$PROJECT/data" "$AGENTS"
  chmod 700 "$PROJECT/data"
  find "$PROJECT/data" -maxdepth 1 -name 'orelha.sqlite*' -exec chmod 600 {} +

  # Gera e valida os plists numa pasta à parte; os atuais só são trocados depois.
  tmpdir
  mkdir -p "$TMP/novos" "$TMP/anteriores"
  escrever_plists "$TMP/novos"
  plutil -lint "$TMP/novos/$LABEL.plist" "$TMP/novos/$BACKUP_LABEL.plist" >/dev/null \
    || falha "Os plists gerados são inválidos; nada foi mudado. Veja $TMP/novos."
  local nome
  for nome in "$LABEL" "$BACKUP_LABEL"; do
    if [ -f "$AGENTS/$nome.plist" ]; then cp -p "$AGENTS/$nome.plist" "$TMP/anteriores/$nome.plist"; fi
  done

  cp "$TMP/novos/$LABEL.plist" "$PLIST"
  if ! { recarregar "$LABEL" && saude; }; then
    desfazer_plists "$TMP/anteriores"
    falha "O serviço novo não subiu; voltei a configuração anterior. Veja 'scripts/servico.sh logs'."
  fi
  cp "$TMP/novos/$BACKUP_LABEL.plist" "$BACKUP_PLIST"
  recarregar "$BACKUP_LABEL"
  ok "Backup diário ligado ($BACKUP_LABEL, às 4h)"
  # Só acrescenta esta porta; a configuração do serve em outras portas fica como está.
  "$TAILSCALE" serve --bg --https="$PUBLIC_PORT" "http://127.0.0.1:$PORT" \
    || falha "O serviço está no ar em http://127.0.0.1:$PORT, mas o tailscale serve falhou. Rode de novo: tailscale serve --bg --https=$PUBLIC_PORT http://127.0.0.1:$PORT"
  ok "Publicado em https://$TAILNET_HOST:$PUBLIC_PORT"
}

# Traz a versão mais nova do branch atual. Testa numa cópia à parte, faz backup, troca e reinicia;
# se a versão nova não subir, volta para a anterior.
atualizar() {
  [ -f "$PLIST" ] || falha "Serviço não instalado. Rode 'scripts/servico.sh instalar' primeiro."
  [ -z "$(git -C "$PROJECT" status --porcelain --untracked-files=no)" ] \
    || falha "Há alterações não commitadas em $PROJECT. Faça commit ou descarte antes de atualizar."
  git -C "$PROJECT" fetch --quiet
  local antes="$(git -C "$PROJECT" rev-parse HEAD)" alvo versao_antes copia
  alvo="$(git -C "$PROJECT" rev-parse '@{u}' 2>/dev/null)" || falha "O branch atual não segue nenhum branch remoto."
  if [ "$antes" = "$alvo" ]; then ok "Já está na versão mais nova ($(versao_local))."; return 0; fi
  git -C "$PROJECT" merge-base --is-ancestor "$antes" "$alvo" \
    || falha "O branch local divergiu do remoto; resolva à mão antes de atualizar."

  tmpdir
  git -C "$PROJECT" worktree add --quiet --detach "$TMP/candidata" "$alvo"
  (cd "$TMP/candidata" && "$NODE" --test >/dev/null 2>&1) \
    || falha "Os testes da versão nova (${alvo:0:7}) falharam; nada foi mudado. Rode 'npm test' num clone dela para ver o motivo."
  ok "Testes da versão nova passaram"

  copia="$("$NODE" "$PROJECT/scripts/backup.js")" || falha "O backup falhou; atualização cancelada, nada foi mudado."
  echo "$copia"
  copia="${copia#*Backup em }"; copia="${copia%% (*}"
  versao_antes="$(versao_local)"
  git -C "$PROJECT" merge --ff-only --quiet "$alvo"
  if ! { launchctl kickstart -k "$DOMAIN/$LABEL" && saude; }; then
    aviso "A versão nova não subiu. Voltando para ${antes:0:7}."
    git -C "$PROJECT" reset --hard --quiet "$antes"
    launchctl kickstart -k "$DOMAIN/$LABEL" || true
    saude || falha "A versão anterior também não subiu. Veja 'scripts/servico.sh logs'. Backup do banco: $copia"
    falha "Atualização desfeita; o Orelha voltou para $versao_antes. Se a versão nova chegou a mexer no banco, a cópia de antes está em $copia"
  fi
  echo "Versão $versao_antes → $(versao_local). Veja o que mudou em CHANGELOG.md."
}

reiniciar() {
  launchctl kickstart -k "$DOMAIN/$LABEL"
  saude || exit 1
}

backup() { "$NODE" "$PROJECT/scripts/backup.js"; }

remover() {
  launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
  launchctl bootout "$DOMAIN/$BACKUP_LABEL" 2>/dev/null || true
  rm -f "$PLIST" "$BACKUP_PLIST"
  if [ -n "$TAILSCALE" ]; then "$TAILSCALE" serve --https="$PUBLIC_PORT" off || true; fi
  echo "Serviço removido. Seus dados continuam em $PROJECT/data."
}

status() {
  launchctl print "$DOMAIN/$LABEL" 2>/dev/null | grep -E '^\s+(state|pid|last exit code) =' || echo "Serviço não está carregado."
  curl -fsS --max-time 2 "http://127.0.0.1:$PORT/api/health" 2>/dev/null && echo || echo "Sem resposta em http://127.0.0.1:$PORT."
  if [ -n "$TAILSCALE" ]; then "$TAILSCALE" serve status; fi
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
  backup) backup ;;
  status) status ;;
  logs) logs ;;
  remover) remover ;;
  *) echo "Uso: $0 verificar | instalar | atualizar | reiniciar | backup | status | logs | remover"; exit 1 ;;
esac
