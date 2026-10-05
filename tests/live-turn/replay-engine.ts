/**
 * THE ENGINE, REPLAYED TO ONE BROWSER.
 *
 * A recording is the exact wire the real ServerTableEngine, HandController
 * and TableStateHub sent one subscribed player during one hand (see
 * server/src/engine/aSeatThatClosesAStreetIsHandedTheNext.contract.test.ts,
 * which also writes it). This plays that wire back over the engine socket the
 * page opens, and stops at each of the player's own decisions until the page
 * sends the action the recording made there.
 *
 * What is real: every frame, its order, its sequence numbers and its spacing
 * inside a segment. What is not: the pauses. A person takes as long as they
 * take, so each segment is anchored at the moment the browser's action
 * arrives, and every engine clock value in it moves by that same amount. One
 * recorded instant always maps to one replayed instant, so a frame that
 * repeats an OLD clock value (the engine's first frames after an action do)
 * repeats the same replayed value the page already saw.
 *
 * An action is accepted only when it is the recorded action, for the recorded
 * table, carrying the decision context the real engine was waiting for. A
 * page that would have been refused by the engine is refused here.
 */
import type { Page, Request, Route, WebSocketRoute } from '@playwright/test';
import { readFileSync } from 'node:fs';
import jsonPatch from 'fast-json-patch';

export interface RecordedEntry {
  /** Milliseconds since the recording began. */
  at: number;
  kind: 'JOINED' | 'WIRE' | 'HERO_ACTS' | 'VILLAIN_ACTS' | 'RESULT' | 'END' | string;
  frame?: Record<string, unknown>;
  who?: 'hero' | 'villain';
  action?: string;
  amount?: number;
  context?: string;
}

export interface Recording {
  /** Engine clock (epoch ms) when the recording began. */
  t0: number;
  table: string;
  hero: string;
  villain: string;
  out: RecordedEntry[];
}

/** Read a recording: JSON Lines, the header then one frame per line. */
export function readRecording(path: string): Recording {
  const [head, ...out] = readFileSync(path, 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line));
  return { ...head, out } as Recording;
}

interface Segment {
  /** The hero's action that opens it; null for the opening segment. */
  marker: RecordedEntry | null;
  startAt: number;
  /** When the engine returned from the action (it has published by then). */
  resultAt: number | null;
  frames: RecordedEntry[];
}

export interface AcceptedAction {
  at: number;
  action: string;
  actionContext: string;
}

const ENGINE_HOST = 'engine.smarter.poker';
const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': '*',
  'access-control-allow-methods': 'GET,POST,OPTIONS',
};
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function split(recording: Recording): Segment[] {
  const segments: Segment[] = [];
  let current: Segment | null = null;
  for (const entry of recording.out) {
    if (entry.kind === 'JOINED') {
      current = { marker: null, startAt: entry.at, resultAt: null, frames: [] };
      segments.push(current);
    } else if (entry.kind === 'HERO_ACTS') {
      current = { marker: entry, startAt: entry.at, resultAt: null, frames: [] };
      segments.push(current);
    } else if (!current) {
      continue;
    } else if (entry.kind === 'WIRE') {
      current.frames.push(entry);
    } else if (entry.kind === 'RESULT' && entry.who === 'hero' && current.resultAt === null) {
      current.resultAt = entry.at;
    }
  }
  return segments;
}

export interface Hold {
  /** Segment index (1 = after the hero's first action). */
  segment: number;
  /** The first frame this is true for, and every frame after it, is delayed. */
  fromFirst: (frame: Record<string, any>) => boolean;
  extraMs: number;
}

export class ReplayEngine {
  /** Actions the page sent that the recorded engine would have accepted. */
  readonly accepted: AcceptedAction[] = [];
  /** Anything the page did that the real engine would have refused. */
  readonly problems: string[] = [];
  /** Requests for a time bank; a page that is shown its turns makes none. */
  readonly timeBankRequests: number[] = [];
  /** Every frame sent, for the test's own report. */
  readonly sent: Array<{ at: number; type: string; detail: string }> = [];
  /**
   * Delay part of one segment. The frames are still the engine's; only their
   * spacing is stretched, which is what a slow link or a busy engine does.
   */
  hold: Hold | null = null;

