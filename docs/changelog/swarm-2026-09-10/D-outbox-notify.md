# Workstream D - hand_projection_outbox: Realtime WAL decode -> LISTEN/NOTIFY

Read-only against production. No DDL run, no writes, no git writes. Engine code below is a
proposal (diffs), not committed anywhere.

## 1. Findings

### 1.1 The table

`public.hand_projection_outbox` (RLS on, no policies; grants: service_role SELECT, postgres ALL;
REPLICA IDENTITY default):

| column      | type                            | default           |
| ----------- | ------------------------------- | ----------------- |
| hand_id     | uuid PK                         |                   |
| table_id    | uuid                            |                   |
| hand_number | bigint UNIQUE (global sequence) |                   |
| created_at  | timestamptz                     | clock_timestamp() |

Indexes: `hand_projection_outbox_pkey(hand_id)`, `hand_projection_outbox_hand_number_key(hand_number)`,
`idx_hand_projection_outbox_table_hand(table_id, hand_number)`.

Triggers: exactly one - `a0_finish_hand_post_commit_obligations BEFORE DELETE FOR EACH ROW ->
trg_finish_hand_post_commit_obligations()`, which calls `fn_ca_process_hand_post_commit_obligations(OLD.hand_id)`
and raises if obligations are still pending (the delete is refused, the row stays). No INSERT/UPDATE triggers.

### 1.2 Row lifecycle

1. INSERT: `fn_ca_commit_hand_settlement_before_lease_generation` (the accepted-hand settlement
   RPC, engine/service_role) inserts `(hand_id, table_id, hand_number)` in the same transaction as
   `hand_history` and `hand_atomic_commits`, inside its `BEGIN ... EXCEPTION WHEN OTHERS` block.
   One row per hand. It is the only inserter in `pg_proc`.
2. READ: `fn_project_hand_side_effects(p_hand_id)` reads scope from the row (no lock), takes the
   per-table advisory locks, runs post-commit obligations, then calls
   `fn_project_hand_side_effects_after_post_commit_20260908`, which `SELECT ... FOR UPDATE OF o`
   claims the row, refuses with `predecessor_pending` if an earlier hand_number for the same table is
   still in the outbox, applies projections (club_member_daily_stats, club_member_table_state,
   club_hand_daily_shard, player_stats, position stats, ca_hand_player_idx/stat) ...
3. DELETE: ... and `DELETE FROM hand_projection_outbox WHERE hand_id = v_h.id` at the end of that
   same transaction; the BEFORE DELETE trigger re-asserts obligations are complete. The only deleter.
   `sp_prune_hand_history` only reads it (never prunes a hand that is still pending).

The row is therefore a durable claim, and the engine's Realtime subscription is nothing more than a
"something was inserted" wake-up (see 1.5).

### 1.3 Volume (pg_stat reset 2026-09-10 02:34:36 at the 2XL resize; measured at 03:09, 35 min)

| table in `supabase_realtime`         | ins   | upd | del    | writes             | live subscribers (realtime.subscription) |
| ------------------------------------ | ----- | --- | ------ | ------------------ | ---------------------------------------- |
| public.hand_projection_outbox        | 8,244 | 0   | 10,234 | **18,478 (95.5%)** | service_role x1, no filter               |
| public.club_members                  | 2     | 581 | 2      | 585                | authenticated x2, filter club_id=...     |
| public.tournament_manager_wakes      | 64    | 76  | 0      | 140                | service_role x2, no filter               |
| public.tournament_bounty_obligations | 10    | 127 | 0      | 137                | service_role x2, no filter               |
| public.notifications                 | 9     | 0   | 0      | 9                  | authenticated x6, filter user_id=...     |
| public.tournament_deal_votes         | 0     | 0   | 0      | 0                  | service_role x1, no filter               |

Only six tables are published. The outbox is 95.5% of all published-table changes. Every
service_role subscription was created at 02:56:38 (the last engine start).

Realtime poller (`SELECT wal->>$5 as type ...` as supabase_admin) since reset: **8,589 calls,
491 s total, 57.2 ms mean, 13,869 rows returned, 5.16% of all DB time** (was 7% / 242k calls /
60 ms over the previous 17 h). It runs ~4x/s whenever any subscriber exists; the per-call cost is
dominated by decoding + `realtime.apply_rls` on the outbox's INSERT and DELETE records.

