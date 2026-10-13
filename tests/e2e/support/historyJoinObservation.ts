import type { Page, WebSocket as PlaywrightSocket } from '@playwright/test';

export const HISTORY_ADMISSION_MS = 20_000;
export const HISTORY_JOIN_ACK_MS = 15_000;
type Phase =
  | 'waiting_admission'
  | 'waiting_join_ack'
  | 'joined'
  | 'admission_timeout'
  | 'join_timeout'
  | 'disposed';
type Join = { sentAt: number; ref: string; socket: unknown; requestCount: number; ackAt?: number };

/** Retains only correlation metadata. Tokens and raw frames never leave this call. */
export class HistoryJoinObservation {
  private startedAt: number | null = null;
  private joins = new Map<string, Join>();
  private disposed = false;
  private listeners = new Set<() => void>();
  begin(now: number): void {
    if (this.startedAt !== null || this.disposed)
      throw new Error('History join observation already started or disposed.');
    this.startedAt = now;
  }
  record(
    direction: 'sent' | 'received',
    raw: string | Buffer,
    now: number,
    socket: unknown = undefined
  ): void {
    if (this.disposed || this.startedAt === null) return;
    try {
      const frame = JSON.parse(String(raw));
      const topic = Array.isArray(frame) ? frame[2] : frame.topic;
      const event = Array.isArray(frame) ? frame[3] : frame.event;
      const ref = Array.isArray(frame) ? frame[1] : frame.ref;
      const payload = Array.isArray(frame) ? frame[4] : frame.payload;
      if (
        typeof topic !== 'string' ||
        !topic.startsWith('realtime:player-history:') ||
        typeof ref !== 'string' ||
        !ref ||
        ref.length > 128
      )
        return;
      if (direction === 'sent' && event === 'phx_join') {
        let join = this.joins.get(topic);
        if (!join && this.joins.size < 16) {
          join = { sentAt: now, ref, socket, requestCount: 0 };
          this.joins.set(topic, join);
        }
        if (join && join.requestCount < 32) {
          join.ref = ref;
          join.socket = socket;
          join.requestCount += 1;
          join.ackAt = undefined;
        }
      } else if (direction === 'received' && event === 'phx_reply' && payload?.status === 'ok') {
        const join = this.joins.get(topic);
        if (join?.ref === ref && join.socket === socket && join.ackAt === undefined)
          join.ackAt = now;
      }
      for (const listener of this.listeners) listener();
    } catch {
      /* Non-JSON frames cannot prove a private join. */
    }
  }
  result(
    topic: string,
    now: number
  ): {
    phase: Phase;
    elapsedMs: number;
    admissionMs: number | null;
    joinMs: number | null;
    requestCount: number;
  } {
    const start = this.startedAt;
    const join = this.joins.get(topic);
    const admissionMs = start !== null && join ? join.sentAt - start : null;
    const joinMs = join?.ackAt !== undefined ? join.ackAt - join.sentAt : null;
    let phase: Phase = 'waiting_admission';
    if (this.disposed) phase = 'disposed';
    else if (start === null) throw new Error('History join observation was not started.');
    else if (admissionMs !== null && admissionMs > HISTORY_ADMISSION_MS)
      phase = 'admission_timeout';
    else if (joinMs !== null) phase = joinMs <= HISTORY_JOIN_ACK_MS ? 'joined' : 'join_timeout';
    else if (join)
      phase = now - join.sentAt >= HISTORY_JOIN_ACK_MS ? 'join_timeout' : 'waiting_join_ack';
    else if (now - start >= HISTORY_ADMISSION_MS) phase = 'admission_timeout';
    return {
      phase,
      elapsedMs: start === null ? 0 : now - start,
      admissionMs,
      joinMs,
      requestCount: join?.requestCount ?? 0,
    };
  }
  wait(topic: string, now: () => number = () => performance.now()): Promise<void> {
    return new Promise((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const check = () => {
        clearTimeout(timer);
        const result = this.result(topic, now());
        if (result.phase === 'joined') {
          this.listeners.delete(check);
          resolve();
          return;
        }
        if (!result.phase.startsWith('waiting_')) {
          this.listeners.delete(check);
          reject(new Error(`Private history join failed: ${result.phase}.`));
          return;
        }
        const start = this.startedAt!;
        const join = this.joins.get(topic);
        const deadline = join ? join.sentAt + HISTORY_JOIN_ACK_MS : start + HISTORY_ADMISSION_MS;
        timer = setTimeout(check, Math.max(1, deadline - now()));
      };
      this.listeners.add(check);
      check();
    });
  }
  async qualify(
    readAuthorizedTopic: () => Promise<string>,
    now: () => number = () => performance.now()
  ): Promise<void> {
    this.begin(now());
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(
        () => reject(new Error('Private history join failed: total_timeout.')),
        HISTORY_ADMISSION_MS + HISTORY_JOIN_ACK_MS
      );
    });
    try {
      await Promise.race([readAuthorizedTopic().then((topic) => this.wait(topic, now)), deadline]);
    } finally {
      clearTimeout(timer);
    }
  }
  dispose(): void {
    this.disposed = true;
    for (const listener of this.listeners) listener();
    this.listeners.clear();
    this.joins.clear();
  }
}

export function observeHistoryJoin(page: Page) {
  const observation = new HistoryJoinObservation();
  const sockets = new Map<
    PlaywrightSocket,
    {
      sent: (frame: { payload: string | Buffer }) => void;
      received: (frame: { payload: string | Buffer }) => void;
    }
  >();
  const onSocket = (socket: PlaywrightSocket) => {
    const sent = (frame: { payload: string | Buffer }) =>
      observation.record('sent', frame.payload, performance.now(), socket);
    const received = (frame: { payload: string | Buffer }) =>
      observation.record('received', frame.payload, performance.now(), socket);
    sockets.set(socket, { sent, received });
    socket.on('framesent', sent);
    socket.on('framereceived', received);
  };
  const dispose = () => {
    page.off('websocket', onSocket);
    page.off('close', dispose);
    for (const [socket, handlers] of sockets) {
      socket.off('framesent', handlers.sent);
      socket.off('framereceived', handlers.received);
    }
    sockets.clear();
    observation.dispose();
  };
  page.on('websocket', onSocket);
  page.once('close', dispose);
  return { observation, dispose };
}