  private readonly segments: Segment[];
  private readonly sockets = new Set<WebSocketRoute>();
  private readonly timers = new Set<ReturnType<typeof setTimeout>>();
  private readonly timeMemo = new Map<number, number>();
  private delta = 0;
  private state: Record<string, unknown> | null = null;
  private lastSeq = 0;
  private started = false;
  private nextSegment = 1;
  private pinger: ReturnType<typeof setInterval> | null = null;

  private constructor(private readonly recording: Recording) {
    this.segments = split(recording);
  }

  static async install(page: Page, recording: Recording): Promise<ReplayEngine> {
    const engine = new ReplayEngine(recording);
    // Registered after the suite's sign-in: the newest route answers first.
    await page.routeWebSocket(
      (url) => url.hostname === ENGINE_HOST,
      (ws) => engine.onSocket(ws)
    );
    await page.route(
      (url) => url.hostname === ENGINE_HOST,
      (route, request) => engine.onHttp(route, request)
    );
    return engine;
  }

  /** The hero decisions the recording holds, in order. */
  get decisions(): Array<{ action: string; context: string }> {
    return this.segments
      .filter((s) => s.marker)
      .map((s) => ({ action: String(s.marker?.action), context: String(s.marker?.context) }));
  }

  dispose(): void {
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
    if (this.pinger) clearInterval(this.pinger);
    this.pinger = null;
  }

  // ── the socket: the multiplexed protocol the page speaks in production ──

  private onSocket(ws: WebSocketRoute): void {
    ws.onMessage((data) => {
      let msg: { type?: string; tableId?: string } | null = null;
      try {
        msg = JSON.parse(String(data));
      } catch {
        return;
      }
      if (!msg || typeof msg.type !== 'string') return;
      if (msg.type === 'SUBSCRIBE') {
        if (msg.tableId !== this.recording.table) {
          this.problems.push(
            `the page subscribed to a table the recording does not hold: ${msg.tableId}`
          );
          return;
        }
        this.sockets.add(ws);
        ws.send(JSON.stringify({ type: 'SUBSCRIBED', tableId: msg.tableId }));
        if (!this.started) {
          this.started = true;
          this.pinger = setInterval(() => {
            for (const socket of this.sockets) {
              try {
                socket.send(JSON.stringify({ type: 'PING', ts: Date.now() }));
              } catch {
                /* a closed socket is removed by its own close */
              }
            }
          }, 5_000);
          this.play(0, Date.now());
        } else {
          this.sendSnapshotTo(ws);
        }
      } else if (msg.type === 'RESYNC') {
        this.sendSnapshotTo(ws);
      } else if (msg.type === 'UNSUBSCRIBE') {
        this.sockets.delete(ws);
      }
    });
    ws.onClose(() => {
      this.sockets.delete(ws);
    });
  }

  private sendSnapshotTo(ws: WebSocketRoute): void {
    if (!this.state) return;
    ws.send(
      JSON.stringify({
        type: 'SNAPSHOT',
        tableId: this.recording.table,
        seq: this.lastSeq,
        state: this.state,
      })
    );
  }

  // ── the clock: one recorded instant is one replayed instant ──

  private mapTime(recorded: number): number {
    const known = this.timeMemo.get(recorded);
    if (known !== undefined) return known;
    const mapped = recorded + this.delta;
    this.timeMemo.set(recorded, mapped);
    return mapped;
  }

  private shift<T>(value: T): T {
    if (typeof value === 'number') {
      const near = Math.abs(value - this.recording.t0) < 6 * 3_600_000;
      return (near ? this.mapTime(value) : value) as T;
    }
    if (Array.isArray(value)) return value.map((item) => this.shift(item)) as T;
    if (value && typeof value === 'object') {
      const copy: Record<string, unknown> = {};
      for (const [key, item] of Object.entries(value)) copy[key] = this.shift(item);
      return copy as T;
    }
    return value;
  }

  // ── playback ──

  private play(index: number, startedAt: number): void {
    const segment = this.segments[index];
    if (!segment) return;
    this.delta = startedAt - (this.recording.t0 + segment.startAt);
    const hold = this.hold && this.hold.segment === index ? this.hold : null;
    const heldFrom = hold
      ? segment.frames.findIndex((entry) => hold.fromFirst(entry.frame as Record<string, any>))
      : -1;
    for (const [position, entry] of segment.frames.entries()) {
      let offset = entry.at - segment.startAt;
      if (hold && heldFrom >= 0 && position >= heldFrom) offset += hold.extraMs;
      const wait = Math.max(0, offset - (Date.now() - startedAt));
      const timer = setTimeout(() => {
        this.timers.delete(timer);
        this.emit(entry.frame as Record<string, unknown>);
      }, wait);
      this.timers.add(timer);
    }
  }

