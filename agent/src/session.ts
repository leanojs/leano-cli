import crypto from "crypto";

export interface SessionRecord {
  id: string;
  createdAt: number;
  expiresAt: number;
  lastSeenAt: number;
}

export class SessionStore {
  private readonly ttlMs: number;
  private readonly idleTimeoutMs: number;
  private readonly sessions = new Map<string, SessionRecord>();

  constructor(ttlMs: number, idleTimeoutMs: number) {
    this.ttlMs = ttlMs;
    this.idleTimeoutMs = idleTimeoutMs;
  }

  open(now = Date.now()): SessionRecord {
    const id = crypto.randomUUID();
    const session: SessionRecord = {
      id,
      createdAt: now,
      expiresAt: now + this.ttlMs,
      lastSeenAt: now,
    };
    this.sessions.set(id, session);
    return session;
  }

  close(id: string): boolean {
    return this.sessions.delete(id);
  }

  get(id: string, now = Date.now()): SessionRecord | null {
    const session = this.sessions.get(id);
    if (!session) return null;

    if (session.expiresAt <= now) {
      this.sessions.delete(id);
      return null;
    }

    if (session.lastSeenAt + this.idleTimeoutMs <= now) {
      this.sessions.delete(id);
      return null;
    }

    return session;
  }

  touch(id: string, now = Date.now()): SessionRecord | null {
    const session = this.get(id, now);
    if (!session) return null;
    session.lastSeenAt = now;
    this.sessions.set(id, session);
    return session;
  }

  cleanupExpired(now = Date.now()): void {
    for (const [id, session] of this.sessions) {
      if (
        session.expiresAt <= now ||
        session.lastSeenAt + this.idleTimeoutMs <= now
      ) {
        this.sessions.delete(id);
      }
    }
  }
}
