import { WebSocketServer, WebSocket } from 'ws';
import type { Server, IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { PrivateRecordSubscriptions, PRIVATE_RECORD_TOPIC } from './PrivateRecordSubscriptions.js';
import { extractBearerToken, type TokenVerdict } from './wsHelpers.js';

interface RecordSource {
  ready: boolean;
  phase: 'connecting' | 'unavailable';
  start(): void;
  probe(): void;
  stop(): Promise<void>;
}
interface Peer {
  userId: string;
  lastSeen: number;
  windowStart: number;
  frames: number;
  records: PrivateRecordSubscriptions;
}
/** Standalone read-only transport. Its host/process must be independent of the engine. */
export class PrivateRecordGateway {
  private readonly wss = new WebSocketServer({ noServer: true, maxPayload: 8192 });
  private readonly peers = new Map<WebSocket, Peer>();
  private readonly source: RecordSource;
  private closed = false;
  private draining = false;
  private onDrained: (() => void) | null = null;
  private pendingAuth = 0;
  private pendingAcl = 0;
  private heartbeat: ReturnType<typeof setInterval> | null = null;
  private server: Server | null = null;
  constructor(
    private readonly dependencies: {
      origins: ReadonlySet<string>;
      authenticate: (token: string) => Promise<TokenVerdict>;
      /** Verifies live session AND the original topic ACL with this socket's JWT. */
      authorize: (token: string, userId: string, topic: string) => Promise<boolean>;
      source: (
        changed: (topic: string) => void,
        readiness: (ready: boolean, phase: 'connecting' | 'unavailable') => void
      ) => RecordSource;
    }
  ) {
    this.source = dependencies.source(
      (topic) => {
        for (const peer of this.peers.values()) peer.records.notify(topic);
      },
      (ready, phase) => {
        for (const peer of this.peers.values()) peer.records.readiness(ready, phase);
      }
    );
  }
  attach(server: Server): void {
    if (this.server || this.closed) throw new Error('gateway already attached or closed');
    this.server = server;
    server.on('upgrade', this.upgrade);
    this.source.start();
    // Link/source liveness only. No row polling, replay worker or financial writes.
    this.heartbeat = setInterval(() => {
      this.source.probe();
      for (const [ws, peer] of this.peers) {
        if (Date.now() - peer.lastSeen > 60_000) ws.terminate();
        else if (ws.readyState === WebSocket.OPEN) {
          ws.ping();
          ws.send(JSON.stringify({ type: 'CHANNEL_PING' }));
        }
      }
    }, 25_000);
    this.heartbeat.unref();
  }
  private upgrade = (req: IncomingMessage, socket: Duplex, head: Buffer): void => {
    const refuse = (status: number) => {
      if (!socket.destroyed)
        socket.end(`HTTP/1.1 ${status} Rejected\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
    };
    let path: string;
    try {
      path = new URL(req.url ?? '', 'http://gateway.invalid').pathname;
    } catch {
      refuse(400);
      return;
    }
    if (path !== '/ws/channel') {
      refuse(404);
      return;
    }
    if (this.closed || this.draining) {
      refuse(503);
      return;
    }
    if (!req.headers.origin || !this.dependencies.origins.has(req.headers.origin)) {
      refuse(403);
      return;
    }
    const token = extractBearerToken(req.headers['sec-websocket-protocol']);
    if (!token) {
      refuse(400);
      return;
    }
    if (this.pendingAuth >= 32 || this.peers.size >= 256) {
      refuse(503);
      return;
    }
    this.pendingAuth++;
    // An abandoned provider request remains charged until it actually settles.
    const deadline = setTimeout(() => socket.destroy(), 8_000);
    deadline.unref();
    void Promise.resolve()
      .then(() => this.dependencies.authenticate(token))
      .then((verdict) => {
        if (this.closed || socket.destroyed) return;
        if (this.draining) {
          refuse(503);
          return;
        }
        if (!verdict.userId && verdict.denied === 'unavailable') {
          refuse(503);
          return;
        }
        if (
          this.peers.size >= 256 ||
          (verdict.userId &&
            [...this.peers.values()].filter((p) => p.userId === verdict.userId).length >= 6)
        ) {
          refuse(503);
          return;
        }
        this.wss.handleUpgrade(req, socket, head, (ws) => {
          ws.on('error', () => ws.terminate());
          if (!verdict.userId) {
            ws.close(4401, 'auth:invalid');
            return;
          }
          this.accept(ws, token, verdict.userId);
        });
      })
      .catch(() => refuse(503))
      .finally(() => {
        clearTimeout(deadline);
        this.pendingAuth--;
      });
  };
  private accept(ws: WebSocket, token: string, userId: string): void {
    const peer: Peer = {
      userId,
      lastSeen: Date.now(),
      windowStart: Date.now(),
      frames: 0,
      records: new PrivateRecordSubscriptions({
        current: () =>
          !this.closed && this.peers.get(ws) === peer && ws.readyState === WebSocket.OPEN,
        authorize: async (topic) => {
          if (this.pendingAcl >= 64) throw new Error('record authorization capacity');
          this.pendingAcl++;
          try {
            const allowed = await this.dependencies.authorize(token, userId, topic);
            if (!allowed) ws.close(4403, 'private record access refused');
            return allowed;
          } finally {
            this.pendingAcl--;
          }
        },
        send: (data, complete) => ws.send(data, complete),
        buffered: () => ws.bufferedAmount,
        retire: () => ws.close(1013, 'private record backpressure'),
        error: () => ws.close(1013, 'private record authorization unavailable'),
      }),
    };
    this.peers.set(ws, peer);
    ws.on('pong', () => {
      peer.lastSeen = Date.now();
    });
    ws.on('close', () => {
      peer.records.clear();
      this.peers.delete(ws);
      this.finishDrain();
    });
    ws.on('message', (raw, binary) => {
      if (this.closed || this.peers.get(ws) !== peer) return;
      if (binary) {
        ws.close(4400, 'text frames required');
        return;
      }
      const now = Date.now();
      if (now - peer.windowStart >= 1000) {
        peer.windowStart = now;
        peer.frames = 0;
      }
      if (++peer.frames > 30) {
        ws.close(4429, 'record frame limit');
        return;
      }
      let message: { type?: string; topic?: string };
      try {
        message = JSON.parse(String(raw));
        if (!message || typeof message !== 'object') throw new Error();
      } catch {
        ws.close(4400, 'invalid record frame');
        return;
      }
      peer.lastSeen = now;
      if (message.type === 'CHANNEL_PONG' || message.type === 'PONG') return;
      if (message.type === 'CHANNEL_PING') {
        ws.send(JSON.stringify({ type: 'CHANNEL_PONG' }));
        return;
      }
      if (typeof message.topic !== 'string' || !PRIVATE_RECORD_TOPIC.test(message.topic)) {
        ws.close(4400, 'invalid record topic');
        return;
      }
      if (message.type === 'LEAVE_PRIVATE_RECORD') {
        peer.records.leave(message.topic);
        return;
      }
      if (message.type !== 'JOIN_PRIVATE_RECORD') {
        ws.close(4400, 'record commands only');
        return;
      }
      this.source.start();
      void peer.records
        .join(
          message.topic,
          () => this.source.ready,
          () => this.source.phase
        )
        .catch(() => ws.close(1013, 'private record authorization unavailable'));
    });
  }
  /** Existing peers finish naturally; their final close owns process retirement. */
  drain(onDrained: () => void): void {
    this.draining = true;
    this.onDrained = onDrained;
    this.finishDrain();
  }
  private finishDrain(): void {
    if (!this.draining || this.peers.size !== 0) return;
    const done = this.onDrained;
    this.onDrained = null;
    done?.();
  }
  sourceState(): { sourceReady: boolean; sourcePhase: 'connecting' | 'unavailable' } {
    return { sourceReady: !this.closed && this.source.ready, sourcePhase: this.source.phase };
  }
  async close(): Promise<void> {
    this.closed = true;
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = null;
    this.server?.off('upgrade', this.upgrade);
    for (const [ws, peer] of this.peers) {
      peer.records.clear();
      ws.terminate();
    }
    this.peers.clear();
    await this.source.stop();
    await new Promise<void>((resolve) => this.wss.close(() => resolve()));
  }
}
