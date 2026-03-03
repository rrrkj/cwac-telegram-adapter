import { WebSocketServer, WebSocket } from 'ws';
import { Server } from 'http';
import { v4 as uuidv4 } from 'uuid';
import pino from 'pino';
import {
    Task,
    TaskResult,
    AgentType,
    AgentStatusMap,
    WsMessageType,
    WsMessage,
    WsTaskDispatch,
    WsStatusRequest,
    WsCancelTask,
    serializeMessage,
    deserializeMessage,
} from './types';

const logger = pino({ name: 'ws-server' });

// ─── Pairing ──────────────────────────────────────────────────────────────────

interface PendingPairing {
    userId: string;
    createdAt: number;
    persistent?: boolean; // if true, never expires (used for auto-pair)
}

interface ConnectedDevice {
    id: string;
    ws: WebSocket;
    userId: string;
    deviceName: string;
    availableAgents: AgentType[];
    lastHeartbeat: number;
}

// ─── State ────────────────────────────────────────────────────────────────────

const pendingPairings = new Map<string, PendingPairing>(); // pairingCode → pending
const connectedDevices = new Map<string, ConnectedDevice>(); // deviceId → device
const userDevices = new Map<string, string>(); // userId → deviceId

type ResultHandler = (userId: string, result: TaskResult) => void;
type StatusHandler = (userId: string, agents: AgentStatusMap) => void;

let onResultHandler: ResultHandler | null = null;
let onStatusHandler: StatusHandler | null = null;

const pendingStatusRequests = new Map<string, string>(); // requestId → userId

// ─── Auto-Pair (persistent, survives restarts) ────────────────────────────────

/**
 * Register a fixed (persistent) pairing code that never expires.
 * Used by install.sh to wire the connector to the gateway permanently.
 * On each gateway restart the code is re-registered, so the connector
 * reconnects automatically without any manual pairing step.
 */
export function registerAutoPair(userId: string, code: string): void {
    pendingPairings.set(code, { userId, createdAt: Date.now(), persistent: true });
    logger.info({ userId, code }, '🔗 Auto-pair code registered (persistent)');
}

// ─── Public API ───────────────────────────────────────────────────────────────

export function initWsServer(server: Server): void {
    const wss = new WebSocketServer({ server, path: '/ws' });

    wss.on('connection', (ws: WebSocket) => {
        logger.info('New WebSocket connection from connector');

        ws.on('message', (data: Buffer) => {
            try {
                const msg = deserializeMessage(data.toString());
                handleMessage(ws, msg);
            } catch (err: any) {
                logger.error({ err: err.message }, 'Invalid WebSocket message');
                ws.send(serializeMessage({ type: WsMessageType.ERROR, message: 'Invalid message format' }));
            }
        });

        ws.on('close', () => {
            for (const [deviceId, device] of connectedDevices.entries()) {
                if (device.ws === ws) {
                    connectedDevices.delete(deviceId);
                    userDevices.delete(device.userId);
                    logger.info({ deviceId, userId: device.userId }, 'Connector device disconnected');

                    // Re-register auto-pair code so the connector can reconnect
                    const autoPairCode = process.env.CONNECTOR_SECRET;
                    const primaryUserId = process.env.TELEGRAM_USER_ID;
                    if (autoPairCode && primaryUserId) {
                        pendingPairings.set(autoPairCode, {
                            userId: primaryUserId,
                            createdAt: Date.now(),
                            persistent: true,
                        });
                        logger.info('🔄 Re-registered auto-pair code after disconnect (connector will reconnect)');
                    }
                    break;
                }
            }
        });

        ws.on('error', (err) => {
            logger.error({ err: err.message }, 'WebSocket error');
        });
    });

    // Heartbeat check every 30 seconds
    setInterval(() => {
        const now = Date.now();
        for (const [deviceId, device] of connectedDevices.entries()) {
            if (now - device.lastHeartbeat > 60_000) {
                logger.warn({ deviceId }, 'Device heartbeat timeout — disconnecting');
                device.ws.close();
                connectedDevices.delete(deviceId);
                userDevices.delete(device.userId);
            } else {
                device.ws.send(
                    serializeMessage({ type: WsMessageType.HEARTBEAT, timestamp: now })
                );
            }
        }
    }, 30_000);

    logger.info('WebSocket server initialized on /ws');
}

export function onResult(handler: ResultHandler): void {
    onResultHandler = handler;
}

export function onStatus(handler: StatusHandler): void {
    onStatusHandler = handler;
}

/**
 * Create a one-time pairing code for a user (from /pair Telegram command).
 * Expires after 5 minutes.
 */
export function createPairingCode(userId: string): string {
    // Clean up old codes for this user (but preserve persistent auto-pair code)
    for (const [code, pending] of pendingPairings.entries()) {
        if (pending.userId === userId && !pending.persistent) {
            pendingPairings.delete(code);
        }
    }

    const code = `${randomSegment()}-${randomSegment()}`;
    pendingPairings.set(code, { userId, createdAt: Date.now() });

    // Expire after 5 minutes
    setTimeout(() => pendingPairings.delete(code), 5 * 60 * 1000);

    return code;
}

