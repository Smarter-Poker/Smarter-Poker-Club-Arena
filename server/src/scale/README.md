# `scale/` — Horizontal Scale + Zero-Downtime Deploy Foundation

**Issue #4 — Club Arena engine.** This folder is the _foundation_ for scaling the
game server horizontally and deploying it without kicking players mid-hand. It is
**standalone, `tsc`-clean, and unit-tested**, but it is **not yet wired into the
live `GameServer` / `ServerTableEngine`** — integration is a small, additive,
documented step (see [Integration](#integration)). Nothing here edits the engine
files owned by another workstream.

---

## Why this exists (grounded in the current code)

Today the whole platform is **one Node process**:

- `GameServer` holds `tableEngines: Map<tableId, ServerTableEngine>`. A 5-second
  discovery loop polls Supabase, does `new ServerTableEngine(id)` +
  `engine.setHub(hub)` + `engine.start()`, and tears down via `engine.stop()` /
  `isRunning()` + `tableStateHub.dropTable(id)`.
- The WS layer (`EngineWebSocketServer`, `/ws/table/:tableId`) resolves a table's
  engine with `gameServer.getTableEngine(tableId)`.
- `ChannelWebSocketServer` + `ChannelHub` (`/ws/channel`) already do in-process
  pub/sub for lobby, presence, tournaments, and hand replays.
- Shutdown is abrupt: `SIGTERM` → `gameServer.stop()` stops **all** engines at
  once. A deploy therefore interrupts live hands.

Two ceilings follow: (1) **one CPU-bound process** caps concurrent tables, and
(2) **no graceful handoff** means no zero-downtime deploy. This package supplies
the three missing primitives to break both ceilings, without changing engine
internals.

---

## What's in here

| File                    | Status               | Purpose                                                                                                                                        |
| ----------------------- | -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `TableRouter.ts`        | **working code now** | Pure `tableId → worker` mapping via weighted **rendezvous (HRW) hashing**. Minimal reassignment on worker add/remove.                          |
| `ShardManager.ts`       | **foundation only**  | Generation/epoch-fenced worker ownership, READY-only routing, health fencing, and verified **DRAIN + handoff**. Not wired to `GameServer` yet. |
| `ShardWorkerRuntime.ts` | **working code now** | Worker-side brain: translates control messages ↔ a `TableHost`. Reused by both the real thread harness and tests.                              |
| `scaleWorkerHarness.ts` | **working code now** | Real `worker_threads` entry point; engine-agnostic; loads a `TableHost` module (the engine seam).                                              |
| `CrossNodeBus.ts`       | **working code now** | Cross-worker/node pub-sub. `InMemoryCrossNodeBus` (EventEmitter) today; Redis/NATS adapter seam documented.                                    |
| `protocol.ts`           | **working code now** | The manager ↔ worker message contract (transport-neutral).                                                                                     |
| `index.ts`              | barrel               | Public exports.                                                                                                                                |
| `*.test.ts`             | **passing**          | Unit tests for router distribution/stability, bus fan-out, and drain/handoff.                                                                  |

> **Release boundary:** this package runs and is unit-tested in isolation, but it
> is not a production capacity fix until a real `TableHost`, gateway/hub bridge,
> durable ownership store, and exact state/presentation replay are wired into
> `GameServer`. Multi-node additionally needs a coordination store + message bus +
> a WS gateway tier; see
> [Path to multi-node](#path-to-multi-node).

---

## Architecture

```
                    ┌───────────────────────────────────────────┐
                    │            WS GATEWAY TIER (future)         │
   players ───────► │  stateless; terminates /ws/table/:id sockets│
                    │  looks up owner via TableRouter + ownership │
                    │  store, proxies/redirects to the right node │
                    └───────────────┬─────────────────────────────┘
                                    │ (today: same process)
                    ┌───────────────▼─────────────────────────────┐
                    │              CONTROL PLANE                    │
                    │   ShardManager  +  TableRouter               │
                    │   • spawn / health / assign / DRAIN          │
                    └───┬───────────────┬───────────────┬──────────┘
                        │ worker_threads │               │
                 ┌──────▼─────┐   ┌──────▼─────┐   ┌──────▼─────┐
                 │  worker 0  │   │  worker 1  │   │  worker N  │   ← compute
                 │ TableHost  │   │ TableHost  │   │ TableHost  │
                 │  ┌───────┐ │   │  ┌───────┐ │   │  ┌───────┐ │
                 │  │ STE   │ │   │  │ STE   │ │   │  │ STE   │ │   ServerTableEngine
                 │  │ STE   │ │   │  │ STE   │ │   │  │ STE   │ │   instances
                 └──────┬─────┘   └──────┬─────┘   └──────┬─────┘
                        │                │                │
                    ┌───▼────────────────▼────────────────▼───┐
                    │  EVENT LOG (append-only, per table)       │  ← other agent's module
                    │  workers are STATELESS: rebuild table     │
                    │  state by replaying the log on open       │
                    └───────────────────────────────────────────┘
                    ┌───────────────────────────────────────────┐
                    │   CrossNodeBus  (lobby/presence/waitlist/   │
                    │   tournament fan-out across all workers)    │
                    └───────────────────────────────────────────┘
```

### 1. WS gateway tier separate from compute

Split the process into a **stateless gateway** (accepts WebSocket connections,
authenticates, and forwards) and **compute workers** (run engines). The gateway
asks the `TableRouter` (+ an ownership store) which worker/node owns a table and
proxies the socket there. Because routing is a pure function of the worker set,
the gateway needs no per-table state and can scale independently.
_In-repo today:_ the router exists; the gateway split is an infra change (the
current `EngineWebSocketServer` already isolates the transport, so this is a
wrapper, not a rewrite).

### 2. Table sharding

`TableRouter` maps each `tableId` to one owning worker with **weighted rendezvous
hashing**. Chosen over a classic hash ring because it stays balanced with no
virtual-node bookkeeping and gives the **minimal-reassignment** guarantee that
drains and elastic scaling depend on:

- **Add a worker** → only ~`1/(N+1)` of tables move, and they only move _onto the
  new worker_ (never between existing workers).
- **Remove a worker** → only the tables that lived on it move; all others stay
  put.
  Both properties are asserted in `TableRouter.test.ts`.

### 3. Event-log-backed stateless workers

For a table to be handed from one worker to another (drain, failover, rebalance),
the receiving worker must be able to **reconstruct table state without the old
worker's memory**. That is exactly what the **event log** (append-only per-table
action log — the module another agent is building) provides. The contract:

- On every state transition, the engine **appends** to the table's event log.
- `TableHost.openTable(id)` **resumes** by replaying the log to the last
  consistent hand boundary (or starts fresh if empty).
- Workers hold only a cache; the log is the source of truth.
  This makes workers disposable and is what turns "drain" from "drop players" into
  "finish the hand, replay it elsewhere." _In-repo today:_ `ShardManager` calls
  `openTable` on handoff; the resume-from-log body is filled in when the event-log
  module lands (see [Integration](#integration)).

### 4. Blue-green / rolling deploy via drain + handoff

`ShardManager.drainWorker()` is the deploy primitive:

1. Take the worker **out of routing** (`TableRouter.removeWorker`) so no new
   tables land on it.
2. Send an epoch-scoped `DRAIN`; the worker **finishes each in-flight hand**
   (`pauseAfterHand()` → hand boundary → `stop()`), emitting `TABLE_CLOSED` per
   exact table lease and a final close/failure manifest.
3. Only tables with matching close evidence route to a **READY surviving
   worker** and receive a new-epoch `ASSIGN`; failed tables stay fenced to the
   old process and make the drain fail.
   (resume from the event log).
4. Terminate the drained worker.

**Rolling deploy:** spawn the new-generation workers, then `drainWorker()` the old
ones one at a time. **Blue-green:** stand up a full green worker set, drain the
entire blue set, cut over. The isolated control-plane tests assert that old
generations cannot acknowledge new work and that unverified closes never move.

### 5. Cross-node event bus

`CrossNodeBus` fans platform events (lobby, presence, waitlist, tournament
coordination) to every worker/node. Today `InMemoryCrossNodeBus` (EventEmitter)
covers a single process. `ChannelHub` becomes a **consumer**: a node publishes a
presence change to the bus; every node receives it and pushes to its locally
connected WS clients. Swapping to Redis/NATS is a config change (same interface).

---

## Integration (the additive wiring, when ready)

None of this touches engine internals. The engine-owning code provides **one
adapter** — a `TableHost` — that maps the abstract operations onto the real
engine. Sketch (lives _outside_ this package, e.g. `server/src/scale-integration/`):

```ts
// engineTableHost.ts  (engine agent owns this file)
import type { TableHost } from '../scale/ShardWorkerRuntime.js';
import { ServerTableEngine } from '../engine/ServerTableEngine.js';
import { tableStateHub } from '../transport/TableStateHub.js';

export function createTableHost(): TableHost {
  const engines = new Map<string, ServerTableEngine>();
  return {
    async openTable(id) {
      const e = new ServerTableEngine(id); // resume-from-eventlog goes here
      e.setHub(tableStateHub);
      await e.start();
      engines.set(id, e);
    },
    async drainTable(id) {
      const e = engines.get(id);
      if (!e) return;
      e.pauseAfterHand(); // finish current hand (hand-boundary safe)
      await waitForHandBoundary(e); // poll isWaitingForHandForHand()/getHandCount()
      await e.stop();
      engines.delete(id);
    },
    async closeTable(id) {
      await engines.get(id)?.stop();
      engines.delete(id);
    },
    tableIds: () => [...engines.keys()],
    inflightHands: () => [...engines.values()].filter((e) => /* mid-hand */ true).length,
  };
}
```

Then boot the control plane instead of the discovery-loop's direct
`new ServerTableEngine(...)`:

```ts
// single-node, multi-worker_threads — works today
const mgr = new InProcessShardManager({
  factory: new NodeWorkerFactory(new URL('./scaleWorkerHarness.js', import.meta.url)),
  hostModule: new URL('./engineTableHost.js', import.meta.url).href,
});
await mgr.start();
for (let i = 0; i < os.cpus().length - 1; i++) await mgr.spawnWorker();
// discovery loop calls mgr.assignTable(tableId) instead of newing an engine
```

Because `ServerTableEngine` is single-threaded and CPU-bound, splitting tables
across `worker_threads` is a real throughput win **on one box** with no infra.

> **Test-mode note:** the same control plane can run with `InlineWorkerFactory`
> (no threads) for deterministic tests and for the E2E single-table path.

---

## Path to multi-node (needs infra provisioning)

The seams are cut; going multi-node adds three things, **none requiring changes
above the transport line**:

1. **Ownership store** (which node/worker owns which table) — a shared KV so any
   gateway can resolve an owner. `TableRouter` already produces the mapping; the
   store just persists worker→node membership and survives restarts.
2. **`RemoteWorkerChannel`** — the same `WorkerChannel` interface, but messages
   travel over the bus/RPC instead of a `worker_threads` port. `MultiNodeShardManager
implements ShardManager` reuses all drain/health/routing logic unchanged (seam
   documented at the bottom of `ShardManager.ts`).
3. **`RedisCrossNodeBus` / `NatsCrossNodeBus`** — implement the `BusTransport`
   interface in `CrossNodeBus.ts`; drop self-echoes via `envelope.senderId`.

Node failure re-uses the drain step-4 code path: a surviving manager notices the
missing heartbeat and re-routes the dead node's tables (they resume from the
event log).

---

## Infra decisions the platform owner must make

These are **not** code decisions — they need your call and provisioning:

1. **Single-node-multi-worker now, or straight to multi-node?**
   - _Recommendation:_ ship **single-node + `worker_threads`** first (zero new
     infra, immediate multi-core throughput, and it already unlocks zero-downtime
     deploys via drain within the box). Go multi-node only when one box's cores
     are saturated.

2. **Redis vs NATS** for the bus + coordination:
   - **Redis** — you likely already run it; pub/sub + KV (ownership store) +
     `PSUBSCRIBE` patterns in one dependency. Simplest operationally. Pub/sub is
     fire-and-forget (fine for presence/lobby); use Streams if you need
     replay/at-least-once for tournament coordination.
   - **NATS** — purpose-built for this: subject wildcards, request-reply (great
     for the `RemoteWorkerChannel` RPC), JetStream for durability, lower latency
     at fan-out. More capable, one more system to run.
   - _Recommendation:_ **Redis** if it's already in the stack and scale is
     modest; **NATS** if you expect many nodes and want first-class RPC +
     durable coordination. Either satisfies `BusTransport` — decision is
     reversible.

3. **Hosting / topology** — current target is a Hetzner VPS (see
   `server/deploy-hetzner.sh`, `Dockerfile`, `railway.json`). For multi-node you
   need: a load balancer / gateway tier, a private network between nodes, and a
   managed or self-hosted Redis/NATS. The **WS gateway split** (stateless
   front, sticky-by-table routing to compute) is the main new infra component.

4. **Worker count & weights** — how many `worker_threads` per box (start:
   `cpus - 1`), and per-worker weights if boxes are heterogeneous
   (`TableRouter` supports weights today).

5. **Event-log store** — coordinate with the event-log module: the log backing
   store (Postgres/Supabase table vs Redis Streams vs object storage) determines
   `openTable` resume latency, which bounds how fast a drain/failover completes.

---

## Testing

```bash
cd server
npx vitest run src/scale
```

Covered: rendezvous distribution (±10% over 20k keys), weighting, minimal
reassignment on add/remove (and the "only moves onto the new worker" guarantee),
bus exact/pattern/fan-out/error-isolation/unsubscribe, and the full drain +
handoff flow, including stale generations/epochs, failed unassign, partial drain,
unhealthy-worker fencing, worker exit, and simulated rolling deploy behavior.