Other candidates for the same treatment (service_role-only subscribers): `tournament_manager_wakes`,
`tournament_bounty_obligations`, `tournament_deal_votes` - together 277 writes / 35 min, i.e. 1.4% of
the published volume. Not worth doing now; if they are converted later the publication would contain
only client-facing tables (`club_members`, `notifications`).

### 1.4 Side finding: the outbox is 64k rows deep

At 03:09: **64,485 pending rows across 572 tables, oldest 2026-09-09 20:18 (6.8 h), 51,219 older
than 1 h, 603 inserted in the last minute.** The oldest 1,000 rows all have
`hand_atomic_commits.post_commit_completed_at` set (nothing is blocked on obligations) - the drain is
simply slower than the arrival rate. Since reset: `fn_project_hand_side_effects` 10,756 calls, 26.6 ms
mean DB time, and the sibling RPC 10,743 calls / 22.8 ms - the worker makes one serial PostgREST
round-trip per hand (~195 ms wall per hand incl. HTTP), i.e. ~300 hands/min against a daytime
arrival rate of ~600/min. It catches up at night (del 10,234 > ins 8,244 in the window).
This is a throughput problem in the serial drain, not a wake problem; NOTIFY neither fixes nor
worsens it. Flagging for the orchestrator: the drain could run one chain per table_id concurrently
(the DB already serialises per table with `pg_advisory_xact_lock('hand-projection:'||table_id)`).

### 1.5 Engine side (origin/main - the Mac working tree is at a 2026-09-06 commit and does not

contain this code; everything below was read with `git show origin/main:...`)

`server/src/services/supabase/handProjection.ts`:

- **Subscribe** (lines 278-297): `supabase.channel('hand-projection-outbox:' + pid).on('postgres_changes',
{ event: 'INSERT', schema: 'public', table: 'hand_projection_outbox' }, () => { void wakeHandProjection(); })`.
  The callback **ignores the payload entirely**; it only calls `wakeHandProjection()`.
- **Wake** (248-255): `wakeHandProjection()` cancels any pending backoff and calls `beginDrain()`, which
  coalesces onto one process-wide drain promise (217-245).
- **Drain** (126-193): `runDrain()` re-reads the table via PostgREST
  (`from('hand_projection_outbox').select('hand_id,hand_number').gt('hand_number', cursor).order(...).limit(100)`)
  and calls `rpc('fn_project_hand_side_effects', {p_hand_id})` per row, up to 1,000 rows, then
  self-continues (`wakeAfterDrain`) if it hit the cap. So the row payload from Realtime is never used;
  the table is the source of truth.
- **Reconnect handling** (287-296): only logs `CHANNEL_ERROR` / `TIMED_OUT` via `reportError`; it does
  not re-subscribe itself (supabase-js's socket reconnects and re-joins channels; on `SUBSCRIBED` it
  wakes once).
- **Polling fallback: NONE.** Header line 7: "There is no periodic poll." Line 189: "This is
  event-driven backlog continuation, not a correctness poll or timer." What exists instead:
  1. every locally committed hand wakes the worker directly -
     `server/src/services/supabase/handHistory.ts:717` `void wakeHandProjection().catch(...)` right
     after the settlement RPC returns;
  2. one drain at start (`startHandProjectionWorker()`, GameServer.ts:2061, leader boot only) and
     on `SUBSCRIBED`;
  3. a bounded causal retry (250 ms .. 15 s, x2) only after a drain that failed or deferred.
     Since the engine is the only writer of the outbox and wakes itself on every commit, the Realtime
     signal is redundant on the happy path; it matters only for a wake lost across a worker restart or
     a commit from a different process.
- Lifecycle: started in `GameServer.ts:2061` (leader boot), stopped in `GameServer.ts:2511`
  (`await stopHandProjectionWorker()` before lease release).

