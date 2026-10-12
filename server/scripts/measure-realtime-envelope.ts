/**
 * THE ARENA KNOWS ITS LIMITS: LOBBY FAN-OUT, TABLE FAN-OUT, EVENT LOOP, RECONNECT STORMS
 *
 *     cd server && npx tsx scripts/measure-realtime-envelope.ts [--quick] [--out <file.json>]
 *
 * Diamond Phase 11 line 5 ("Measure lobby fan-out, action latency, event-loop
 * load, database locks and reconnect storms"). Production cannot show these
 * without risk: on 2026-09-30 it held no human table socket and no channel
 * socket at all (/ws-metrics), and a storm there would be a storm on live play.
 *
 * So this runs the engine's REAL transport - EngineWebSocketServer and
 * TableStateHub (/ws/table/:id), ChannelWebSocketServer and ChannelHub
 * (/ws/channel) - in one process bound to 127.0.0.1, exactly as index.ts
 * attaches them, with synthetic clients in separate processes so the server's
 * event loop measures only the server. Nothing else of the engine runs: no
 * GameServer, no table engines, no database. What it measures is what the
 * transport adds on top of whatever the engine's loop is already doing, which
 * is why the evidence file reads it against production's own loop numbers.
 *
 * ISOLATION IS ENFORCED, NOT ASSUMED:
 *  - the channel server's session check (supabase.auth.getUser) goes to a stub
 *    GoTrue this script starts on 127.0.0.1; SUPABASE_URL is set to it before
 *    any engine module loads, and the run refuses to start otherwise;
 *  - every outbound socket from the server process is refused unless its host
 *    is loopback (a guard on net.Socket.prototype.connect), so no code path can
 *    reach production, whatever its default URL says;
 *  - the table server's token and access checks are the injectable seams its
 *    own tests use (verifyToken, authorizeConnection).
 *
 * Event-loop numbers use the engine's own method (EquityLoadGovernor):
 * monitorEventLoopDelay({ resolution: 20 }) read and reset every second, and a
 * one-second timer's lateness; the published value is the worse of the two.
 * An idle loop therefore reads about 20 ms, as production's gauge does, and the
 * estate's thresholds (EngineCoreOutOfHeadroom > 40, EngineCoreSaturated > 300)
 * apply to these numbers unchanged.
 *
 * Latency is one-way, sender clock to receiver clock, both
 * performance.timeOrigin + performance.now() on the same machine.
 */
import { fork, type ChildProcess } from 'node:child_process';
import { performance, monitorEventLoopDelay } from 'node:perf_hooks';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const ROLE = process.argv[2] ?? 'orchestrator';
const SELF = fileURLToPath(import.meta.url);
const QUICK = process.argv.includes('--quick');
/** Only the lobby phases: the A/B of a ChannelHub change without the table runs. */
const LOBBY_ONLY = process.argv.includes('--lobby-only');
const now = () => performance.timeOrigin + performance.now();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type Msg = { type: string; [k: string]: unknown };

// ─── Shared helpers ──────────────────────────────────────────────────────────

