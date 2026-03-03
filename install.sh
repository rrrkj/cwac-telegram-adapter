#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════════════════
#  cwac-telegram-adapter — install.sh
#
#  Run ONCE. Everything is automated:
#    • Node.js check/install
#    • connect-with-all-code clone/build
#    • Telegram bot token setup
#    • Generates a CONNECTOR_SECRET so gateway & connector auto-pair forever
#    • systemd services (auto-start on reboot, 24/7)
#
#  After this script completes, use Telegram. That's it. Nothing else to do.
# ═══════════════════════════════════════════════════════════════════════════════

set -euo pipefail

# ─── Colours ──────────────────────────────────────────────────────────────────
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'
BLUE='\033[0;34m'; CYAN='\033[0;36m'; BOLD='\033[1m'; NC='\033[0m'

# ─── Paths ────────────────────────────────────────────────────────────────────
ADAPTER_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CWAC_DIR="/root/connect-with-all-code"
ENV_FILE="${ADAPTER_DIR}/.env"
CONNECTOR_ENV_FILE="${ADAPTER_DIR}/.connector.env"
SYSTEMD_DIR="/etc/systemd/system"

# Prefer existing local copy
if [ -d "/root/connect-with-all-code" ]; then
    CWAC_DIR="/root/connect-with-all-code"
fi

# ─── Helpers ──────────────────────────────────────────────────────────────────
info()  { echo -e "  ${GREEN}✔${NC}  $*"; }
warn()  { echo -e "  ${YELLOW}⚠${NC}   $*"; }
error() { echo -e "  ${RED}✘${NC}  $*" >&2; }
step()  { echo -e "\n${BOLD}${BLUE}▶  $*${NC}"; }
die()   { error "$1"; exit 1; }

# ─── Banner ───────────────────────────────────────────────────────────────────
echo ""
echo -e "${BOLD}${CYAN}"
echo "  ╔══════════════════════════════════════════════════════╗"
echo "  ║   ConnectWithAllCode — Telegram Adapter Installer    ║"
echo "  ║      Run once. Use Telegram forever. 24/7.           ║"
echo "  ╚══════════════════════════════════════════════════════╝"
echo -e "${NC}"
echo ""

# ─── Pre-flight ───────────────────────────────────────────────────────────────
step "Pre-flight checks..."

if [ "$EUID" -ne 0 ] && ! sudo -n true 2>/dev/null; then
    die "Needs sudo to install systemd services. Run: sudo bash install.sh"
fi

if [ -f /etc/os-release ]; then
    . /etc/os-release; info "OS: $PRETTY_NAME"
fi

command -v systemctl &>/dev/null || die "systemd required"
info "systemd: OK"

# ─── Node.js ──────────────────────────────────────────────────────────────────
step "Checking Node.js (need v18+)..."

NODE_MIN=18
install_node() {
    warn "Installing Node.js ${NODE_MIN} via NodeSource..."
    if command -v apt-get &>/dev/null; then
        curl -fsSL "https://deb.nodesource.com/setup_${NODE_MIN}.x" | sudo -E bash -
        sudo apt-get install -y nodejs
    elif command -v dnf &>/dev/null; then
        curl -fsSL "https://rpm.nodesource.com/setup_${NODE_MIN}.x" | sudo bash -
        sudo dnf install -y nodejs
    else
        die "Cannot auto-install Node.js. Install v${NODE_MIN}+ manually: https://nodejs.org"
    fi
}

if command -v node &>/dev/null; then
    VER=$(node -e "process.stdout.write(process.versions.node.split('.')[0])")
    [ "$VER" -lt "$NODE_MIN" ] && install_node || info "Node.js v$(node --version): OK"
else
    install_node
fi
command -v npm &>/dev/null || die "npm not found"
info "npm v$(npm --version): OK"

# ─── Clone / update cwac ──────────────────────────────────────────────────────
step "Setting up connect-with-all-code..."

if [ -d "${CWAC_DIR}/.git" ]; then
    info "Repo found at ${CWAC_DIR} — pulling latest..."
    git -C "${CWAC_DIR}" pull --ff-only 2>/dev/null || warn "git pull skipped (local changes?)"
elif [ -d "${CWAC_DIR}" ] && [ -f "${CWAC_DIR}/package.json" ]; then
    info "Found local copy at ${CWAC_DIR}"