export function dispatchTask(userId: string, task: Task): boolean {
    const deviceId = userDevices.get(userId);
    if (!deviceId) return false;

    const device = connectedDevices.get(deviceId);
    if (!device || device.ws.readyState !== WebSocket.OPEN) return false;

    const msg: WsTaskDispatch = {
        type: WsMessageType.TASK_DISPATCH,
        task,
    };

    device.ws.send(serializeMessage(msg));
    logger.info({ taskId: task.id, deviceId }, 'Task dispatched to connector device');
    return true;
}

export function requestStatus(userId: string): boolean {
    const deviceId = userDevices.get(userId);
    if (!deviceId) return false;

    const device = connectedDevices.get(deviceId);
    if (!device || device.ws.readyState !== WebSocket.OPEN) return false;

    const requestId = uuidv4();
    pendingStatusRequests.set(requestId, userId);

    const msg: WsStatusRequest = {
        type: WsMessageType.STATUS_REQUEST,
        requestId,
    };

    device.ws.send(serializeMessage(msg));
    return true;
}

export function cancelTask(userId: string, taskId: string): boolean {
    const deviceId = userDevices.get(userId);
    if (!deviceId) return false;

    const device = connectedDevices.get(deviceId);
    if (!device || device.ws.readyState !== WebSocket.OPEN) return false;

    const msg: WsCancelTask = {
        type: WsMessageType.CANCEL_TASK,
        taskId,
    };

    device.ws.send(serializeMessage(msg));
    return true;
}

export function isDeviceConnected(userId: string): boolean {
    const deviceId = userDevices.get(userId);
    if (!deviceId) return false;
    const device = connectedDevices.get(deviceId);
    return device !== undefined && device.ws.readyState === WebSocket.OPEN;
}

// ─── Internal Handlers ────────────────────────────────────────────────────────

function handleMessage(ws: WebSocket, msg: WsMessage): void {
    switch (msg.type) {
        case WsMessageType.PAIR_REQUEST:
            handlePairRequest(ws, msg);
            break;

        case WsMessageType.TASK_RESULT:
            handleTaskResult(msg);
            break;

        case WsMessageType.TASK_PROGRESS:
            logger.info({ taskId: msg.taskId, partial: msg.partialOutput.substring(0, 80) }, 'Task progress');
            break;

        case WsMessageType.STATUS_RESPONSE:
            handleStatusResponse(msg);
            break;

        case WsMessageType.HEARTBEAT_ACK:
            handleHeartbeatAck(ws, msg);
            break;

        default:
            logger.warn({ type: (msg as any).type }, 'Unhandled message type');
    }
}

function handlePairRequest(ws: WebSocket, msg: Extract<WsMessage, { type: WsMessageType.PAIR_REQUEST }>): void {
    const pending = pendingPairings.get(msg.pairingCode);

    if (!pending) {
        ws.send(
            serializeMessage({
                type: WsMessageType.PAIR_REJECTED,
                reason: 'Invalid or expired pairing code.',
            })
        );
        logger.warn({ pairingCode: msg.pairingCode }, 'Pairing rejected — code not found or expired');
        return;
    }

    const deviceId = uuidv4();
    const device: ConnectedDevice = {
        id: deviceId,
        ws,
        userId: pending.userId,
        deviceName: msg.deviceName,
        availableAgents: msg.availableAgents,
        lastHeartbeat: Date.now(),
    };

    connectedDevices.set(deviceId, device);
    userDevices.set(pending.userId, deviceId);

    // Only delete non-persistent codes — auto-pair code stays registered
    if (!pending.persistent) {
        pendingPairings.delete(msg.pairingCode);
    }

    ws.send(
        serializeMessage({
            type: WsMessageType.PAIR_ACCEPTED,
            deviceId,
        })
    );

    logger.info(
        { deviceId, userId: pending.userId, deviceName: msg.deviceName, persistent: pending.persistent },
        '✅ Connector device paired successfully'
    );
}

function handleTaskResult(msg: Extract<WsMessage, { type: WsMessageType.TASK_RESULT }>): void {
    for (const device of connectedDevices.values()) {
        if (onResultHandler) {
            onResultHandler(device.userId, msg.result);
        }
        break;
    }
}

function handleStatusResponse(msg: Extract<WsMessage, { type: WsMessageType.STATUS_RESPONSE }>): void {
    const userId = pendingStatusRequests.get(msg.requestId);
    if (userId && onStatusHandler) {
        onStatusHandler(userId, msg.agents);
        pendingStatusRequests.delete(msg.requestId);
    }
}

function handleHeartbeatAck(ws: WebSocket, _msg: Extract<WsMessage, { type: WsMessageType.HEARTBEAT_ACK }>): void {
    for (const device of connectedDevices.values()) {
        if (device.ws === ws) {
            device.lastHeartbeat = Date.now();
            break;
        }
    }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function randomSegment(): string {
    return Math.random().toString(36).substring(2, 6).toUpperCase();
}