/** A JWT-shaped bearer (three base64url parts) carrying the synthetic user id. */
function tokenFor(userId: string): string {
  const mid = Buffer.from(JSON.stringify({ sub: userId })).toString('base64url');
  return `h.${mid}.s`;
}
function userFromToken(token: string): string | null {
  try {
    return JSON.parse(Buffer.from(token.split('.')[1] ?? '', 'base64url').toString()).sub ?? null;
  } catch {
    return null;
  }
}
function userId(n: number): string {
  return `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
}
function tableId(n: number): string {
  return `00000000-0000-4000-9000-${n.toString(16).padStart(12, '0')}`;
}
function pct(sorted: number[], p: number): number {
  if (sorted.length === 0) return NaN;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[i];
}
function summary(values: number[]) {
  const s = [...values].sort((a, b) => a - b);
  const r = (x: number) => Math.round(x * 100) / 100;
  return {
    n: s.length,
    p50: r(pct(s, 50)),
    p95: r(pct(s, 95)),
    p99: r(pct(s, 99)),
    max: r(s.length ? s[s.length - 1] : NaN),
  };
}

/** Refuse any outbound connection that is not loopback, whatever module asks. */
function loopbackOnly(): void {
  const allowed = new Set(['127.0.0.1', 'localhost', '::1', '::ffff:127.0.0.1']);
  const original = net.Socket.prototype.connect;
  net.Socket.prototype.connect = function guarded(this: net.Socket, ...args: unknown[]) {
    const first = args[0] as unknown;
    const opts = (Array.isArray(first) ? first[0] : first) as
      | { host?: string; path?: string }
      | number
      | string
      | undefined;
    let host: string | undefined;
    if (typeof opts === 'object' && opts) {
      if (!opts.path) host = opts.host ?? 'localhost';
    } else if (typeof opts === 'number' || (typeof opts === 'string' && /^\d+$/.test(opts))) {
      host = typeof args[1] === 'string' ? (args[1] as string) : 'localhost';
    }
    if (host !== undefined && !allowed.has(host)) {
      throw new Error(`isolation guard: refused outbound connection to ${host}`);
    }
    return (original as (...a: unknown[]) => net.Socket).apply(this, args);
  } as typeof net.Socket.prototype.connect;
}

/** The engine's loop meter: 20 ms histogram + 1 s timer lateness, per second. */
function loopMeter() {
  const h = monitorEventLoopDelay({ resolution: 20 });
  h.enable();
  let expected = Date.now() + 1000;
  const windows: Array<{ p50: number; p99: number; late: number; published: number }> = [];
  const timer = setInterval(() => {
    const t = Date.now();
    const late = Math.max(0, t - expected);
    expected = t + 1000;
    const count = Number(h.count ?? 0);
    const p50 = count > 0 ? h.percentile(50) / 1e6 : NaN;
    const p99 = count > 0 ? h.percentile(99) / 1e6 : NaN;
    h.reset();
    windows.push({ p50, p99, late, published: Math.max(Number.isFinite(p50) ? p50 : 0, late) });
  }, 1000);
  timer.unref?.();
  return {
    mark: () => windows.length,
    since: (i: number) => {
      const w = windows.slice(i);
      const pub = w.map((x) => x.published);
      const p99s = w.map((x) => (Number.isFinite(x.p99) ? x.p99 : x.published));
      const r = (x: number) => Math.round(x * 10) / 10;
      return {
        seconds: w.length,
        p50_median: r(
          pct(
            [...pub].sort((a, b) => a - b),
            50
          )
        ),
        p50_max: r(Math.max(0, ...pub)),
        p99_max: r(Math.max(0, ...p99s)),
        timer_late_max: r(Math.max(0, ...w.map((x) => x.late))),
        seconds_over_40: pub.filter((x) => x > 40).length,
        seconds_over_300: pub.filter((x) => x > 300).length,
      };
    },
  };
}

// ─── Role: stub GoTrue (and an inert REST answer) on 127.0.0.1 ───────────────

function runAuthStub(): void {
  const delay = Number(process.env.AUTH_STUB_DELAY_MS ?? 0);
  let counts: Record<string, number> = {};
  const srv = http.createServer((req, res) => {
    const path = (req.url ?? '').split('?')[0];
    const key = path.startsWith('/rest/v1/') ? '/rest/v1/*' : path;
    counts[key] = (counts[key] ?? 0) + 1;
    const reply = () => {
      if (path === '/auth/v1/user') {
        const bearer = String(req.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
        const sub = userFromToken(bearer);
        if (!sub) {
          res.writeHead(401, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ code: 401, error_code: 'bad_jwt', msg: 'invalid JWT' }));
          return;
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            id: sub,
            aud: 'authenticated',
            role: 'authenticated',
            email: `${sub}@harness.invalid`,
            app_metadata: {},
            user_metadata: {},
            created_at: '2026-09-30T00:00:00Z',
          })
        );
        return;
      }
      if (path.startsWith('/rest/v1/')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('[]');
        return;
      }
      res.writeHead(404);
      res.end();
    };
    req.resume();
    req.on('end', () => (delay > 0 ? setTimeout(reply, delay) : reply()));
  });
  srv.keepAliveTimeout = 60_000;
  srv.listen(0, '127.0.0.1', () =>
    process.send?.({ type: 'ready', port: (srv.address() as net.AddressInfo).port })
  );
  process.on('message', (m: Msg) => {
    if (m.type === 'counts') {
      process.send?.({ type: 'counts', counts });
      if (m.reset) counts = {};
    }
  });
}

// ─── Role: the engine transport, alone, on 127.0.0.1 ─────────────────────────

const POSITIONS = ['BTN', 'SB', 'BB', 'UTG', 'HJ', 'CO', 'LJ', 'MP', 'UTG1'];

/** A published table state with the engine's field set (ServerTableEngine payload). */
function makeState(t: number, asset: 'chips' | 'diamonds', seats: number) {
  const players = Array.from({ length: seats }, (_, i) => ({
    user_id: userId(1_000_000 + t * 16 + i),
    seat: i + 1,
    username: `Player${t}_${i}`,
    avatar_url: `https://assets.invalid/avatars/${(t * 16 + i) % 97}.webp`,
    stack: 1000 + i * 37,
    bet: 0,
    total_invested: 0,
    is_folded: false,
    is_all_in: false,
    is_sitting_out: false,
    is_disconnected: false,
    status: 'active',
    position: POSITIONS[i],
    cards: [] as string[],
    has_cards: true,
    last_action: null as string | null,
    time_bank_seconds: 30,
    time_bank_uses: 2,
    continuity_stack: 1000 + i * 37,
    continuity_required: false,
    continuity_expires_at: null,
    is_horse: false,
    level: 12,
    country: 'US',
    is_vip: false,
  }));
  return {
    table_id: tableId(t),
    hand_number: 1,
    pot: 3,
    community_cards: [] as string[],
    community_cards2: [],
    community_cards3: [],
    hand_variant: 'nlh',
    bomb_pot_next_in: null,
    bomb_pot_next_at: null,
    kill_pot: null,
    next_kill_pot: null,
    ante: 0,
    current_bet: 2,
    current_player: players[3 % seats].user_id,
    dealer_seat: 1,
    stage: 'preflop',
    winner_ids: [] as string[],
    winners: [] as unknown[],
    min_raise: 4,
    last_raise: 2,
    betting_structure: 'no_limit',
    wagers_capped: false,
    action_context: { to_call: 2, min_raise_to: 4, max_raise_to: 1000 },
    turn_start_time_ms: Date.now(),
    turn_duration_ms: 15000,
    server_time_ms: Date.now(),
    turn_deadline_ms: Date.now() + 15000,
    time_bank_active: false,
    disconnect_states: {},
    max_seats: 9,
    is_anonymous: false,
    waiting_for_bb_user_ids: [] as string[],
    post_bb_deferred_user_ids: [] as string[],
    posting_bb_user_ids: [] as string[],
    pots: [{ amount: 3, eligible: players.map((p) => p.user_id) }],
    action_history: [] as Array<Record<string, unknown>>,
    players,
    asset,
    server_time_hr: 0,
  };
}
type TableState = ReturnType<typeof makeState>;