Direct Postgres: **none.** `server/package.json` dependencies are `@sentry/node`, `@supabase/supabase-js`,
`@types/uuid`, `fast-json-patch`, `uuid`, `ws`. No `pg`/`postgres` package, no `DATABASE_URL`-style env
var anywhere in `server/src` (the only psql reference is the test-only `CA_DEPARTURE_PSQL`). All DB
access is PostgREST over HTTPS. The Dockerfile sets `NODE_OPTIONS=--dns-result-order=ipv4first`;
the Hetzner host is IPv4.

Metrics style: services expose `toPrometheus(): string[]` and `GameServer` spreads them into the
`/metrics` body (e.g. `services/ReplicationMetrics.ts`, GameServer.ts:3145).

## 2. Design

Five sentences: an `AFTER INSERT FOR EACH ROW` trigger on `hand_projection_outbox` calls
`pg_notify('hand_projection_outbox', hand_id||':'||table_id)`, which is delivered at commit of the same
settlement transaction that today produces the WAL record Realtime decodes. The engine gets a new
`HandOutboxListener` service holding one dedicated `pg` client on a **session-mode** connection that
runs `LISTEN hand_projection_outbox` and calls the existing `wakeHandProjection()` on every
notification, exactly like the Realtime callback does (payload ignored except for metrics, because
the drain re-reads the table). The listener reconnects with exponential backoff (0.5 s .. 30 s, jittered),
sends a `SELECT 1` heartbeat every 30 s to detect dead sockets, and issues one wake after every
(re)connect so nothing committed while disconnected is lost. A new 5 s poll timer calls
`wakeHandProjection('poll')` when no drain is running (one 3 ms `limit 100` read when the outbox is
empty), so a dropped LISTEN connection can never stall projections. Ship with Realtime and LISTEN
both live and a per-source wake counter; after one clean :55 cycle drop the table from the
publication and delete the Realtime channel code.

Why the payload is `hand_id:table_id` and why the engine does not need the row: `runDrain()` never
used the Realtime row either; it orders by `hand_number` from the table, which also preserves the
per-table predecessor ordering that the SQL enforces. Carrying the ids costs nothing and gives the
listener a last-seen id for logs.

### 2.1 Connection-mode caveat (the important operational detail)

`LISTEN` is a session-level feature. It **does not work through Supavisor transaction mode
(port 6543)** and not through the dedicated PgBouncer pooler (transaction mode only). Options:

| endpoint                                                                                                    | LISTEN  | reachable from Hetzner (IPv4)                       |
| ----------------------------------------------------------------------------------------------------------- | ------- | --------------------------------------------------- |
| direct `db.kuklfnapbkmacvwxktbh.supabase.co:5432`                                                           | yes     | **no** - IPv6 only unless the IPv4 add-on is bought |
| Supavisor **session** mode `aws-?-us-west-2.pooler.supabase.com:5432`, user `postgres.kuklfnapbkmacvwxktbh` | **yes** | yes                                                 |
| Supavisor transaction mode `...pooler.supabase.com:6543`                                                    | no      | yes                                                 |

So the engine needs ONE new env var, `ENGINE_PG_LISTEN_URL`, holding the **session-mode pooler**
connection string (copy it from Dashboard > Connect > "Session pooler"; the exact `aws-N-` host is
shown there). Set it on Hetzner with the existing `update-hetzner-env` workflow
(`.github/workflows/update-hetzner-env.yml`, which appends `KEY=VALUE` to `/opt/club-arena/server/.env`
and restarts) - the value is never printed here. Recommended: the LISTEN-only role from the SQL file
(`engine_outbox_listener`, no table privileges) instead of `postgres`; this host was compromised once
(`.agent/audits/2026-08-15-SECURITY-INCIDENT-engine-host-compromise.md`), and a listener needs no
read access. The connection holds one Supavisor session-pool slot permanently (the engine uses zero
today - PostgREST is direct).

TLS: `pg` is configured `rejectUnauthorized: true`; if the pooler's chain is Supabase's private CA
rather than a public one, set `ENGINE_PG_LISTEN_CA_FILE` to the downloaded `prod-ca-2021.crt`
(Dashboard > Database > SSL). Verify before cutover with
`openssl s_client -connect <pooler-host>:5432 -starttls postgres </dev/null | head` - no secret involved.