else
    echo ""
    echo -e "  ${BOLD}Git URL for connect-with-all-code${NC}"
    echo "  (Leave empty to use: https://github.com/rrrkj/connect-with-all-code.git)"
    read -rp "  > " CWAC_URL
    CWAC_URL="${CWAC_URL:-https://github.com/rrrkj/connect-with-all-code.git}"
    git clone "${CWAC_URL}" "${CWAC_DIR}" || die "Clone failed"
fi

step "Building cwac (shared + connector)..."
cd "${CWAC_DIR}"
npm install --silent 2>&1 | tail -1

# ── Apply session-persistence patch to the opencode agent ──────────────────
# Our patch adds --session support so conversation history persists across
# messages. Without this, every Telegram message starts a fresh session.
PATCH_SRC="${ADAPTER_DIR}/patches/cwac-opencode-agent.ts"
PATCH_DST="${CWAC_DIR}/connector/src/agents/opencode.ts"
if [ -f "${PATCH_SRC}" ]; then
    cp "${PATCH_SRC}" "${PATCH_DST}"
    info "Session-persistence patch applied to opencode agent"
else
    warn "Patch file not found at ${PATCH_SRC} — session memory may not work"
fi

npm run build -w shared 2>&1 | grep -iE 'error' || true
npm run build -w connector 2>&1 | grep -iE 'error' || true
info "cwac built"
cd "${ADAPTER_DIR}"

# ─── Adapter dependencies ─────────────────────────────────────────────────────
step "Installing adapter dependencies..."
npm install --silent 2>&1 | tail -1
info "Done"

# ─── Read existing .env values (for re-run idempotency) ───────────────────────
read_env() { grep "^$1=" "${ENV_FILE}" 2>/dev/null | cut -d'=' -f2- | tr -d '\n' || true; }

EXISTING_TOKEN="$(read_env TELEGRAM_BOT_TOKEN)"
EXISTING_ALLOWLIST="$(read_env ALLOWLIST_CHAT_IDS)"
EXISTING_PORT="$(read_env PORT)"
EXISTING_SECRET="$(read_env CONNECTOR_SECRET)"
EXISTING_USER_ID="$(read_env TELEGRAM_USER_ID)"

# ─── Configuration prompts ────────────────────────────────────────────────────
step "Configuration"
echo ""

# ── Bot token ─────────────────────────────────────────────────────────────────
if [ -n "${EXISTING_TOKEN}" ]; then
    echo -e "  ${BOLD}Telegram Bot Token${NC} (current: ${EXISTING_TOKEN:0:10}...)"
    echo "  Press ENTER to keep it, or paste a new one:"
    read -rp "  > " INPUT_TOKEN
    TELEGRAM_BOT_TOKEN="${INPUT_TOKEN:-$EXISTING_TOKEN}"
else
    echo -e "  ${BOLD}Get your Telegram Bot Token from @BotFather:${NC}"
    echo "  1. Open Telegram → search @BotFather → send /newbot"
    echo "  2. Copy the token it gives you"
    echo ""
    while true; do
        read -rp "  Bot token: " TELEGRAM_BOT_TOKEN
        [ -n "${TELEGRAM_BOT_TOKEN}" ] && break
        error "Token cannot be empty."
    done
fi
info "Bot token: set"

# ── Allowlist chat IDs ────────────────────────────────────────────────────────
echo ""
if [ -n "${EXISTING_ALLOWLIST}" ]; then
    echo -e "  ${BOLD}Allowlist chat IDs${NC} (current: ${EXISTING_ALLOWLIST})"
    echo "  Press ENTER to keep, or enter new comma-separated IDs:"
    read -rp "  > " INPUT_ALLOWLIST
    ALLOWLIST_CHAT_IDS="${INPUT_ALLOWLIST:-$EXISTING_ALLOWLIST}"
else
    echo -e "  ${BOLD}Your Telegram Chat ID (allowlist)${NC}"
    echo "  → Message @userinfobot on Telegram to find your ID"
    echo "  → Multiple users: comma-separated e.g. 123456789,987654321"
    echo "  → Leave empty = allow ALL users (not recommended)"
    echo ""
    read -rp "  Chat IDs: " ALLOWLIST_CHAT_IDS
fi

if [ -n "${ALLOWLIST_CHAT_IDS}" ]; then
    info "Allowlist: ${ALLOWLIST_CHAT_IDS}"
else
    warn "No allowlist — all Telegram users can control your agents!"
fi

