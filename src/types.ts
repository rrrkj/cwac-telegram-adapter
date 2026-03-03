// ─── Shared Types ─────────────────────────────────────────────────────────────
//
// This file re-implements the minimal types from @cwac/shared so the adapter
// is self-contained and does NOT require the original monorepo to be a
// Node.js dependency. It mirrors the exact shapes so the WebSocket protocol
// with the original connector remains 100% compatible.
// ──────────────────────────────────────────────────────────────────────────────

// ─── Agent Types ─────────────────────────────────────────────────────────────

export enum AgentType {
    CLAUDE = 'claude',
    GEMINI = 'gemini',
    CODEX = 'codex',
    OPENCODE = 'opencode',
}

export const AGENT_ALIASES: Record<string, AgentType> = {
    '/claude': AgentType.CLAUDE,
    '/cc': AgentType.CLAUDE,
    '/gemini': AgentType.GEMINI,
    '/gm': AgentType.GEMINI,
    '/codex': AgentType.CODEX,
    '/cx': AgentType.CODEX,
    '/opencode': AgentType.OPENCODE,
    '/oc': AgentType.OPENCODE,
};

export const AGENT_DISPLAY_NAMES: Record<AgentType, string> = {
    [AgentType.CLAUDE]: 'Claude Code',
    [AgentType.GEMINI]: 'Gemini CLI',
    [AgentType.CODEX]: 'Codex',
    [AgentType.OPENCODE]: 'opencode',
};

export const SYSTEM_COMMANDS = [
    '/status',
    '/help',
    '/default',
    '/history',
    '/cancel',
    '/pair',
    '/start',
    '/new',
] as const;

export type SystemCommand = (typeof SYSTEM_COMMANDS)[number];

// ─── Task Types ───────────────────────────────────────────────────────────────

export type TaskStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';

export interface Task {
    id: string;
    agent: AgentType;
    prompt: string;
    workspace: string;
    userId: string;   // Telegram chat ID (as string)
    status: TaskStatus;
    createdAt: number;
}

export interface TaskResult {
    taskId: string;
    status: 'completed' | 'failed';
    output: string;
    error?: string;
    durationMs: number;
}

// ─── Session Types ────────────────────────────────────────────────────────────

export interface UserSession {
    userId: string;
    defaultAgent: AgentType;
    defaultWorkspace: string;
    pairedDeviceId: string | null;
    createdAt: number;
    updatedAt: number;
}

// ─── Parsed Command ───────────────────────────────────────────────────────────

export type ParsedCommand =
    | { type: 'agent'; agent: AgentType; prompt: string }
    | { type: 'system'; command: SystemCommand; args: string }
    | { type: 'default_agent'; prompt: string }
    | { type: 'error'; message: string };

// ─── Agent Health ─────────────────────────────────────────────────────────────

export interface AgentHealth {
    agent: AgentType;
    available: boolean;
    version?: string;
    lastChecked: number;
}

export type AgentStatusMap = Record<AgentType, AgentHealth>;

// ─── WebSocket Protocol ───────────────────────────────────────────────────────

export enum WsMessageType {
    TASK_DISPATCH = 'task:dispatch',
    STATUS_REQUEST = 'status:request',
    CANCEL_TASK = 'task:cancel',
    TASK_RESULT = 'task:result',
    TASK_PROGRESS = 'task:progress',
    STATUS_RESPONSE = 'status:response',
    PAIR_REQUEST = 'pair:request',
    PAIR_ACCEPTED = 'pair:accepted',
    PAIR_REJECTED = 'pair:rejected',
    HEARTBEAT = 'heartbeat',
    HEARTBEAT_ACK = 'heartbeat:ack',
    ERROR = 'error',
}

export interface WsTaskDispatch {
    type: WsMessageType.TASK_DISPATCH;
    task: Task;
}

export interface WsTaskResult {
    type: WsMessageType.TASK_RESULT;
    result: TaskResult;
}

export interface WsTaskProgress {
    type: WsMessageType.TASK_PROGRESS;
    taskId: string;
    partialOutput: string;
}

export interface WsStatusRequest {
    type: WsMessageType.STATUS_REQUEST;
    requestId: string;
}

export interface WsStatusResponse {
    type: WsMessageType.STATUS_RESPONSE;
    requestId: string;
    agents: AgentStatusMap;
}

export interface WsCancelTask {
    type: WsMessageType.CANCEL_TASK;
    taskId: string;
}

export interface WsPairRequest {
    type: WsMessageType.PAIR_REQUEST;
    pairingCode: string;
    deviceName: string;
    availableAgents: AgentType[];
}

export interface WsPairAccepted {
    type: WsMessageType.PAIR_ACCEPTED;
    deviceId: string;
}

export interface WsPairRejected {
    type: WsMessageType.PAIR_REJECTED;
    reason: string;
}

export interface WsHeartbeat {
    type: WsMessageType.HEARTBEAT;
    timestamp: number;
}

export interface WsHeartbeatAck {
    type: WsMessageType.HEARTBEAT_ACK;
    timestamp: number;
}

export interface WsError {
    type: WsMessageType.ERROR;
    message: string;
    code?: string;
}

export type WsMessage =
    | WsTaskDispatch
    | WsTaskResult
    | WsTaskProgress
    | WsStatusRequest
    | WsStatusResponse
    | WsCancelTask
    | WsPairRequest
    | WsPairAccepted
    | WsPairRejected
    | WsHeartbeat
    | WsHeartbeatAck
    | WsError;

export function serializeMessage(msg: WsMessage): string {
    return JSON.stringify(msg);
}

export function deserializeMessage(data: string): WsMessage {
    const parsed = JSON.parse(data);
    if (!parsed.type || !Object.values(WsMessageType).includes(parsed.type)) {
        throw new Error(`Invalid message type: ${parsed.type}`);
    }
    return parsed as WsMessage;
}