If `ENGINE_PG_LISTEN_URL` is unset the listener logs a warning and does nothing; the 5 s poll and
the local commit wakes keep hands flowing. That is also the rollback state for the engine.

### 2.2 Why this is behaviour-identical for hands

- The trigger cannot fail a settlement: `pg_notify` raises only on payload > 8000 bytes (ours is 73)
  or an invalid channel name; it takes no row locks and no table locks.
- Notifications are transactional: a rolled-back settlement (the RPC's `EXCEPTION WHEN OTHERS`)
  discards its notification with the row; a committed one always emits it.
- If no backend is listening, notifications are dropped at commit for free.
- The engine's handler is the same `wakeHandProjection()`; the drain, claim, ordering and delete
  path are unchanged. A duplicate wake (local + LISTEN + Realtime during the overlap) is already
  the normal case today (local + Realtime) and is coalesced by `beginDrain()`.
- Removing the table from the publication only stops Realtime from decoding its WAL; nothing else
  reads that stream (`realtime.subscription` shows the one service_role subscriber only).

## 3. Engine code (proposal; TypeScript, ESM, matches server style)

### 3.1 `server/package.json`

```diff
   "dependencies": {
     "@sentry/node": "^10.46.0",
     "@supabase/supabase-js": "^2.49.1",
     "@types/uuid": "^10.0.0",
     "fast-json-patch": "^3.1.1",
+    "pg": "^8.13.1",
     "uuid": "^13.0.0",
     "ws": "^8.18.0"
   },
   "devDependencies": {
+    "@types/pg": "^8.11.10",
```

(`npm install` in the Dockerfile picks it up; `pg` has no native dependency by default.)

### 3.2 New file `server/src/services/supabase/handOutboxListener.ts`

```ts
/**
 * LISTEN-based wake for the hand projection worker.
 *
 * WHY THIS EXISTS (2026-09-10). The worker in ./handProjection.ts was woken by
 * a Realtime `postgres_changes` subscription on hand_projection_outbox. That
 * table gets one INSERT and one DELETE per hand (95% of everything in the
 * supabase_realtime publication), and Realtime has to logically decode and
 * RLS-check every one of those WAL records to deliver a callback whose payload
 * the worker never read: 5-7% of all database time for a wake-up. A NOTIFY
 * from the insert trigger carries the same signal for the cost of a queue
 * write at commit.
 *
 * This is a WAKE, not a data path. The payload (hand_id:table_id) is kept for
 * logs only; the drain re-reads the outbox ordered by hand_number, which is
 * what preserves the per-table predecessor order the database enforces.
 *
 * Connection requirements: LISTEN is session-level, so ENGINE_PG_LISTEN_URL
 * must be the Supavisor SESSION-mode string (port 5432 on the pooler host) or
 * a direct connection - never the transaction pooler on 6543. Unset = disabled;
 * the local commit wake and the 5 s poll in handProjection.ts still run.
 */

import { readFileSync } from 'node:fs';
import pg from 'pg';
import { reportError, describeError } from '../errorReporter.js';
import { wakeHandProjection } from './handProjection.js';

const { Client } = pg;
type PgClient = InstanceType<typeof Client>;

export const HAND_OUTBOX_CHANNEL = 'hand_projection_outbox';

const RECONNECT_BASE_MS = 500;
const RECONNECT_MAX_MS = 30_000;
const HEARTBEAT_MS = 30_000;
const CONNECT_TIMEOUT_MS = 10_000;

function sslConfig(): pg.ClientConfig['ssl'] {
  const caFile = process.env.ENGINE_PG_LISTEN_CA_FILE;
  if (caFile) return { ca: readFileSync(caFile, 'utf8'), rejectUnauthorized: true };
  return { rejectUnauthorized: true };
}

export class HandOutboxListener {
  private client: PgClient | null = null;
  private stopped = true;
  private attempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private connected = false;
  private connectsTotal = 0;
  private disconnectsTotal = 0;
  private notificationsTotal = 0;
  private lastNotificationAt = 0;
  private lastPayload = '';

  constructor(private readonly connectionString: string = process.env.ENGINE_PG_LISTEN_URL ?? '') {}

  get enabled(): boolean {
    return this.connectionString.length > 0;
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    if (!this.enabled) {
      console.warn(
        '[HandOutboxListener] ENGINE_PG_LISTEN_URL is not set - LISTEN disabled; projection relies on local commit wakes and the 5 s poll'
      );
      return;
    }
    void this.connect();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.stopHeartbeat();
    const client = this.client;
    this.client = null;
    this.connected = false;
    if (client) {
      client.removeAllListeners('error');
      client.on('error', () => undefined);
      await client.end().catch(() => undefined);
    }
  }

  private async connect(): Promise<void> {
    if (this.stopped || this.client) return;
    const client = new Client({
      connectionString: this.connectionString,
      application_name: `club-arena-engine-outbox-listener:${process.pid}`,
      keepAlive: true,
      connectionTimeoutMillis: CONNECT_TIMEOUT_MS,
      ssl: sslConfig(),
    });
    this.client = client;

    client.on('notification', (msg) => {
      if (msg.channel !== HAND_OUTBOX_CHANNEL) return;
      this.notificationsTotal++;
      this.lastNotificationAt = Date.now();
      this.lastPayload = msg.payload ?? '';
      // Same handler the Realtime callback used. The drain coalesces.
      void wakeHandProjection('listen').catch((err) =>
        reportError(err, 'HandOutboxListener.wake_failed', { payload: this.lastPayload })
      );
    });
    client.on('error', (err) => this.onLost(client, err));
    client.on('end', () => this.onLost(client, new Error('connection ended')));

    try {
      await client.connect();
      await client.query(`LISTEN ${HAND_OUTBOX_CHANNEL}`);
    } catch (err) {
      this.onLost(client, err);
      return;
    }
    if (this.stopped) {
      await client.end().catch(() => undefined);
      return;
    }

    this.connected = true;
    this.connectsTotal++;
    this.attempt = 0;
    this.startHeartbeat(client);
    console.log(
      `[HandOutboxListener] LISTEN ${HAND_OUTBOX_CHANNEL} established (connect #${this.connectsTotal})`
    );
    // Anything committed while this process had no LISTEN produced no
    // notification it could see. One drain covers the gap; duplicates are
    // harmless because the outbox row is the claim.
    void wakeHandProjection('listen_resync').catch((err) =>
      reportError(err, 'HandOutboxListener.resync_wake_failed')
    );
  }

  private onLost(client: PgClient, err: unknown): void {
    if (this.client !== client) return; // stale client from a previous attempt
    this.client = null;
    this.stopHeartbeat();
    const wasConnected = this.connected;
    this.connected = false;
    if (wasConnected) this.disconnectsTotal++;
    client.removeAllListeners('error');
    client.on('error', () => undefined);
    void client.end().catch(() => undefined);
    if (this.stopped) return;
    const delay = Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * 2 ** Math.min(this.attempt, 6));
    const jittered = Math.round(delay * (0.75 + Math.random() * 0.5));
    this.attempt++;
    reportError(
      new Error(
        `[HandOutboxListener] LISTEN connection lost (${describeError(err)}); reconnect in ${jittered} ms`
      ),
      'HandOutboxListener.connection_lost',
      { attempt: this.attempt, wasConnected }
    );
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.connect();
    }, jittered);
    this.reconnectTimer.unref?.();
  }

  private startHeartbeat(client: PgClient): void {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      // A half-open socket (pooler idle reap, NAT timeout) delivers nothing and
      // errors nothing. A trivial round-trip turns it into an error we handle.
      client.query('SELECT 1').catch((err) => this.onLost(client, err));
    }, HEARTBEAT_MS);
    this.heartbeatTimer.unref?.();
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
  }

  toPrometheus(): string[] {
    const sinceLast =
      this.lastNotificationAt === 0
        ? -1
        : Math.round((Date.now() - this.lastNotificationAt) / 1000);
    return [
      '# HELP poker_hand_outbox_listener_enabled 1 when ENGINE_PG_LISTEN_URL is configured.',
      '# TYPE poker_hand_outbox_listener_enabled gauge',
      `poker_hand_outbox_listener_enabled ${this.enabled ? 1 : 0}`,
      '# HELP poker_hand_outbox_listener_connected 1 while a LISTEN hand_projection_outbox session is open.',
      '# TYPE poker_hand_outbox_listener_connected gauge',
      `poker_hand_outbox_listener_connected ${this.connected ? 1 : 0}`,
      '# HELP poker_hand_outbox_listener_connects_total Successful LISTEN sessions established since process start.',
      '# TYPE poker_hand_outbox_listener_connects_total counter',
      `poker_hand_outbox_listener_connects_total ${this.connectsTotal}`,
      '# HELP poker_hand_outbox_listener_disconnects_total LISTEN sessions lost since process start.',
      '# TYPE poker_hand_outbox_listener_disconnects_total counter',
      `poker_hand_outbox_listener_disconnects_total ${this.disconnectsTotal}`,
      '# HELP poker_hand_outbox_notifications_total NOTIFY messages received on hand_projection_outbox.',
      '# TYPE poker_hand_outbox_notifications_total counter',
      `poker_hand_outbox_notifications_total ${this.notificationsTotal}`,
      '# HELP poker_hand_outbox_notification_age_seconds Seconds since the last NOTIFY; -1 when none yet.',
      '# TYPE poker_hand_outbox_notification_age_seconds gauge',
      `poker_hand_outbox_notification_age_seconds ${sinceLast}`,
    ];
  }
}
```

### 3.3 `server/src/services/supabase/handProjection.ts` (step 1: both paths + counters + poll)

```diff
@@ header comment
- * outside that locking path.  This worker is woken by the committing engine,
- * by Realtime, and once at process start. There is no periodic poll. A failed
+ * outside that locking path.  This worker is woken by the committing engine,
+ * by LISTEN hand_projection_outbox (services/supabase/handOutboxListener.ts),
+ * by Realtime until the 2026-09-10 cutover completes, once at process start,
+ * and by a 5 s safety poll that only fires when no drain is running. A failed
@@
 const DRAIN_PAGE = 100;
 const DRAIN_MAX = 1_000;
 const RETRY_BASE_MS = 250;
 const RETRY_MAX_MS = 15_000;