# ── Primary user ID for auto-pair ─────────────────────────────────────────────
# Use first allowlist ID if set, otherwise ask
if [ -n "${ALLOWLIST_CHAT_IDS}" ]; then
    TELEGRAM_USER_ID="${ALLOWLIST_CHAT_IDS%%,*}"  # first ID
else
    if [ -n "${EXISTING_USER_ID}" ]; then
        TELEGRAM_USER_ID="${EXISTING_USER_ID}"
    else
        echo ""
        echo -e "  ${BOLD}Primary Telegram User ID${NC} (for auto-connecting the connector)"
        echo "  This is your Telegram numeric ID (from @userinfobot)"
        read -rp "  Your Telegram user ID: " TELEGRAM_USER_ID
    fi
fi
info "Primary user ID: ${TELEGRAM_USER_ID}"

# ── Port ──────────────────────────────────────────────────────────────────────
echo ""
DEFAULT_PORT="${EXISTING_PORT:-3001}"
read -rp "  WebSocket port [${DEFAULT_PORT}]: " INPUT_PORT
GATEWAY_PORT="${INPUT_PORT:-$DEFAULT_PORT}"
info "Port: ${GATEWAY_PORT}"

# ── Connector secret (auto-pair code, generated once, never changes) ──────────
if [ -n "${EXISTING_SECRET}" ]; then
    CONNECTOR_SECRET="${EXISTING_SECRET}"
    info "Connector secret: reusing existing (auto-pair stays active)"
else
    # Generate a cryptographically random secret
    CONNECTOR_SECRET="$(node -e "process.stdout.write(require('crypto').randomBytes(16).toString('hex'))")"
    info "Connector secret: generated"
fi

# ─── Write .env ───────────────────────────────────────────────────────────────
step "Writing configuration files..."

cat > "${ENV_FILE}" << EOF
# cwac-telegram-adapter — generated $(date)

TELEGRAM_BOT_TOKEN=${TELEGRAM_BOT_TOKEN}

# Comma-separated Telegram chat IDs allowed to control agents
ALLOWLIST_CHAT_IDS=${ALLOWLIST_CHAT_IDS}

# Primary Telegram user ID — connector is auto-paired to serve this user
TELEGRAM_USER_ID=${TELEGRAM_USER_ID}

# Fixed secret shared between gateway and connector for auto-pairing
# DO NOT CHANGE — changing requires restarting both services
CONNECTOR_SECRET=${CONNECTOR_SECRET}

PORT=${GATEWAY_PORT}

CWAC_PATH=${CWAC_DIR}
EOF
chmod 600 "${ENV_FILE}"
info ".env written (chmod 600)"

# Write connector config (cwac reads from ~/.cwac/config.yaml)
CWAC_CONFIG_DIR="${HOME}/.cwac"
CWAC_CONFIG_FILE="${CWAC_CONFIG_DIR}/config.yaml"
mkdir -p "${CWAC_CONFIG_DIR}"
cat > "${CWAC_CONFIG_FILE}" << EOF
# connect-with-all-code connector config — managed by cwac-telegram-adapter/install.sh
agents:
  claude:
    enabled: false
    command: claude
  gemini:
    enabled: false
    command: gemini
  codex:
    enabled: false
    command: codex
  opencode:
    enabled: true
    command: opencode
defaults:
  agent: opencode
  workspace: ~/projects
gateway:
  url: ws://localhost:${GATEWAY_PORT}/ws
EOF
info "~/.cwac/config.yaml written (opencode enabled, gateway: port ${GATEWAY_PORT})"

# Write connector env (pairing code = CONNECTOR_SECRET)
cat > "${CONNECTOR_ENV_FILE}" << EOF
# Connector service env — managed by install.sh
PAIRING_CODE=${CONNECTOR_SECRET}
GATEWAY_URL=ws://localhost:${GATEWAY_PORT}/ws
EOF
chmod 600 "${CONNECTOR_ENV_FILE}"
info ".connector.env written"

# ─── Build adapter ────────────────────────────────────────────────────────────
step "Building Telegram adapter..."
npm run build 2>&1 | grep -iE 'error' || true
[ -f "${ADAPTER_DIR}/dist/index.js" ] || die "Build failed — dist/index.js not found"
info "Build OK: dist/index.js"

NODE_BIN="$(which node)"

# ─── Systemd: Telegram gateway ────────────────────────────────────────────────
step "Setting up systemd services..."

