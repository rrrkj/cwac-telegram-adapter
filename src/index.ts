import express from 'express';
import { createServer } from 'http';
import dotenv from 'dotenv';
import pino from 'pino';
import { initTelegram, onInboundMessage, onCallbackQuery } from './telegram';
import { initWsServer, onResult, onStatus, registerAutoPair } from './ws-server';
import { taskQueue } from './queue';
import { handleInboundMessage, handleTaskResultMessage, handleStatusResponse, handleSwitchCallback } from './router';

dotenv.config();

const logger = pino({
    name: 'cwac-telegram',
    transport: {
        target: 'pino-pretty',
        options: { colorize: true },
    },
});

// ─── Configuration ────────────────────────────────────────────────────────────

const PORT = parseInt(process.env.PORT || '3001', 10);
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const ALLOWLIST_CHAT_IDS = process.env.ALLOWLIST_CHAT_IDS
    ? process.env.ALLOWLIST_CHAT_IDS.split(',').map((id) => id.trim()).filter(Boolean)
    : [];

// Auto-pair: a fixed secret shared with the connector service.
// Generated once by install.sh and stored in .env — never changes.
const CONNECTOR_SECRET = process.env.CONNECTOR_SECRET || '';
// The primary Telegram user ID that the connector will serve.
const TELEGRAM_USER_ID = process.env.TELEGRAM_USER_ID || (ALLOWLIST_CHAT_IDS[0] ?? '');

if (!TELEGRAM_BOT_TOKEN) {
    logger.error('TELEGRAM_BOT_TOKEN is not set! Add it to your .env file.');
    logger.error('Get a token from @BotFather on Telegram: https://t.me/BotFather');
    process.exit(1);
}

// ─── Express App ──────────────────────────────────────────────────────────────

const app = express();
app.use(express.json());

app.get('/health', (_req, res) => {
    res.json({ status: 'ok', service: 'cwac-telegram-adapter', timestamp: new Date().toISOString() });
});

// ─── HTTP + WebSocket Server ───────────────────────────────────────────────────

const server = createServer(app);
initWsServer(server);

// ─── Auto-pair: pre-register the fixed connector secret ───────────────────────
// This makes the connector self-connect on every boot without user interaction.
if (CONNECTOR_SECRET && TELEGRAM_USER_ID) {
    registerAutoPair(TELEGRAM_USER_ID, CONNECTOR_SECRET);
    logger.info(`🔗 Auto-pair registered for user ${TELEGRAM_USER_ID} — connector will connect automatically`);
} else {
    logger.warn('CONNECTOR_SECRET or TELEGRAM_USER_ID not set — connector must pair manually via /pair');
}

// ─── Startup ──────────────────────────────────────────────────────────────────

(async () => {
    logger.info('─'.repeat(55));
    logger.info('🚀 ConnectWithAllCode — Telegram Adapter');
    logger.info('─'.repeat(55));

    try {
        await initTelegram({
            token: TELEGRAM_BOT_TOKEN,
            allowlist: ALLOWLIST_CHAT_IDS,
        });

        onInboundMessage((chatId, text) => {
            handleInboundMessage(chatId, text).catch((err) => {
                logger.error({ err: err.message, chatId }, 'Error handling inbound message');
            });
        });

        onCallbackQuery((chatId, data, queryId) => {
            handleSwitchCallback(chatId, data, queryId).catch((err) => {
                logger.error({ err: err.message, chatId }, 'Error handling callback query');
            });
        });

        if (ALLOWLIST_CHAT_IDS.length > 0) {
            logger.info({ allowlist: ALLOWLIST_CHAT_IDS }, `🔒 Allowlist: ${ALLOWLIST_CHAT_IDS.length} chat ID(s)`);
        } else {
            logger.warn('⚠️  No ALLOWLIST_CHAT_IDS — all Telegram users can control your agents');
        }
    } catch (err: any) {
        logger.error({ err: err.message }, 'Failed to initialize Telegram bot');
        process.exit(1);
    }
})();

// ─── Wire WebSocket Results → Telegram ────────────────────────────────────────

onResult((userId, result) => {
    taskQueue.completeTask(result);
    handleTaskResultMessage(userId, result.taskId, result.output, result.error).catch((err) => {
        logger.error({ err: err.message, userId }, 'Failed to send task result via Telegram');
    });
});

onStatus((userId, agents) => {
    handleStatusResponse(userId, agents).catch((err) => {
        logger.error({ err: err.message, userId }, 'Failed to send status response via Telegram');
    });
});

taskQueue.onTaskReady((task) => {
    logger.info({ taskId: task.id, agent: task.agent }, 'Task ready for dispatch');
});

// ─── Start Server ─────────────────────────────────────────────────────────────

server.listen(PORT, () => {
    logger.info('─'.repeat(55));
    logger.info(`🌐 WebSocket endpoint: ws://localhost:${PORT}/ws`);
    logger.info(`❤️  Health check:      http://localhost:${PORT}/health`);
    logger.info('─'.repeat(55));
});

export default app;