+/* Safety net for a lost wake (dropped LISTEN socket, Realtime channel in
+ * CHANNEL_ERROR, worker restarted between commit and wake). One `limit 100`
+ * read every 5 s when the outbox is empty is ~3 ms of database time; it is
+ * skipped entirely while a drain is already running. */
+const POLL_MS = Number(process.env.HAND_PROJECTION_POLL_MS ?? 5_000);
+
+export type HandProjectionWakeSource =
+  | 'local'         // handHistory.ts after the settlement RPC commits
+  | 'realtime'      // postgres_changes callback (removed at cutover step 2)
+  | 'listen'        // NOTIFY hand_projection_outbox
+  | 'listen_resync' // one drain after every LISTEN (re)connect
+  | 'poll'          // 5 s timer
+  | 'startup';      // startHandProjectionWorker
+
+const wakeCounts: Record<HandProjectionWakeSource, number> = {
+  local: 0, realtime: 0, listen: 0, listen_resync: 0, poll: 0, startup: 0,
+};
+
+/** Read-only view for /metrics. */
+export function handProjectionWakeCounts(): Readonly<Record<HandProjectionWakeSource, number>> {
+  return { ...wakeCounts };
+}
+
+export function handProjectionWakesToPrometheus(): string[] {
+  const out = [
+    '# HELP poker_hand_projection_wakes_total Wake signals delivered to the hand projection worker, by source.',
+    '# TYPE poker_hand_projection_wakes_total counter',
+  ];
+  for (const [source, n] of Object.entries(wakeCounts)) {
+    out.push(`poker_hand_projection_wakes_total{source="${source}"} ${n}`);
+  }
+  return out;
+}

 let channel: ReturnType<typeof supabase.channel> | null = null;