  private emit(recorded: Record<string, unknown>): void {
    const frame = this.shift(recorded) as Record<string, any>;
    if (frame.type === 'SNAPSHOT') {
      this.state = frame.state;
      this.lastSeq = frame.seq;
    } else if (frame.type === 'DELTA' && this.state) {
      this.state = jsonPatch.applyPatch(structuredClone(this.state), frame.patch).newDocument;
      this.lastSeq = frame.seq;
    }
    const state = this.state as Record<string, any> | null;
    this.sent.push({
      at: Date.now(),
      type: String(frame.type),
      detail:
        frame.type === 'EVENT'
          ? `${frame.payload?.type} seat ${frame.payload?.seat ?? '-'}`
          : `stage ${state?.stage} actor ${String(state?.current_player).slice(0, 8)} context ${String(
              state?.action_context ?? ''
            )
              .split(':')
              .slice(1)
              .join(':')} clock ${state?.turn_start_time_ms}`,
    });
    const data = JSON.stringify(frame);
    for (const socket of this.sockets) {
      try {
        socket.send(data);
      } catch {
        /* a closed socket is removed by its own close */
      }
    }
  }

  // ── the HTTP door ──

  private json(route: Route, body: unknown, status = 200): Promise<void> {
    return route.fulfill({
      status,
      contentType: 'application/json',
      headers: CORS,
      body: JSON.stringify(body),
    });
  }

  private async onHttp(route: Route, request: Request): Promise<void> {
    const url = new URL(request.url());
    if (request.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: CORS });
    if (url.pathname === '/action' && request.method() === 'POST') {
      return this.onAction(route, request);
    }
    if (url.pathname === '/heartbeat') {
      return this.json(route, { success: true, connected: true, gracePeriodRemaining: 0 });
    }
    if (url.pathname === '/preaction') return this.json(route, { success: true });
    if (url.pathname === '/timebank') {
      this.timeBankRequests.push(Date.now());
      return this.json(route, { success: false, error: 'Not Your Turn' }, 400);
    }
    if (url.pathname === '/away') return this.json(route, { success: true, tracked: true });
    if (url.pathname === '/health') return this.json(route, { status: 'ok', liveness: 'ok' });
    return route.fallback();
  }

  private async onAction(route: Route, request: Request): Promise<void> {
    let body: { tableId?: string; action?: string; actionContext?: string } = {};
    try {
      body = request.postDataJSON() ?? {};
    } catch {
      /* refused below */
    }
    const index = this.nextSegment;
    const segment = this.segments[index];
    const want = segment?.marker;
    if (!segment || !want) {
      this.problems.push(`an action the recording has no decision for: ${JSON.stringify(body)}`);
      return this.json(
        route,
        { success: false, error: 'Not your turn', code: 'NOT_YOUR_TURN' },
        400
      );
    }
    if (body.tableId !== this.recording.table || body.action !== want.action) {
      this.problems.push(
        `expected ${want.action} at ${this.recording.table}, the page sent ${JSON.stringify(body)}`
      );
      return this.json(
        route,
        { success: false, error: 'Invalid action', code: 'INVALID_ACTION' },
        400
      );
    }
    if (body.actionContext !== want.context) {
      // The real door: an action for a decision the engine is not waiting on.
      this.problems.push(
        `the engine was waiting on ${want.context}; the page answered ${String(body.actionContext)}`
      );
      return this.json(
        route,
        {
          success: false,
          error: 'The table view is out of date. Reload to continue.',
          code: body.actionContext ? 'STALE_ACTION' : 'ACTION_CONTEXT_REQUIRED',
        },
        400
      );
    }
    this.nextSegment = index + 1;
    const now = Date.now();
    this.accepted.push({ at: now, action: String(body.action), actionContext: want.context ?? '' });
    this.play(index, now);
    // The engine publishes the action's own frames before it answers.
    await sleep(Math.max(1, (segment.resultAt ?? segment.startAt) - segment.startAt + 2));
    return this.json(route, { success: true });
  }
}