const RANKS = '23456789TJQKA';
const SUITS = 'hdcs';
/** One accepted action: the fields a real action changes, and a new hand every twelve. */
function act(s: TableState, n: number): void {
  const seats = s.players.length;
  const actorIdx = s.players.findIndex((p) => p.user_id === s.current_player);
  const actor = s.players[actorIdx >= 0 ? actorIdx : 0];
  const kind = ['call', 'raise', 'check', 'fold'][n % 4];
  const amount = kind === 'raise' ? 6 : kind === 'call' ? 2 : 0;
  actor.stack -= amount;
  actor.bet += amount;
  actor.total_invested += amount;
  actor.last_action = kind;
  s.pot += amount;
  s.current_bet = Math.max(s.current_bet, actor.bet);
  s.action_history.push({
    seat: actor.seat,
    userId: actor.user_id,
    action: kind,
    amount,
    timestamp: Date.now(),
    stage: s.stage,
  });
  const step = s.action_history.length;
  if (step === 4) {
    s.stage = 'flop';
    s.community_cards = [0, 1, 2].map((i) => RANKS[(n + i * 5) % 13] + SUITS[(n + i) % 4]);
  } else if (step === 7) {
    s.stage = 'turn';
    s.community_cards = [...s.community_cards, RANKS[(n + 3) % 13] + SUITS[(n + 2) % 4]];
  } else if (step === 10) {
    s.stage = 'river';
    s.community_cards = [...s.community_cards, RANKS[(n + 7) % 13] + SUITS[(n + 3) % 4]];
  } else if (step >= 12) {
    s.hand_number += 1;
    s.stage = 'preflop';
    s.community_cards = [];
    s.action_history = [];
    s.pot = 3;
    s.current_bet = 2;
    s.dealer_seat = (s.dealer_seat % seats) + 1;
    for (const p of s.players) {
      p.bet = 0;
      p.total_invested = 0;
      p.last_action = null;
    }
  }
  s.current_player = s.players[(actorIdx + 1 + seats) % seats].user_id;
  s.turn_start_time_ms = Date.now();
  s.server_time_ms = Date.now();
  s.turn_deadline_ms = Date.now() + 15000;
  s.pots = [{ amount: s.pot, eligible: s.players.map((p) => p.user_id) }];
  s.server_time_hr = now();
}