sudo tee "${SYSTEMD_DIR}/cwac-telegram.service" > /dev/null << EOF
# ConnectWithAllCode — Telegram Gateway  (generated $(date))
[Unit]
Description=ConnectWithAllCode Telegram Gateway
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=${USER:-root}
WorkingDirectory=${ADAPTER_DIR}
EnvironmentFile=${ENV_FILE}
ExecStart=${NODE_BIN} ${ADAPTER_DIR}/dist/index.js
Restart=always
RestartSec=5
StandardOutput=journal
StandardError=journal
SyslogIdentifier=cwac-telegram
LimitNOFILE=65535

[Install]
WantedBy=multi-user.target
EOF
info "cwac-telegram.service written"

# ─── Systemd: Connector ───────────────────────────────────────────────────────
sudo tee "${SYSTEMD_DIR}/cwac-connector.service" > /dev/null << EOF
# ConnectWithAllCode — Connector Agent  (generated $(date))
[Unit]
Description=ConnectWithAllCode Connector Agent
After=cwac-telegram.service network-online.target
BindsTo=cwac-telegram.service

[Service]
Type=simple
User=${USER:-root}
WorkingDirectory=${CWAC_DIR}
EnvironmentFile=${CONNECTOR_ENV_FILE}
ExecStartPre=/bin/sleep 6
ExecStart=${NODE_BIN} ${CWAC_DIR}/connector/dist/index.js --pair \${PAIRING_CODE}
Restart=always
RestartSec=8
StandardOutput=journal
StandardError=journal
SyslogIdentifier=cwac-connector
LimitNOFILE=65535

[Install]
WantedBy=multi-user.target
EOF
info "cwac-connector.service written (BindsTo gateway)"

# ─── Enable & start ───────────────────────────────────────────────────────────
step "Enabling services and starting..."

sudo systemctl daemon-reload
sudo systemctl enable cwac-telegram.service cwac-connector.service

# Start / restart gateway
sudo systemctl restart cwac-telegram.service
echo -n "  ⏳ Waiting for gateway..."
for i in {1..20}; do
    if curl -s "http://localhost:${GATEWAY_PORT}/health" > /dev/null 2>&1; then
        echo ""; info "Gateway health check: OK (port ${GATEWAY_PORT})"; break
    fi
    printf '.'; sleep 1
    if [ "$i" -eq 20 ]; then
        echo ""; warn "Gateway health check timed out — check: journalctl -u cwac-telegram -f"
    fi
done

# Start / restart connector
sudo systemctl restart cwac-connector.service
sleep 6  # connector needs time to pair

CONN_STATUS=$(systemctl is-active cwac-connector.service 2>/dev/null || echo "unknown")
if [ "$CONN_STATUS" = "active" ]; then
    info "Connector service: running ✔"
else
    warn "Connector status: ${CONN_STATUS} — check: journalctl -u cwac-connector -f"
fi

# ─── Done ─────────────────────────────────────────────────────────────────────

GW_STATUS=$(systemctl is-active cwac-telegram.service 2>/dev/null || echo "?")
CO_STATUS=$(systemctl is-active cwac-connector.service 2>/dev/null || echo "?")

echo ""
echo -e "${BOLD}${GREEN}═══════════════════════════════════════════════════════════${NC}"
echo -e "${BOLD}${GREEN}  ✅ Installation Complete — Everything runs automatically!${NC}"
echo -e "${BOLD}${GREEN}═══════════════════════════════════════════════════════════${NC}"
echo ""
echo -e "  ${BOLD}Services:${NC}"
fmt_status() { [ "$1" = "active" ] && echo -e "${GREEN}running 24/7${NC}" || echo -e "${RED}$1${NC}"; }
echo -e "  • cwac-telegram (gateway):  $(fmt_status "$GW_STATUS")"
echo -e "  • cwac-connector (agents):  $(fmt_status "$CO_STATUS")"
echo ""
echo -e "  ${BOLD}Logs:${NC}"
echo "  journalctl -u cwac-telegram -f    ← gateway / Telegram"
echo "  journalctl -u cwac-connector -f   ← agent connector"
echo ""
echo -e "  ${BOLD}To restart everything:${NC}"
echo "  sudo systemctl restart cwac-telegram cwac-connector"
echo ""
echo -e "${CYAN}  Your bot auto-starts on reboot. Open Telegram and send /help 🚀${NC}"
echo ""
echo -e "  ${BOLD}First message commands:${NC}"
echo "  /help             ← see all commands"
echo "  /status           ← check agent status"
echo "  hello world       ← send to default agent (opencode)"
echo ""
