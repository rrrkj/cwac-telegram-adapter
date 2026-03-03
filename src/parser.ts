import { ParsedCommand, AgentType, AGENT_ALIASES, SYSTEM_COMMANDS, SystemCommand } from './types';

/**
 * Parse a raw Telegram message into a structured command.
 * Adapted from connect-with-all-code's parser.ts — identical logic, works
 * for any text-based messenger.
 */
export function parseCommand(message: string): ParsedCommand {
    const trimmed = message.trim();

    if (!trimmed) {
        return { type: 'error', message: 'Empty message received.' };
    }

    // Check for system commands first
    const firstWord = trimmed.split(/\s+/)[0]?.toLowerCase() ?? '';
    const rest = trimmed.slice(firstWord.length).trim();

    if (SYSTEM_COMMANDS.includes(firstWord as SystemCommand)) {
        return {
            type: 'system',
            command: firstWord as SystemCommand,
            args: rest,
        };
    }

    // Check for agent prefix
    if (firstWord.startsWith('/')) {
        const agent = AGENT_ALIASES[firstWord];
        if (agent) {
            if (!rest) {
                return {
                    type: 'error',
                    message: `Please provide a prompt after ${firstWord}. Example: ${firstWord} review the auth module`,
                };
            }
            return {
                type: 'agent',
                agent,
                prompt: rest,
            };
        }
        // Unknown command
        return {
            type: 'error',
            message: `Unknown command: ${firstWord}. Use /help to see available commands.`,
        };
    }

    // No prefix — route to default agent
    return {
        type: 'default_agent',
        prompt: trimmed,
    };
}

/**
 * Generate the help text shown when the user sends /help or /start.
 */
export function getHelpText(): string {
    return [
        '🤖 *ConnectWithAllCode — Telegram Adapter*',
        '',
        '*Agent Commands:*',
        '`/claude` or `/cc` — Send to Claude Code',
        '`/gemini` or `/gm` — Send to Gemini CLI',
        '`/codex` or `/cx` — Send to Codex',
        '`/opencode` or `/oc` — Send to opencode',
        '',
        '*System Commands:*',
        '`/status` — Show agent connectivity status',
        '`/default <agent> [workspace]` — Set default agent & workspace',
        '`/history` — Show last 10 tasks',
        '`/cancel` — Cancel the running task',
        '`/pair` — Get a pairing code for your dev machine',
        '`/help` — Show this message',
        '',
        '*Example:*',
        '`/claude review the auth middleware in src/auth.ts`',
        '',
        'Messages without a prefix go to your default agent.',
        '',
        '*First time?* Send `/pair` to get a pairing code,',
        'then run the connector on your dev machine.',
    ].join('\n');
}
