import type { IncomingMessage, Server } from 'node:http';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { WebSocketServer, WebSocket } from 'ws';
import type { Session } from '../shared/models.js';
import { AppError, parseCommand } from '../shared/protocol.js';
import { AuthService } from './auth.js';
import { MusicApplication } from './application.js';
import { SeatRegistry } from './seats.js';
type Client = {
  socket: WebSocket;
  session: Session;
  cookie: string;
  id: string;
  alive: boolean;
  count: number;
  window: number;
};
export class RoomGateway {
  private wss = new WebSocketServer({ noServer: true, maxPayload: 8192 });
  private clients = new Map<string, Client>();
  private app!: MusicApplication;
  private closing = false;
  constructor(
    server: Server,
    private auth: AuthService,
    private seats: SeatRegistry,
  ) {
    server.on('upgrade', (request, socket, head) => {
      try {
        if (request.url !== '/ws') throw new AppError('NOT_FOUND', 'Not found', 404);
        this.auth.validateOrigin(request.headers.origin);
        const session = this.auth.authenticate(request.headers.cookie);
        if (this.clients.size >= 30) throw new AppError('BUSY', '连接数量过多', 429);
        this.wss.handleUpgrade(request, socket, head, (ws) => this.connect(ws, session, request));
      } catch {
        socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
        socket.destroy();
      }
    });
  }
  bind(app: MusicApplication): void {
    this.app = app;
  }
  private connect(socket: WebSocket, session: Session, req: IncomingMessage): void {
    const c: Client = {
      socket,
      session,
      cookie: req.headers.cookie!,
      id: randomUUID(),
      alive: true,
      count: 0,
      window: Date.now(),
    };
    this.clients.set(c.id, c);
    socket.on('error', () => {});
    socket.on('pong', () => {
      c.alive = true;
      try {
        this.auth.authenticate(c.cookie);
        this.seats.touch(session.id, c.id);
      } catch (e) {
        if (e instanceof AppError && e.code === 'UNAUTHENTICATED') socket.close(4001);
      }
    });
    socket.on('close', () => {
      this.clients.delete(c.id);
      if (this.seats.releaseConnection(c.session.id, c.id) && !this.closing) {
        this.broadcast();
        void this.app.tick().catch(console.error);
      }
    });
    socket.on('message', (data) => {
      void this.receive(c, data.toString());
    });
    this.send(c, {
      type: 'hello',
      state: this.app.room.getState(),
      presence: this.seats.presence(),
    });
  }
  private send(c: Client, data: unknown): void {
    if (c.socket.readyState === WebSocket.OPEN) {
      if (c.socket.bufferedAmount > 1024 * 1024) {
        c.socket.terminate();
        return;
      }
      c.socket.send(JSON.stringify(data));
    }
  }
  private async receive(c: Client, raw: string): Promise<void> {
    let requestId: unknown;
    try {
      c.session = this.auth.authenticate(c.cookie);
      if (Date.now() - c.window > 1000) {
        c.count = 0;
        c.window = Date.now();
      }
      if (++c.count > 30) throw new AppError('RATE_LIMITED', '操作太频繁，请稍后再试', 429);
      const m = JSON.parse(raw);
      requestId = m.requestId || m.commandId;
      if (typeof requestId !== 'string' || requestId.length > 100)
        throw new AppError('INVALID_INPUT', '请求编号无效');
      switch (m.type) {
        case 'timeProbe':
          this.send(c, {
            type: 'timeReply',
            requestId,
            clientSentMs: m.clientSentMs,
            serverReceivedMs: performance.now(),
            serverSentMs: performance.now(),
          });
          break;
        case 'join': {
          let takeover = m.takeover === true;
          try {
            const current = this.seats.requireLease(c.session.id);
            const previous = this.clients.get(current.connectionId);
            // A reload reconnects the same session without competing with a live tab.
            if (!previous || previous.socket.readyState !== WebSocket.OPEN) takeover = true;
          } catch {
            /* No existing live lease. */
          }
          const { lease, replaced } = this.seats.join(c.session, c.id, takeover);
          if (replaced) {
            const old = this.clients.get(replaced);
            if (old) {
              this.send(old, { type: 'takenOver' });
              old.socket.close(4003, 'Taken over');
            }
          }
          this.send(c, { type: 'joined', requestId, lease, state: this.app.room.getState() });
          this.broadcast();
          break;
        }
        case 'leave':
          this.seats.requireLease(c.session.id, c.id);
          this.seats.release(c.session.id);
          await this.app.tick();
          break;
        case 'getState':
          this.send(c, { type: 'state', state: this.app.room.getState() });
          break;
        case 'control': {
          const command = parseCommand(m);
          await this.app.control(c.session, c.id, command);
          this.send(c, {
            type: 'ack',
            commandId: command.commandId,
            revision: this.app.room.getState().revision,
          });
          break;
        }
        default:
          throw new AppError('INVALID_INPUT', '消息类型无效');
      }
    } catch (e) {
      const error =
        e instanceof AppError ? e : new AppError('INTERNAL_ERROR', '操作失败，请重试', 500);
      if (!(e instanceof AppError)) console.error('WS error', e);
      this.send(c, {
        type: 'error',
        requestId,
        code: error.code,
        message: error.message,
        state: this.app.room.getState(),
      });
    }
  }
  broadcast(): void {
    if (!this.app) return;
    const message = {
      type: 'state',
      state: this.app.room.getState(),
      presence: this.seats.presence(),
    };
    for (const c of this.clients.values()) this.send(c, message);
  }
  notify(type: 'libraryChanged' | 'storageChanged', data?: unknown): void {
    for (const c of this.clients.values()) this.send(c, { type, data });
  }
  heartbeat(): void {
    for (const c of this.clients.values()) {
      if (c.socket.readyState !== WebSocket.OPEN) continue;
      if (!c.alive) {
        c.socket.terminate();
        continue;
      }
      c.alive = false;
      c.socket.ping();
    }
  }
  closeSession(id: string): void {
    for (const c of this.clients.values())
      if (c.session.id === id) c.socket.close(4001, 'Logged out');
  }
  close(): void {
    this.closing = true;
    for (const c of this.clients.values()) c.socket.terminate();
    this.wss.close();
  }
}
