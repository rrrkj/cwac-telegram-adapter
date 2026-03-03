import { v4 as uuidv4 } from 'uuid';
import pino from 'pino';
import {
    AgentType,
    AGENT_ALIASES,
    AGENT_DISPLAY_NAMES,
    AgentStatusMap,
} from './types';
import { parseCommand, getHelpText } from './parser';
import { sendTextMessage } from './telegram';
import { sessionManager } from './session';
import { taskQueue } from './queue';
import {
    dispatchTask,
    requestStatus,
    cancelTask,
    isDeviceConnected,
    createPairingCode,
} from './ws-server';

const logger = pino({ name: 'router' });

/**
 * Handle an inbound Telegram message.
 * userId is the Telegram chat ID (string).
 */
export async function handleInboundMessage(userId: string, message: string): Promise<void> {
    const parsed = parseCommand(message);

    switch (parsed.type) {
        case 'agent':
            await handleAgentCommand(userId, parsed.agent, parsed.prompt);
            break;

        case 'default_agent':
            await handleDefaultAgentCommand(userId, parsed.prompt);
            break;

        case 'system':
            await handleSystemCommand(userId, parsed.command, parsed.args);
            break;

        case 'error':
            await sendTextMessage(userId, `⚠️ ${parsed.message}`);
            break;
    }
}

async function handleAgentCommand(userId: string, agent: AgentType, prompt: string): Promise<void> {
    if (!isDeviceConnected(userId)) {
        await sendTextMessage(
            userId,
            '❌ No device connected.\n\nSend `/pair` to get a pairing code, then run the connector on your dev machine:\n```\nnpx cwac-connector start --pair <CODE>\n```'
        );
        return;
    }

    const session = sessionManager.getSession(userId);
    const displayName = AGENT_DISPLAY_NAMES[agent];

    await sendTextMessage(userId, `🤖 *${displayName}* | Task received. Running...`);

    // Prepend [SESSION:ses_xxx] if we have a prior session ID — lets opencode
    // continue the conversation with full history via --session flag
    const existingSessionId = sessionManager.getOpencodeSessionId(userId);
    const fullPrompt = (agent === AgentType.OPENCODE && existingSessionId)
        ? `[SESSION:${existingSessionId}] ${prompt}`
        : prompt;

    const task = taskQueue.enqueue(agent, fullPrompt, session.defaultWorkspace, userId);

    const dispatched = dispatchTask(userId, task);
    if (!dispatched) {
        await sendTextMessage(userId, `❌ Failed to dispatch to *${displayName}*. Device may have disconnected.`);
    }
}

async function handleDefaultAgentCommand(userId: string, prompt: string): Promise<void> {
    const session = sessionManager.getSession(userId);
    await handleAgentCommand(userId, session.defaultAgent, prompt);
}

async function handleSystemCommand(userId: string, command: string, args: string): Promise<void> {
    switch (command) {
        case '/start':
        case '/help':
            await sendTextMessage(userId, getHelpText());
            break;

        case '/status':
            await handleStatusCommand(userId);
            break;

        case '/default':
            await handleDefaultCommand(userId, args);
            break;

        case '/history':
            await handleHistoryCommand(userId);
            break;

        case '/cancel':
            await handleCancelCommand(userId);
            break;

        case '/new':
            sessionManager.clearOpencodeSession(userId);
            await sendTextMessage(userId, '🆕 *New session started.*\n\nYour conversation history has been cleared. The next message will start a fresh context.');
            break;

        case '/pair':
            await handlePairCommand(userId, args);
            break;

        default:
            await sendTextMessage(userId, `⚠️ Unknown command: ${command}`);
    }
}

async function handleStatusCommand(userId: string): Promise<void> {
    if (!isDeviceConnected(userId)) {
        await sendTextMessage(
            userId,
            '📊 *Agent Status*\n\n❌ No device connected.\nSend `/pair` to pair your dev machine.'
        );
        return;
    }

    const requested = requestStatus(userId);
    if (requested) {
        await sendTextMessage(userId, '📊 Checking agent status...');
    } else {
        await sendTextMessage(userId, '❌ Could not reach your device.');
    }
}

