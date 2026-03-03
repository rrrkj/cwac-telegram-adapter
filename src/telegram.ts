import TelegramBot from 'node-telegram-bot-api';
import pino from 'pino';

const logger = pino({ name: 'telegram' });

const MAX_MESSAGE_LENGTH = 4096;

let bot: TelegramBot | null = null;
let inboundHandler: ((chatId: string, text: string) => void) | null = null;

interface TelegramConfig {
    token: string;
    allowlist?: string[]; // Telegram chat IDs allowed to use the bot
}

/**
 * Initialize the Telegram bot using long-polling.
 * No webhook/SSL setup needed — polling works behind any NAT/firewall.
 *
 * IMPORTANT: We pass allowed_updates with 'message' explicitly so Telegram
 * delivers text messages (including bot commands like /pair /help etc).
 * Without this, the Telegram API may silently skip message updates.
 * We also delete any leftover webhook before starting — a stale webhook
 * blocks polling from ever receiving messages.
 */
export async function initTelegram(cfg: TelegramConfig): Promise<void> {
    const { token, allowlist = [] } = cfg;

    if (!token) {
        throw new Error('TELEGRAM_BOT_TOKEN is required. Get one from @BotFather on Telegram.');
    }

    // Step 1: Clear any leftover webhook using a non-polling instance.
    // A stale webhook silently blocks all polling updates — this is a very
    // common "bot not responding" root cause.
    const setupBot = new TelegramBot(token, { polling: false });
    try {
        await setupBot.deleteWebHook();
        logger.info('Cleared any existing webhook — polling is now active');
    } catch {
        // Webhook may not have been set — that's fine
    }

    // Step 2: Start the real polling bot with explicit allowed_updates.
    bot = new TelegramBot(token, {
        polling: {
            interval: 1000,     // poll every second
            autoStart: true,
            params: {
                timeout: 10,
                // CRITICAL: without this, Telegram may not send 'message' updates
                // to long-polling clients — resulting in zero inbound events.
                allowed_updates: ['message', 'edited_message'] as string[],
            },
        },
    });

    logger.info('🤖 Telegram bot initialized (polling mode, allowed_updates: message)');

    // ─── Central dispatch ─────────────────────────────────────────────────────

    const dispatch = (chatId: string, text: string) => {
        if (allowlist.length > 0 && !allowlist.includes(chatId)) {
            logger.warn({ chatId }, 'Message from non-allowlisted chat ID — ignoring');
            return;
        }

        logger.info({ chatId, text: text.substring(0, 120) }, '📨 Inbound Telegram message');

        if (inboundHandler) {
            try {
                inboundHandler(chatId, text);
            } catch (err: any) {
                logger.error({ err: err.message, chatId }, 'Error in inbound handler');
            }
        }
    };

    // ─── Primary handler: ALL text messages (inc. bot commands) ───────────────

    bot.on('message', (msg) => {
        const chatId = String(msg.chat.id);
        const text = msg.text;
        if (!text) return; // skip non-text (photos, stickers, etc.)
        dispatch(chatId, text);
    });

    // ─── Error Handling — auto-restart on fatal polling errors ────────────────

    let restartDelay = 3000;

    const restartPolling = async () => {
        if (!bot) return;
        try {
            await bot.stopPolling();
        } catch { /* ignore */ }
        logger.info(`🔄 Restarting polling in ${restartDelay / 1000}s...`);
        setTimeout(async () => {
            if (!bot) return;
            try {
                await bot.startPolling();
                logger.info('✅ Polling restarted successfully');
                restartDelay = 3000; // reset backoff on success
            } catch (e: any) {
                logger.error({ err: e.message }, 'Polling restart failed — will try again');
                restartDelay = Math.min(restartDelay * 2, 30000);
                restartPolling();
            }
        }, restartDelay);
    };

    bot.on('polling_error', (err: any) => {
        if (err.code === 'ETELEGRAM' && err.message?.includes('409')) {
            logger.error('❌ 409 Conflict: Another bot instance is running with this token. This service will keep retrying.');
            restartDelay = Math.min(restartDelay * 2, 30000);
            restartPolling();
        } else if (err.code === 'EFATAL' || err.message?.includes('ETIMEDOUT') || err.message?.includes('ECONNRESET')) {
            logger.warn({ err: err.message }, '⚠️  Polling interrupted — restarting automatically');
            restartDelay = Math.min(restartDelay * 2, 30000);
            restartPolling();
        } else {
            logger.warn({ err: err.message }, 'Telegram polling warning (non-fatal)');
        }
    });

    bot.on('error', (err) => {
        logger.error({ err: err.message }, 'Telegram bot error');
    });


    // ─── Log bot info ─────────────────────────────────────────────────────────

    try {
        const me = await bot.getMe();
        logger.info(`✅ Telegram bot connected: @${me.username} (${me.first_name})`);
        logger.info('─'.repeat(50));
        logger.info(`📱 Open Telegram and message your bot: @${me.username}`);
        logger.info('   Send /start to begin, then /pair to connect your dev machine.');
        logger.info('─'.repeat(50));
    } catch (err: any) {
        logger.error({ err: err.message }, 'Failed to get bot info — check your token');
        throw err;
    }
}

/**
 * Register a handler for inbound Telegram messages.
 */
export function onInboundMessage(handler: (chatId: string, text: string) => void): void {
    inboundHandler = handler;
}

/**
 * Send a text message to a Telegram chat.
 * Automatically splits messages that exceed Telegram's 4096-character limit.
 * Uses Markdown parse mode for formatting (bold, code, etc.).
 */
export async function sendTextMessage(chatId: string, text: string): Promise<void> {
    if (!bot) {
        logger.error('Telegram bot not initialized');
        return;
    }

    const chunks = splitMessage(text, MAX_MESSAGE_LENGTH);

    for (const chunk of chunks) {
        try {
            await bot.sendMessage(chatId, chunk, {
                parse_mode: 'Markdown',
                disable_web_page_preview: true,
            });
        } catch (err: any) {
            // If Markdown parsing fails, retry as plain text
            if (err.message?.includes('parse') || err.message?.includes('Bad Request')) {
                try {
                    await bot.sendMessage(chatId, chunk);
                } catch (retryErr: any) {
                    logger.error({ retryErr: retryErr.message, chatId }, 'Failed to send message (plain text fallback)');
                }
            } else {
                logger.error({ err: err.message, chatId }, 'Failed to send Telegram message');
                throw new Error('Failed to send Telegram message');
            }
        }
    }
}

/**
 * Split a message into chunks that fit within Telegram's character limit.
 * Tries to split on newlines to keep code blocks intact.
 */
export function splitMessage(text: string, maxLength: number): string[] {
    if (text.length <= maxLength) return [text];

    const chunks: string[] = [];
    let remaining = text;

    while (remaining.length > 0) {
        if (remaining.length <= maxLength) {
            chunks.push(remaining);
            break;
        }

        let splitIndex = remaining.lastIndexOf('\n', maxLength);
        if (splitIndex === -1 || splitIndex < maxLength * 0.5) {
            splitIndex = maxLength;
        }

        chunks.push(remaining.slice(0, splitIndex));
        remaining = remaining.slice(splitIndex).replace(/^\n/, '');
    }

    if (chunks.length > 1) {
        return chunks.map((chunk, i) => `[${i + 1}/${chunks.length}]\n${chunk}`);
    }

    return chunks;
}

/**
 * Stop the Telegram bot gracefully.
 */
export async function stopTelegram(): Promise<void> {
    if (bot) {
        await bot.stopPolling();
        bot = null;
        logger.info('Telegram bot stopped');
    }
}
