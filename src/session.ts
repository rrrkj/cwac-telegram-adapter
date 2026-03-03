import { UserSession, AgentType } from './types';
import pino from 'pino';
import path from 'path';
import os from 'os';

const logger = pino({ name: 'session' });

/**
 * In-memory session store keyed by Telegram chat ID.
 * For production, replace with Redis-backed implementation.
 */
class SessionManager {
    private sessions = new Map<string, UserSession>();
    // Stores the last opencode session ID per user for conversation continuity
    private opencodeSessionIds = new Map<string, string>();

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
    }

    getOpencodeSessionId(userId: string): string | null {
        return this.opencodeSessionIds.get(userId) ?? null;
    }

    clearOpencodeSession(userId: string): void {
        this.opencodeSessionIds.delete(userId);
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