async function handleDefaultCommand(userId: string, args: string): Promise<void> {
    if (!args) {
        const session = sessionManager.getSession(userId);
        const displayName = AGENT_DISPLAY_NAMES[session.defaultAgent];
        await sendTextMessage(
            userId,
            `📌 Current defaults:\n• Agent: *${displayName}*\n• Workspace: \`${session.defaultWorkspace}\``
        );
        return;
    }

    const parts = args.trim().split(/\s+/);
    const agentArg = parts[0]?.toLowerCase() ?? '';
    const workspace = parts.slice(1).join(' ') || undefined;

    const aliasKey = agentArg.startsWith('/') ? agentArg : `/${agentArg}`;
    const agent = AGENT_ALIASES[aliasKey];

    if (!agent) {
        await sendTextMessage(
            userId,
            `⚠️ Unknown agent: \`${agentArg}\`\nAvailable: \`claude\`, \`gemini\`, \`codex\`, \`opencode\``
        );
        return;
    }

    const session = sessionManager.setDefaultAgent(userId, agent, workspace);
    const displayName = AGENT_DISPLAY_NAMES[agent];

    let msg = `✅ Default agent set to *${displayName}*`;
    if (workspace) {
        msg += `\n📁 Workspace: \`${workspace}\``;
    }
    await sendTextMessage(userId, msg);
}

async function handleHistoryCommand(userId: string): Promise<void> {
    const history = taskQueue.getHistory(userId, 10);

    if (history.length === 0) {
        await sendTextMessage(userId, '📜 No tasks in history yet.');
        return;
    }

    const lines = history.map((task) => {
        const status = task.status === 'completed' ? '✅' : task.status === 'failed' ? '❌' : '⏳';
        const agent = AGENT_DISPLAY_NAMES[task.agent];
        const timeAgo = getTimeAgo(task.createdAt);
        const promptPreview = task.prompt.length > 50 ? task.prompt.slice(0, 50) + '...' : task.prompt;
        return `${status} *${agent}* (${timeAgo})\n   ${promptPreview}`;
    });

    await sendTextMessage(userId, `📜 *Recent Tasks*\n\n${lines.join('\n\n')}`);
}

async function handleCancelCommand(userId: string): Promise<void> {
    const activeTask = taskQueue.getActiveTask();

    if (!activeTask || activeTask.userId !== userId) {
        await sendTextMessage(userId, '⚠️ No active task to cancel.');
        return;
    }

    cancelTask(userId, activeTask.id);
    taskQueue.cancelActive();

    const displayName = AGENT_DISPLAY_NAMES[activeTask.agent];
    await sendTextMessage(userId, `🛑 Cancelled *${displayName}* task.`);
}

async function handlePairCommand(userId: string, args: string): Promise<void> {
    const code = args.trim();

    if (!code) {
        const newCode = createPairingCode(userId);
        await sendTextMessage(
            userId,
            `🔗 *Pairing Code:* \`${newCode}\`\n\nRun this on your dev machine:\n\`\`\`\ncd /root/connect-with-all-code\nnode connector/dist/index.js --pair ${newCode}\n\`\`\`\n\nCode expires in 5 minutes.`
        );
        return;
    }

    await sendTextMessage(userId, `🔗 Waiting for device with code \`${code}\`...`);
}

// ─── Result / Status Callbacks (called by ws-server) ─────────────────────────

export async function handleStatusResponse(userId: string, agents: AgentStatusMap): Promise<void> {
    const lines = Object.values(agents).map((a) => {
        const icon = a.available ? '✅' : '⚠️';
        const displayName = AGENT_DISPLAY_NAMES[a.agent];
        const version = a.version ? ` (v${a.version})` : '';
        const status = a.available ? 'online' : 'offline';
        return `${icon} *${displayName}*${version} — ${status}`;
    });

    await sendTextMessage(userId, `📊 *Agent Status*\n\n${lines.join('\n')}`);
}