async function runServer(): Promise<void> {
  const stubPort = Number(process.env.HARNESS_AUTH_STUB_PORT);
  if (!Number.isInteger(stubPort) || stubPort <= 0) throw new Error('no auth stub port');
  process.env.SUPABASE_URL = `http://127.0.0.1:${stubPort}`;
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'isolated-harness-placeholder';
  loopbackOnly();
  if (!process.env.SUPABASE_URL.startsWith('http://127.0.0.1:')) throw new Error('not isolated');

  const { TableStateHub } = await import('../src/transport/TableStateHub.js');
  const { EngineWebSocketServer } = await import('../src/transport/EngineWebSocketServer.js');
  const { ChannelWebSocketServer } = await import('../src/transport/ChannelWebSocketServer.js');
  const { channelHub } = await import('../src/hub/ChannelHub.js');

  const hub = new TableStateHub();
  const tables = new Map<string, TableState>();
  const engineWs = new EngineWebSocketServer({
    hub,
    tableExists: (id: string) => tables.has(id),
    verifyToken: async (token: string) => {
      const sub = userFromToken(token);
      return sub ? { userId: sub } : { denied: 'invalid', code: 'invalid' };
    },
    authorizeConnection: async () => ({
      allowed: true,
      reason: 'club_member',
      clubId: 'harness-club',
      banned: false,
      ipRestricted: false,
    }),
  } as never);
  const channelWs = new ChannelWebSocketServer();
  const server = http.createServer((_req, res) => {
    res.writeHead(404);
    res.end();
  });
  engineWs.attach(server);
  channelWs.attach(server);
  const meter = loopMeter();
  let cpuAt = process.cpuUsage();
  let running: NodeJS.Timeout[] = [];

  await new Promise<void>((resolve) =>
    server.listen({ port: 0, host: '127.0.0.1', backlog: 4096 }, resolve)
  );
  process.send?.({ type: 'ready', port: (server.address() as net.AddressInfo).port });

  process.on('message', async (m: Msg) => {
    const reply = (body: Record<string, unknown>) =>
      process.send?.({ type: `${m.type}:done`, ...body });
    switch (m.type) {
      case 'loopMark':
        reply({ mark: meter.mark() });
        return;
      case 'loopRead':
        reply({ loop: meter.since(Number(m.mark)) });
        return;
      case 'cpuMark':
        cpuAt = process.cpuUsage();
        reply({});
        return;
      case 'cpuRead': {
        const d = process.cpuUsage(cpuAt);
        reply({ cpuMs: Math.round((d.user + d.system) / 1000) });
        return;
      }
      case 'counts':
        reply({
          tableSubscribers: hub.totalSubscribers(),
          tableSockets: engineWs.connectionCount(),
          channelSockets: channelHub.connectionCount(),
          lobbySubscribers: channelHub.lobbySubscriberCount(),
          backpressure: hub.backpressureStats(),
        });
        return;
      case 'lobbyBroadcast': {
        // What the maintenance break does: MaintenanceBreak.emitPresentation.
        const sync: number[] = [];
        for (let i = 0; i < Number(m.count); i++) {
          const t0 = now();
          channelHub.broadcastToLobby({
            type: 'LOBBY_UPDATE',
            kind: 'maintenance',
            payload: {
              active: true,
              phase: 'announced',
              break_id: 1790765580001,
              break_ends_at: null,
              scheduled_ends_at: '2026-09-30T12:03:00.000Z',
              reason: 'Scheduled Engine Maintenance',
              timestamp: Date.now(),
              seq: i,
              sent_at: t0,
            },
          } as never);
          sync.push(now() - t0);
          await sleep(Number(m.gapMs));
        }
        reply({ sync: summary(sync) });
        return;
      }
      case 'tablesCreate': {
        for (const t of tables.keys()) hub.dropTable(t);
        tables.clear();
        for (let t = 0; t < Number(m.K); t++) {
          const s = makeState(t, m.asset as 'chips' | 'diamonds', Number(m.seats));
          s.server_time_hr = now();
          tables.set(tableId(t), s);
          hub.publish(tableId(t), structuredClone(s));
        }
        const one = JSON.stringify(tables.get(tableId(0)));
        reply({ snapshotBytes: Buffer.byteLength(one) });
        return;
      }
      case 'tablesRun': {
        const sync: number[] = [];
        const period = 1000 / Number(m.rateHz);
        let n = 0;
        for (const [id, s] of tables) {
          const tick = () => {
            act(s, n++);
            const t0 = now();
            hub.publish(id, s as never);
            sync.push(now() - t0);
          };
          const phase = Math.random() * period;
          running.push(
            setTimeout(() => {
              tick();
              running.push(setInterval(tick, period));
            }, phase)
          );
        }
        await sleep(Number(m.durationMs));
        for (const t of running) clearInterval(t);
        running = [];
        reply({ publishes: sync.length, publishSync: summary(sync) });
        return;
      }
      case 'exit':
        process.exit(0);
    }
  });
}

// ─── Role: synthetic clients (one process holds many sockets) ────────────────

