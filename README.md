# cwac-telegram-adapter

> **Control your AI agents from Telegram. Run `install.sh` once — works 24/7.**

A standalone Telegram adapter for [connect-with-all-code](https://github.com/rrrkj/connect-with-all-code). It bridges your Telegram bot with AI agents (opencode, Claude, Gemini) running on your server — no manual pairing, no babysitting, fully automated via systemd.

---

## ✨ Features

- **One-command setup** — `bash install.sh` and you're done
- **24/7 operation** — systemd services auto-restart on crash or reboot
- **Auto-pair** — gateway and connector connect automatically, no manual `/pair` steps
- **Session memory** — conversation history persists across messages (opencode)
- **Token stats** — every response shows tokens used, cache hits, cost, session ID
- **Allowlist** — restrict access to specific Telegram chat IDs
- **Polling mode** — works behind any NAT/firewall, no webhook/SSL needed
- **Self-healing** — bot polling auto-restarts on network timeouts

---

## 🚀 Quick Start

```bash
git clone https://github.com/rrrkj/cwac-telegram-adapter
cd cwac-telegram-adapter
bash install.sh
```

The script will:
1. Check/install Node.js 18+
2. Clone and build `connect-with-all-code`
3. Ask for your **Telegram Bot Token** (from [@BotFather](https://t.me/BotFather))
4. Ask for your **Telegram chat ID** (from [@userinfobot](https://t.me/userinfobot))
5. Generate a `CONNECTOR_SECRET` for auto-pairing
6. Create and start two systemd services

**That's it.** Open Telegram and send `/help` to your bot.

---

## 💬 Bot Commands

| Command | Description |
|---|---|
| `/help` | Show all commands |
| `/status` | Check which agents are available |
| `/default opencode` | Set default agent |
| `/history` | View recent tasks |
| `/cancel` | Cancel current task |
| `hello world` | Send to default agent (opencode) |
| `/opencode write me a script` | Send to specific agent |

---

## 🏗️ Architecture

```
Telegram ←──→ Bot (polling) ←──→ Gateway (WebSocket :3001)
                                        ↕
                                  Connector ←──→ opencode CLI
```

Two systemd services:
- **`cwac-telegram.service`** — Telegram gateway (WebSocket server)
- **`cwac-connector.service`** — Agent connector (spawns AI CLIs)

The connector auto-pairs with the gateway using a shared `CONNECTOR_SECRET` generated at install time. On any restart, they re-pair automatically within ~8 seconds.

---

## ⚙️ Configuration

| Variable | Description |
|---|---|
| `TELEGRAM_BOT_TOKEN` | From @BotFather |
| `TELEGRAM_USER_ID` | Your Telegram numeric ID |
| `ALLOWLIST_CHAT_IDS` | Comma-separated allowed chat IDs |
| `CONNECTOR_SECRET` | Auto-generated, shared between services |
| `PORT` | WebSocket port (default: 3001) |

---

## 🔧 Useful Commands

```bash
# View logs
journalctl -u cwac-telegram -f
journalctl -u cwac-connector -f

# Restart everything
sudo systemctl restart cwac-telegram cwac-connector

# Re-run installer (idempotent, safe to re-run)
bash install.sh
```

---

## 📋 Requirements

- Linux with systemd
- Node.js 18+ (auto-installed if missing)
- A Telegram bot token from [@BotFather](https://t.me/BotFather)
- At least one AI agent CLI installed (e.g. `opencode`)

---

## License

MIT