export async function handleTaskResultMessage(
    userId: string,
    taskId: string,
    output: string,
    error?: string
): Promise<void> {
    const history = taskQueue.getHistory(userId, 20);
    const task = history.find((t) => t.id === taskId);
    const agentName = task ? AGENT_DISPLAY_NAMES[task.agent] : 'Agent';

    if (error) {
        await sendTextMessage(userId, `❌ *${agentName}* | Task failed:\n${error}`);
    } else {
        const { text, sessionId } = parseAgentOutput(output);
        // Persist session ID for next message (conversation continuity)
        if (sessionId) sessionManager.setOpencodeSession(userId, sessionId);
        await sendTextMessage(userId, `✅ *${agentName}* | Done:\n\n${text}`);
    }
}

/**
 * Parse agent output to extract human-readable text.
 *
 * Opencode outputs NDJSON — each line is an event.
 * event.type values observed: 'text', 'step_finish', 'stepstart', 'tool', etc.
 * We extract text + accumulate token stats from step_finish events.
 */
function parseAgentOutput(output: string): { text: string; sessionId: string | null } {
    if (!output || !output.trim()) return { text: '(no output)', sessionId: null };


    const lines = output.trim().split('\n');
    const textParts: string[] = [];
    let isNdjson = false;

    let totalTokens = 0;
    let inputTokens = 0;
    let outputTokens = 0;
    let cacheRead = 0;
    let totalCost = 0;
    let sessionId = '';

    for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;

        try {
            const event = JSON.parse(trimmed);
            isNdjson = true;

            // Session ID
            if (!sessionId && event.sessionID) sessionId = event.sessionID;

            // Text content
            if (event.type === 'text' && event.part?.type === 'text' && event.part?.text) {
                textParts.push(event.part.text);
            }

            // Assistant content blocks
            if (event.type === 'assistant' && Array.isArray(event.content)) {
                for (const block of event.content) {
                    if (block.type === 'text' && block.text) textParts.push(block.text);
                }
            }

            // Token stats — opencode uses 'step_finish' (underscore)
            // Accept both variants for safety
            const isFinish = event.type === 'step_finish' || event.type === 'stepfinish';
            if (isFinish && event.part?.tokens) {
                const t = event.part.tokens;
                totalTokens += t.total ?? 0;
                inputTokens += t.input ?? 0;
                outputTokens += t.output ?? 0;
                cacheRead += t.cache?.read ?? 0;
                totalCost += event.part.cost ?? 0;
            }
        } catch {
            if (!isNdjson) textParts.push(trimmed);
        }
    }

    if (textParts.length === 0) {
        const raw = output.length > 1000 ? output.substring(0, 1000) + '\n…(truncated)' : output;
        return { text: raw, sessionId };
    }

    let result = textParts.join('\n').trim();

    if (isNdjson && totalTokens > 0) {
        const costStr = ` · $${totalCost.toFixed(4)}`;
        const cacheStr = cacheRead > 0 ? ` · 📦 cache: ${cacheRead.toLocaleString()}` : '';
        const sessionStr = sessionId ? `\n🆔 \`${sessionId}\`` : '';
        result += `\n\n─────────────────────\n📊 *Tokens:* ${totalTokens.toLocaleString()} (in: ${inputTokens.toLocaleString()} · out: ${outputTokens.toLocaleString()}${cacheStr})${costStr}${sessionStr}`;
    }

    return { text: result, sessionId };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function getTimeAgo(timestamp: number): string {
    const diff = Date.now() - timestamp;
    const seconds = Math.floor(diff / 1000);
    if (seconds < 60) return 'just now';
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes}m ago`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}h ago`;
    const days = Math.floor(hours / 24);
    return `${days}d ago`;
}