async function runClients(): Promise<void> {
  const { WebSocket } = await import('ws');
  type Sock = InstanceType<typeof WebSocket>;
  type Chan = {
    user: string;
    ws: Sock | null;
    openedAt: number;
    connectedAt: number;
    joinedAt: number;
    firstLobbyAt: number;
  };
  type Tab = { table: string; user: string; ws: Sock | null; openedAt: number; snapAt: number };
  let base = '';
  let chans: Chan[] = [];
  let tabs: Tab[] = [];
  const lobbyLat = new Map<number, number[]>();
  let lobbyMessages = 0;
  let tableLat: Array<[number, number]> = [];
  let deltaBytes: number[] = [];
  let failures = 0;
  let retries = 0;
  // EngineStateClient's ladder: base 1 s doubling to 30 s, plus up to 30% jitter.
  const backoff = (attempt: number) => {
    const b = Math.min(30_000, 1000 * 2 ** attempt);
    return b + Math.random() * b * 0.3;
  };

  const openChan = (c: Chan, delay: number, attempt = 0): NodeJS.Timeout =>
    setTimeout(() => {
      if (attempt === 0) c.openedAt = now();
      c.connectedAt = c.joinedAt = c.firstLobbyAt = 0;
      const ws = new WebSocket(`${base}/ws/channel`, ['bearer', tokenFor(c.user)]);
      c.ws = ws;
      ws.on('open', () => {
        c.connectedAt = now();
        ws.send(JSON.stringify({ type: 'JOIN_LOBBY' }));
        c.joinedAt = now();
      });
      ws.on('message', (raw) => {
        const t = now();
        let msg: { type?: string; kind?: string; payload?: { seq?: number; sent_at?: number } };
        try {
          msg = JSON.parse(raw.toString());
        } catch {
          return;
        }
        if (msg.type === 'LOBBY_UPDATE') {
          lobbyMessages++;
          if (!c.firstLobbyAt && c.joinedAt) c.firstLobbyAt = t;
          const p = msg.payload;
          if (msg.kind === 'maintenance' && typeof p?.sent_at === 'number') {
            const arr = lobbyLat.get(Number(p.seq)) ?? [];
            arr.push(t - p.sent_at);
            lobbyLat.set(Number(p.seq), arr);
          }
        } else if (msg.type === 'PING' || msg.type === 'CHANNEL_PING') {
          ws.send(JSON.stringify({ type: 'PONG' }));
        }
      });
      // A socket that dies before it is back retries on the client's ladder;
      // one that was back and is closed on purpose (a drop) does not.
      let settled = false;
      const retry = () => {
        if (settled || c.firstLobbyAt > 0) return;
        settled = true;
        retries++;
        openChan(c, backoff(attempt), attempt + 1);
      };
      ws.on('error', () => {
        failures++;
        retry();
      });
      ws.on('close', retry);
    }, delay);

  const openTab = (tb: Tab, delay: number, attempt = 0): NodeJS.Timeout =>
    setTimeout(() => {
      if (attempt === 0) tb.openedAt = now();
      tb.snapAt = 0;
      const ws = new WebSocket(`${base}/ws/table/${tb.table}`, ['bearer', tokenFor(tb.user)]);
      tb.ws = ws;
      ws.on('message', (raw) => {
        const t = now();
        const text = raw.toString();
        let msg: { type?: string; ts?: number; patch?: Array<{ path?: string; value?: unknown }> };
        try {
          msg = JSON.parse(text);
        } catch {
          return;
        }
        if (msg.type === 'SNAPSHOT') {
          if (!tb.snapAt) tb.snapAt = t;
        } else if (msg.type === 'DELTA') {
          const op = msg.patch?.find((o) => o.path === '/server_time_hr');
          if (op && typeof op.value === 'number') tableLat.push([op.value, t - op.value]);
          if (deltaBytes.length < 20_000) deltaBytes.push(Buffer.byteLength(text));
        } else if (msg.type === 'PING') {
          ws.send(JSON.stringify({ type: 'PONG', ts: msg.ts }));
        }
      });
      let settled = false;
      const retry = () => {
        if (settled || tb.snapAt > 0) return;
        settled = true;
        retries++;
        openTab(tb, backoff(attempt), attempt + 1);
      };
      ws.on('error', () => {
        failures++;
        retry();
      });
      ws.on('close', retry);
    }, delay);

  const waitUntil = async (done: () => boolean, timeoutMs: number) => {
    const end = Date.now() + timeoutMs;
    while (!done() && Date.now() < end) await sleep(25);
  };
  const chanStats = (startedAt: number, lobbyBefore: number) => ({
    n: chans.length,
    connected: chans.filter((c) => c.connectedAt > 0).length,
    lobbyReceived: chans.filter((c) => c.firstLobbyAt > 0).length,
    connectMs: summary(chans.filter((c) => c.connectedAt).map((c) => c.connectedAt - c.openedAt)),
    joinToFirstLobbyMs: summary(
      chans.filter((c) => c.firstLobbyAt).map((c) => c.firstLobbyAt - c.joinedAt)
    ),
    lastLobbyAt: Math.max(0, ...chans.map((c) => c.firstLobbyAt)),
    startedAt,
    lobbyMessages: lobbyMessages - lobbyBefore,
    failures,
    retries,
  });
  const tabStats = (startedAt: number) => ({
    n: tabs.length,
    snapshots: tabs.filter((t) => t.snapAt > 0).length,
    openToSnapshotMs: summary(tabs.filter((t) => t.snapAt).map((t) => t.snapAt - t.openedAt)),
    lastSnapshotAt: Math.max(0, ...tabs.map((t) => t.snapAt)),
    startedAt,
    failures,
    retries,
  });

  process.on('message', async (m: Msg) => {
    const reply = (body: Record<string, unknown>) =>
      process.send?.({ type: `${m.type}:done`, ...body });
    const spread = Number(m.spreadMs ?? 0);
    switch (m.type) {
      case 'init':
        base = String(m.base);
        reply({});
        return;
      case 'chanOpen':
      case 'chanReconnect': {
        const before = lobbyMessages;
        failures = retries = 0;
        if (m.type === 'chanOpen') {
          chans = (m.users as string[]).map((user) => ({
            user,
            ws: null,
            openedAt: 0,
            connectedAt: 0,
            joinedAt: 0,
            firstLobbyAt: 0,
          }));
        }
        for (const c of chans) c.connectedAt = c.joinedAt = c.firstLobbyAt = 0;
        const startedAt = now();
        for (const c of chans) openChan(c, Math.random() * spread);
        await waitUntil(() => chans.every((c) => c.firstLobbyAt > 0), Number(m.timeoutMs));
        await sleep(Number(m.settleMs ?? 0));
        reply(chanStats(startedAt, before));
        return;
      }
      case 'chanDrop':
        for (const c of chans) c.ws?.terminate();
        reply({});
        return;
      case 'lobbyCount':
        reply({ lobbyMessages });
        return;
      case 'lobbyLatReset':
        lobbyLat.clear();
        reply({});
        return;
      case 'lobbyLat':
        reply({ bySeq: Object.fromEntries(lobbyLat) });
        return;
      case 'tabOpen':
      case 'tabReconnect': {
        failures = retries = 0;
        if (m.type === 'tabOpen') {
          tabs = (m.assign as Array<{ table: string; user: string }>).map((a) => ({
            ...a,
            ws: null,
            openedAt: 0,
            snapAt: 0,
          }));
        }
        for (const tb of tabs) tb.snapAt = 0;
        const startedAt = now();
        for (const tb of tabs) openTab(tb, Math.random() * spread);
        await waitUntil(() => tabs.every((t) => t.snapAt > 0), Number(m.timeoutMs));
        reply(tabStats(startedAt));
        return;
      }
      case 'tabDrop':
        for (const t of tabs) t.ws?.terminate();
        reply({});
        return;
      case 'tabLatReset':
        tableLat = [];
        deltaBytes = [];
        reply({});
        return;
      case 'tabLat':
        reply({ lat: tableLat, deltaBytes: summary(deltaBytes) });
        return;
      case 'exit':
        process.exit(0);
    }
  });
}

