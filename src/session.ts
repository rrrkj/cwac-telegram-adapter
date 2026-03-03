import { UserSession, AgentType } from './types';
import pino from 'pino';
import path from 'path';
import os from 'os';
import fs from 'fs';

const logger = pino({ name: 'session' });

const SESSIONS_FILE = path.join(__dirname, '..', 'auth_store', 'sessions.json');

/**
 * In-memory session store keyed by Telegram chat ID.
 * For production, replace with Redis-backed implementation.
 */
export interface SessionRecord {
    sessionId: string;
    startedAt: number;
    preview: string; // first ~40 chars of the first prompt
}

class SessionManager {
    private sessions = new Map<string, UserSession>();
    private opencodeSessionIds = new Map<string, string>();
    // History of last 10 opencode sessions per user
    private sessionHistories = new Map<string, SessionRecord[]>();

    constructor() {
        this.loadFromDisk();
    }

    private loadFromDisk() {
        try {
            if (fs.existsSync(SESSIONS_FILE)) {
                const data = JSON.parse(fs.readFileSync(SESSIONS_FILE, 'utf-8'));
                if (data.opencodeSessionIds) {
                    this.opencodeSessionIds = new Map(Object.entries(data.opencodeSessionIds));
                }
                if (data.sessionHistories) {
                    this.sessionHistories = new Map(Object.entries(data.sessionHistories));
                }
                logger.info('📂 Loaded session history from disk');
            }
        } catch (err: any) {
            logger.error({ err: err.message }, 'Failed to load session history from disk');
        }
    }

    private saveToDisk() {
        try {
            const dir = path.dirname(SESSIONS_FILE);
            if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

            const data = {
                opencodeSessionIds: Object.fromEntries(this.opencodeSessionIds),
                sessionHistories: Object.fromEntries(this.sessionHistories),
            };
            fs.writeFileSync(SESSIONS_FILE, JSON.stringify(data, null, 2), 'utf-8');
        } catch (err: any) {
            logger.error({ err: err.message }, 'Failed to save session history to disk');
        }
    }

    getSession(userId: string): UserSession {
        let session = this.sessions.get(userId);
        if (!session) {
            session = {
                userId,
                defaultAgent: AgentType.OPENCODE,
                defaultWorkspace: os.homedir(),
                pairedDeviceId: null,
                createdAt: Date.now(),
                updatedAt: Date.now(),
            };
            this.sessions.set(userId, session);
            logger.info({ userId }, 'Created new session');
        }
        return session;
    }

    updateSession(userId: string, updates: Partial<UserSession>): UserSession {
        const session = this.getSession(userId);
        Object.assign(session, updates, { updatedAt: Date.now() });
        this.sessions.set(userId, session);
        return session;
    }

    setDefaultAgent(userId: string, agent: AgentType, workspace?: string): UserSession {
        const updates: Partial<UserSession> = { defaultAgent: agent };
        if (workspace) updates.defaultWorkspace = resolveWorkspace(workspace);
        return this.updateSession(userId, updates);
    }

    setPairedDevice(userId: string, deviceId: string): UserSession {
        return this.updateSession(userId, { pairedDeviceId: deviceId });
    }

    hasPairedDevice(userId: string): boolean {
        const session = this.getSession(userId);
        return session.pairedDeviceId !== null;
    }

    getAllSessions(): UserSession[] {
        return Array.from(this.sessions.values());
    }

    setOpencodeSession(userId: string, sessionId: string): void {
        this.opencodeSessionIds.set(userId, sessionId);
        this.saveToDisk();
    }

    getOpencodeSessionId(userId: string): string | null {
        return this.opencodeSessionIds.get(userId) ?? null;
    }

    clearOpencodeSession(userId: string): void {
        this.opencodeSessionIds.delete(userId);
        this.saveToDisk();
    }

    /** Record a session into the per-user history (max 10 entries, deduped by ID). */
    addToSessionHistory(userId: string, sessionId: string, preview: string): void {
        const history = this.sessionHistories.get(userId) ?? [];
        // If this session ID is already the most recent entry, just update preview
        if (history.length > 0 && history[0].sessionId === sessionId) return;
        // Remove duplicate if exists elsewhere
        const deduped = history.filter(s => s.sessionId !== sessionId);
        // Prepend and cap at 10
        const updated: SessionRecord[] = [
            { sessionId, startedAt: Date.now(), preview: preview.slice(0, 45) },
            ...deduped,
        ].slice(0, 10);
        this.sessionHistories.set(userId, updated);
        this.saveToDisk();
    }

    getSessionHistory(userId: string): SessionRecord[] {
        return this.sessionHistories.get(userId) ?? [];
    }

    /** Switch to an existing session from history by index (1-based). */
    switchToSession(userId: string, index: number): SessionRecord | null {
        const history = this.getSessionHistory(userId);
        const record = history[index - 1];
        if (!record) return null;
        this.opencodeSessionIds.set(userId, record.sessionId);
        return record;
    }
}

export const sessionManager = new SessionManager();

function resolveWorkspace(workspace: string): string {
    if (path.isAbsolute(workspace)) return workspace;
    if (workspace.startsWith('~/')) {
        return path.join(os.homedir(), workspace.slice(2));
    }
    return path.join(os.homedir(), workspace);
}
