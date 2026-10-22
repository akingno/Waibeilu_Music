import { randomUUID } from 'node:crypto';
import type { ListenerLease, Session, Presence } from '../shared/models.js';
import { AppError } from '../shared/protocol.js';
export class SeatRegistry {
  private leases = new Map<string, ListenerLease>();
  private names = new Map<string, string>();
  constructor(
    private max = 5,
    private graceMs = 60000,
  ) {}
  join(
    session: Session,
    connectionId: string,
    takeover: boolean,
  ): { lease: ListenerLease; replaced?: string } {
    this.expire();
    const current = this.leases.get(session.id);
    if (current && current.connectionId !== connectionId && !takeover)
      throw new AppError('TAKEOVER_REQUIRED', '此浏览器已在另一个标签页收听，是否接管？', 409);
    if (!current && this.leases.size >= this.max)
      throw new AppError('ROOM_FULL', '房间已满（5/5），请稍后重试', 409);
    const lease = {
      id: current?.id || randomUUID(),
      sessionId: session.id,
      connectionId,
      expiresAtMs: Date.now() + this.graceMs,
    };
    this.leases.set(session.id, lease);
    this.names.set(session.id, session.nickname);
    return {
      lease,
      replaced: current?.connectionId !== connectionId ? current?.connectionId : undefined,
    };
  }
  requireLease(sessionId: string, connectionId?: string): ListenerLease {
    const l = this.leases.get(sessionId);
    if (!l || l.expiresAtMs <= Date.now() || (connectionId && l.connectionId !== connectionId))
      throw new AppError('LEASE_EXPIRED', '请先加入收听', 403);
    return l;
  }
  touch(sessionId: string, connectionId?: string): void {
    const l = this.requireLease(sessionId, connectionId);
    l.expiresAtMs = Date.now() + this.graceMs;
  }
  release(sessionId: string): void {
    this.leases.delete(sessionId);
    this.names.delete(sessionId);
  }
  releaseConnection(sessionId: string, connectionId: string): boolean {
    if (this.leases.get(sessionId)?.connectionId !== connectionId) return false;
    this.release(sessionId);
    return true;
  }
  rename(sessionId: string, nickname: string): void {
    if (this.leases.has(sessionId)) this.names.set(sessionId, nickname);
  }
  expire(): void {
    for (const [id, lease] of this.leases) if (lease.expiresAtMs <= Date.now()) this.release(id);
  }
  presence(): Presence {
    return { activeCount: this.leases.size, maxListeners: 5, nicknames: [...this.names.values()] };
  }
}