// ─── Role: orchestrator ──────────────────────────────────────────────────────

function spawn(role: string, env: Record<string, string> = {}): ChildProcess {
  return fork(SELF, [role], {
    execArgv: process.execArgv,
    env: { ...process.env, ...env },
    stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
  });
}
function call(child: ChildProcess, type: string, body: Record<string, unknown> = {}): Promise<Msg> {
  return new Promise((resolve) => {
    const on = (m: Msg) => {
      if (
        m.type === `${type}:done` ||
        (type === 'counts' && m.type === 'counts' && 'counts' in m)
      ) {
        child.off('message', on);
        resolve(m);
      }
    };
    child.on('message', on);
    child.send({ type, ...body });
  });
}
function ready(child: ChildProcess): Promise<number> {
  return new Promise((resolve) => {
    const on = (m: Msg) => {
      if (m.type === 'ready') {
        child.off('message', on);
        resolve(Number(m.port));
      }
    };
    child.on('message', on);
  });
}
function split<T>(xs: T[], parts: number): T[][] {
  const out: T[][] = Array.from({ length: parts }, () => []);
  xs.forEach((x, i) => out[i % parts].push(x));
  return out;
}

async function runOrchestrator(): Promise<void> {
  const outIdx = process.argv.indexOf('--out');
  const outFile = outIdx > 0 ? process.argv[outIdx + 1] : null;
  const DRIVERS = 4;
  const LOBBY_N = QUICK ? [100, 300] : [250, 1000, 2000];
  const TABLE_RUNS: Array<{ K: number; asset: 'chips' | 'diamonds'; storm: boolean }> = LOBBY_ONLY
    ? []
    : QUICK
      ? [
          { K: 50, asset: 'chips', storm: true },
          { K: 50, asset: 'diamonds', storm: false },
        ]
      : [
          { K: 100, asset: 'chips', storm: false },
          // Chip and Diamond alternate twice at the same size, so the difference
          // between two runs of the same code is on the page beside the
          // difference between the two assets.
          { K: 300, asset: 'chips', storm: true },
          { K: 300, asset: 'diamonds', storm: true },
          { K: 300, asset: 'chips', storm: false },
          { K: 300, asset: 'diamonds', storm: false },
          { K: 600, asset: 'chips', storm: true },
        ];
  const SUBS_PER_TABLE = 8; // six seats and two spectators
  const RUN_MS = QUICK ? 8000 : 20000;

  const results: Record<string, unknown> = {
    harness: 'server/scripts/measure-realtime-envelope.ts',
    startedAt: new Date().toISOString(),
    env: {
      node: process.version,
      platform: `${os.platform()} ${os.release()}`,
      cpu: os.cpus()[0]?.model,
      cores: os.cpus().length,
      memGiB: Math.round(os.totalmem() / 2 ** 30),
      loadavgAtStart: os.loadavg().map((x) => Math.round(x * 10) / 10),
      clientDrivers: DRIVERS,
      quick: QUICK,
      lobbyOnly: LOBBY_ONLY,
    },
  };
  const log = (...a: unknown[]) => console.log('[envelope]', ...a);

  const stub = spawn('auth-stub');
  const stubPort = await ready(stub);
  const srv = spawn('server', { HARNESS_AUTH_STUB_PORT: String(stubPort) });
  const srvPort = await ready(srv);
  const drivers = Array.from({ length: DRIVERS }, () => spawn('clients'));
  await Promise.all(drivers.map((d) => call(d, 'init', { base: `ws://127.0.0.1:${srvPort}` })));
  const all = (type: string, body: (i: number) => Record<string, unknown> = () => ({})) =>
    Promise.all(drivers.map((d, i) => call(d, type, body(i))));
  const lobbyTotal = async () =>
    (await all('lobbyCount')).reduce((a, r) => a + Number(r.lobbyMessages), 0);
  const stubCounts = async (reset = true) =>
    ((await call(stub, 'counts', { reset })) as Msg).counts as Record<string, number>;
  log(`stub :${stubPort} server :${srvPort} drivers ${DRIVERS}`);

  // Idle loop: the floor every other number sits on.
  let mk = (await call(srv, 'loopMark')).mark;
  await sleep(QUICK ? 3000 : 6000);
  results.idleLoop = (await call(srv, 'loopRead', { mark: mk })).loop;
  log('idle', results.idleLoop);

  // ── Lobby: fan-out to N, then N drop and reconnect at once ──
  const lobby: Array<Record<string, unknown>> = [];
  for (const N of LOBBY_N) {
    const users = Array.from({ length: N }, (_, i) => userId(i + 1));
    const slices = split(users, DRIVERS);
    await stubCounts(true);
    // Paced arrival: N sockets over max(3 s, 3 ms each), not a storm.
    const paced = Math.max(3000, N * 3);
    mk = (await call(srv, 'loopMark')).mark;
    await call(srv, 'cpuMark');
    const opened = await all('chanOpen', (i) => ({
      users: slices[i],
      spreadMs: paced,
      timeoutMs: 180_000,
      settleMs: 1500,
    }));
    const pacedLoop = (await call(srv, 'loopRead', { mark: mk })).loop;
    const pacedCpu = (await call(srv, 'cpuRead')).cpuMs;
    const pacedMessages = opened.reduce((a, r) => a + Number(r.lobbyMessages), 0);
    const counts = await call(srv, 'counts');
    await sleep(1500);

    // Fan-out: maintenance presentations, 250 ms apart (what a break sends). Twenty
    // unmeasured ones first, so every socket is warm whatever the join phase sent it
    // (before the join fix each socket had already carried ~N/2 frames; after it, one).
    await call(srv, 'lobbyBroadcast', { count: 20, gapMs: 100 });
    await sleep(1000);
    await all('lobbyLatReset');
    mk = (await call(srv, 'loopMark')).mark;
    const bc = await call(srv, 'lobbyBroadcast', { count: LOBBY_ONLY ? 60 : 20, gapMs: 250 });
    await sleep(1500);
    const lat = await all('lobbyLat');
    const bySeq = new Map<number, number[]>();
    for (const r of lat)
      for (const [seq, arr] of Object.entries(r.bySeq as Record<string, number[]>))
        bySeq.set(Number(seq), [...(bySeq.get(Number(seq)) ?? []), ...arr]);
    const reachedAll = [...bySeq.values()].map((a) => Math.max(...a));
    const everyDelivery = [...bySeq.values()].flat();
    const delivered = [...bySeq.values()].map((a) => a.length);
    const fanLoop = (await call(srv, 'loopRead', { mark: mk })).loop;

    // Storm: every socket dies at once and every client comes back inside the
    // client's own reconnect jitter (EngineStateClient: base + up to 30%, 300 ms).
    await all('chanDrop');
    await sleep(2500);
    const afterDrop = await call(srv, 'counts');
    await stubCounts(true);
    const before = await lobbyTotal();
    mk = (await call(srv, 'loopMark')).mark;
    await call(srv, 'cpuMark');
    const stormStart = now();
    const storm = await all('chanReconnect', () => ({
      spreadMs: 300,
      timeoutMs: 180_000,
      settleMs: 3000,
    }));
    const stormLoop = (await call(srv, 'loopRead', { mark: mk })).loop;
    const stormCpu = (await call(srv, 'cpuRead')).cpuMs;
    const stormMessages = (await lobbyTotal()) - before;
    const stormAuth = await stubCounts(true);
    const lastLobby = Math.max(...storm.map((r) => Number(r.lastLobbyAt)));
    const row = {
      N,
      paced: {
        spreadMs: paced,
        lobbyReceived: opened.reduce((a, r) => a + Number(r.lobbyReceived), 0),
        lobbyMessagesSentToClients: pacedMessages,
        failedAttempts: opened.reduce((a, r) => a + Number(r.failures), 0),
        retries: opened.reduce((a, r) => a + Number(r.retries), 0),
        serverCpuMs: pacedCpu,
        loop: pacedLoop,
        serverCounts: counts,
      },
      fanout: {
        broadcasts: bySeq.size,
        deliveredPerBroadcast: summary(delivered),
        reachedAllMs: summary(reachedAll),
        perClientMs: summary(everyDelivery),
        serverSyncMs: bc.sync,
        loop: fanLoop,
      },
      storm: {
        socketsAfterDrop: afterDrop,
        reconnected: storm.reduce((a, r) => a + Number(r.lobbyReceived), 0),
        allBackMs: Math.round(lastLobby - stormStart),
        connectMs: storm.map((r) => r.connectMs),
        joinToFirstLobbyMs: storm.map((r) => r.joinToFirstLobbyMs),
        lobbyMessagesSentToClients: stormMessages,
        expectedIfJoinerOnly: N,
        expectedIfBroadcastToAll: (N * (N + 1)) / 2,
        serverCpuMs: stormCpu,
        loop: stormLoop,
        authRequests: stormAuth,
        failedAttempts: storm.reduce((a, r) => a + Number(r.failures), 0),
        retries: storm.reduce((a, r) => a + Number(r.retries), 0),
      },
    };
    lobby.push(row);
    log(`lobby N=${N}`, JSON.stringify(row));
    await all('chanDrop');
    await sleep(2500);
  }
  results.lobby = lobby;

  // ── Tables: K tables x 8 subscribers, one action per table per second ──
  const tablesOut: Array<Record<string, unknown>> = [];
  for (const cfg of TABLE_RUNS) {
    const created = await call(srv, 'tablesCreate', { K: cfg.K, asset: cfg.asset, seats: 6 });
    const assign: Array<{ table: string; user: string }> = [];
    for (let t = 0; t < cfg.K; t++)
      for (let s = 0; s < SUBS_PER_TABLE; s++)
        assign.push({ table: tableId(t), user: userId(100_000 + t * SUBS_PER_TABLE + s) });
    const slices = split(assign, DRIVERS);
    const opened = await all('tabOpen', (i) => ({
      assign: slices[i],
      spreadMs: 3000,
      timeoutMs: 120_000,
    }));
    await sleep(1000);
    await all('tabLatReset');
    mk = (await call(srv, 'loopMark')).mark;
    await call(srv, 'cpuMark');
    const run = await call(srv, 'tablesRun', { durationMs: RUN_MS, rateHz: 1 });
    await sleep(1000);
    const lat = await all('tabLat');
    const pairs = lat.flatMap((r) => r.lat as Array<[number, number]>);
    // One publish, many subscribers: the publish has reached every seat when its
    // slowest subscriber has it.
    const everySeat = new Map<number, number>();
    for (const [sent, ms] of pairs) everySeat.set(sent, Math.max(everySeat.get(sent) ?? 0, ms));
    const runLoop = (await call(srv, 'loopRead', { mark: mk })).loop;
    const runCpu = (await call(srv, 'cpuRead')).cpuMs;
    const row: Record<string, unknown> = {
      K: cfg.K,
      asset: cfg.asset,
      sockets: cfg.K * SUBS_PER_TABLE,
      snapshotBytes: created.snapshotBytes,
      opened: opened.reduce((a, r) => a + Number(r.snapshots), 0),
      publishesPerSecond: Math.round(Number(run.publishes) / (RUN_MS / 1000)),
      publishSyncMs: run.publishSync,
      deliveries: pairs.length,
      perSeatDeliveryMs: summary(pairs.map((p) => p[1])),
      actToEverySeatMs: summary([...everySeat.values()]),
      deltaBytes: lat[0]?.deltaBytes,
      serverCpuMs: runCpu,
      serverCpuShare: Math.round((Number(runCpu) / RUN_MS) * 100) / 100,
      loop: runLoop,
    };
    if (cfg.storm) {
      await all('tabDrop');
      await sleep(2500);
      const afterDrop = await call(srv, 'counts');
      await stubCounts(true);
      mk = (await call(srv, 'loopMark')).mark;
      await call(srv, 'cpuMark');
      const stormStart = now();
      const storm = await all('tabReconnect', () => ({ spreadMs: 300, timeoutMs: 120_000 }));
      await sleep(2000);
      const lastSnap = Math.max(...storm.map((r) => Number(r.lastSnapshotAt)));
      row.storm = {
        socketsAfterDrop: afterDrop,
        resubscribed: storm.reduce((a, r) => a + Number(r.snapshots), 0),
        allBackMs: Math.round(lastSnap - stormStart),
        openToSnapshotMs: storm.map((r) => r.openToSnapshotMs),
        serverCpuMs: (await call(srv, 'cpuRead')).cpuMs,
        loop: (await call(srv, 'loopRead', { mark: mk })).loop,
        failedAttempts: storm.reduce((a, r) => a + Number(r.failures), 0),
        retries: storm.reduce((a, r) => a + Number(r.retries), 0),
        stubRequests: await stubCounts(true),
      };
    }
    tablesOut.push(row);
    log(`tables K=${cfg.K} ${cfg.asset}`, JSON.stringify(row));
    await all('tabDrop');
    await sleep(2500);
  }
  results.tables = tablesOut;
  results.env = {
    ...(results.env as object),
    loadavgAtEnd: os.loadavg().map((x) => Math.round(x * 10) / 10),
  };
  results.finishedAt = new Date().toISOString();

  const text = JSON.stringify(results, null, 2);
  if (outFile) writeFileSync(outFile, text);
  console.log(text);
  for (const c of [srv, stub, ...drivers]) c.kill();
  process.exit(0);
}

// ─── Entry ───────────────────────────────────────────────────────────────────

const roles: Record<string, () => unknown> = {
  'auth-stub': runAuthStub,
  server: runServer,
  clients: runClients,
  orchestrator: runOrchestrator,
};
if (ROLE.startsWith('--')) void runOrchestrator();
else if (roles[ROLE]) void roles[ROLE]();
else throw new Error(`unknown role ${ROLE}`);