+let pollTimer: ReturnType<typeof setInterval> | null = null;
@@
-export function wakeHandProjection(): Promise<HandProjectionDrainSummary> {
+export function wakeHandProjection(
+  source: HandProjectionWakeSource = 'local'
+): Promise<HandProjectionDrainSummary> {
+  wakeCounts[source]++;
   if (!workerActive || stopping || !runOwnedDrain) return Promise.resolve(emptySummary());
@@ startHandProjectionWorker
       { event: 'INSERT', schema: 'public', table: 'hand_projection_outbox' },
       () => {
-        void wakeHandProjection();
+        void wakeHandProjection('realtime');
       }
     )
     .subscribe((status: string) => {
       if (status === 'SUBSCRIBED') {
-        void wakeHandProjection();
+        void wakeHandProjection('realtime');
@@
   channel = ch;

+  if (pollTimer) clearInterval(pollTimer);
+  pollTimer = setInterval(() => {
+    // A running drain already owns the outbox; a poll on top would only queue
+    // a redundant continuation pass.
+    if (drainPromise || !workerActive || stopping) return;
+    void wakeHandProjection('poll').catch((err) => reportError(err, 'HandProjection.poll_wake_failed'));
+  }, POLL_MS);
+  pollTimer.unref?.();
+
   // Also drain immediately.  This covers a process that starts while Realtime
   // is unavailable; normal local commits still wake this worker directly.
-  void wakeHandProjection();
+  void wakeHandProjection('startup');
 }

 export async function stopHandProjectionWorker(): Promise<void> {
   workerActive = false;
   stopping = true;
   runOwnedDrain = null;
   lifecycleEpoch++;
   wakeAfterDrain = false;
   cancelCausalRetry(true);
+  if (pollTimer) clearInterval(pollTimer);
+  pollTimer = null;
   const ch = channel;
```

`handHistory.ts:717` needs no change (default source `'local'`).

### 3.4 `server/src/GameServer.ts`

```diff
 import { ReplicationMetrics } from './services/ReplicationMetrics.js';
+import { HandOutboxListener } from './services/supabase/handOutboxListener.js';
+import { handProjectionWakesToPrometheus } from './services/supabase/handProjection.js';
@@ fields (~1474)
   private replicationMetrics = new ReplicationMetrics();
+  private handOutboxListener = new HandOutboxListener();
@@ leader boot (~2061)
       startHandProjectionWorker();
+      // Step 8c: LISTEN hand_projection_outbox. Started after the worker so
+      // its first (re)connect wake lands on a live worker. Disabled (warns)
+      // when ENGINE_PG_LISTEN_URL is unset - the worker's poll still runs.
+      this.handOutboxListener.start();
@@ shutdown (~2511)
+    await this.handOutboxListener.stop();
     await stopHandProjectionWorker();
@@ /metrics (~3145)
       ...this.replicationMetrics.toPrometheus(),
+      // ── HAND PROJECTION WAKES (2026-09-10) ───────────────────────────
+      // Which signal wakes the outbox drain. During the Realtime->LISTEN
+      // cutover, listen must be >= realtime before the table leaves the
+      // publication. See services/supabase/handOutboxListener.ts.
+      ...handProjectionWakesToPrometheus(),
+      ...this.handOutboxListener.toPrometheus(),
```

Also add `ENGINE_PG_LISTEN_URL=` (empty) and `ENGINE_PG_LISTEN_CA_FILE=` to `.env.example` with a
one-line comment "session-mode pooler string, port 5432, NOT 6543".

### 3.5 Tests to add (vitest, alongside `handProjection.test.ts`)

- `wakeHandProjection('listen')` increments `handProjectionWakeCounts().listen` and calls the same
  `beginDrain` path as `'local'` (spy on `supabase.from`).
- `HandOutboxListener` with an injected fake `pg.Client` (constructor takes the URL; mock `pg`): on
  `notification` for channel `hand_projection_outbox` it calls `wakeHandProjection('listen')`; on
  `error` it schedules a reconnect with growing delay and increments disconnects; `stop()` ends the
  client and cancels timers; an empty URL makes `start()` a no-op with `enabled=false`.
- Poll: with fake timers, `startHandProjectionWorker()` followed by 5 s advances one `'poll'` wake
  only when `drainPromise` is null.

### 3.6 Step 2 code removal (after the publication DROP)

In `handProjection.ts` delete the `channel` variable, the `supabase.channel(...).on('postgres_changes', ...)`
block (278-297) and the `removeChannel` branch in `stopHandProjectionWorker`; drop `'realtime'` from
`HandProjectionWakeSource`. Nothing else in `server/src` references that channel.

## 4. Cutover

1. **DB step 1** (orchestrator, any time): apply `D-outbox-notify.sql` step 1 (function + trigger,
   optionally the listener role). Zero effect on the engine until it listens. Verify:
   `SELECT tgname FROM pg_trigger WHERE tgrelid='public.hand_projection_outbox'::regclass AND NOT tgisinternal`
   shows both triggers.
2. **Env**: set `ENGINE_PG_LISTEN_URL` (session pooler, port 5432) via `update-hetzner-env`. Confirm
   the TLS chain as in 2.1.
3. **Engine deploy** (normal :55 cycle) with sections 3.1-3.4. Both wake paths active.
4. **Verify over one full hour of hands** on `/metrics`:
   - `poker_hand_outbox_listener_connected 1`, `poker_hand_outbox_listener_disconnects_total` not climbing,
   - `poker_hand_projection_wakes_total{source="listen"}` >= `{source="realtime"}` and both tracking
     `poker_hands_total`,
   - `poker_hand_projection_wakes_total{source="poll"}` small and mostly when idle,
   - outbox depth not worse than before (`SELECT count(*) FROM hand_projection_outbox`; it is 64k
     today for the reason in 1.4, so compare trend, not absolute).
   - `pg_stat_activity` shows one `client backend` with `application_name` starting
     `club-arena-engine-outbox-listener` (via the pooler it appears as the pooler's user).
5. **DB step 2** (orchestrator, at a :55 or any quiet moment - a publication change is DDL and
   costs the ~28 s PostgREST reload): `ALTER PUBLICATION supabase_realtime DROP TABLE public.hand_projection_outbox;`
   Realtime tears down the outbox channel on its side (engine logs `CHANNEL_ERROR`/`CLOSED` once - expected;
   the worker keeps running on LISTEN + local wakes + poll).
   Verify within 10 min: `realtime.subscription` no longer lists the outbox; the poller's
   `mean_exec_time` in `pg_stat_statements` drops from ~57 ms toward single digits; `hand_projection_outbox`
   `n_tup_del` keeps pace with `n_tup_ins`.
6. **Engine cleanup deploy** (next :55): section 3.6.

Expected saving: the outbox was 95.5% of decoded changes; the poller is 5.2-7% of DB time, so
roughly 5-6.5% of database time, plus the per-hand `realtime.apply_rls` work, disappears. The added
cost is one notification queue write per hand and one idle session connection.

## 5. Risks

- **Wrong pooler port** (6543): `LISTEN` returns an error or silently never delivers. The listener
  would reconnect forever with `connected 0`; hands still flow on local wakes + poll. Caught by step 4.
- **Session pooler idle reap / NAT half-open**: handled by the 30 s heartbeat + reconnect + resync wake.
- **NOTIFY queue**: only grows if a listener is connected but not reading; `pg` drains continuously.
  Postgres warns at 50% of the (8 GB) queue - unreachable at 73 bytes x 600/min.
- **The 64k backlog** (1.4) is orthogonal and will not improve from this change.
- **Do not** point the listener at the direct `db.*.supabase.co` host from Hetzner without the IPv4
  add-on; it will not resolve to a reachable address.

## 6. Rollback

- Engine: unset `ENGINE_PG_LISTEN_URL` (listener disabled, warns) or redeploy the previous image;
  the 5 s poll and local wakes alone are sufficient for correctness.
- DB step 2: `ALTER PUBLICATION supabase_realtime ADD TABLE public.hand_projection_outbox;` -
  the Realtime channel code (if still deployed) re-subscribes on the next engine start.
- DB step 1: `DROP TRIGGER z9_notify_hand_projection_outbox ON public.hand_projection_outbox; DROP FUNCTION public.trg_notify_hand_projection_outbox();`
  (and `DROP ROLE engine_outbox_listener` if created). Nothing existing was redefined - see the
  ROLLBACK section of `D-outbox-notify.sql`.
