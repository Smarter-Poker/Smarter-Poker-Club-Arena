// One probe engine: the LOCALLY BUILT engine's own ownership code (server/dist
// leadership.js, tableLease.js, tournamentLease.js) driving a fleet the way
// GameServer does, against the isolated database behind its own RPC shim.
//
//   boot          renewLeadership(); a standby retries for one staleness window
//                 plus 15 s, exactly as GameServer.start() does, then stays a
//                 standby that claims nothing (mode "leader"). Mode "contend"
//                 skips leadership: the worst case, two leaders at once.
//   discovery     every 5 s (TABLE_DISCOVERY_INTERVAL) claim, with a fresh
//                 generation, every table and tournament it has no authority for.
//   renewal       every 5 s (OWNERSHIP_LEASE_RENEWAL_CADENCE_MS) heartbeat every
//                 held generation; a proof extends authority, a loss ends it.
//   authority     ends at the proof deadline the engine code returned (the
//                 dealer's expiry timer), on a heartbeat loss, or on a refused
//                 commit - exactly the three ways a ServerTableEngine stops.
//   dealing       while authority is current, one hand at a time per table,
//                 committed through the exact-lease settlement door with this
//                 instance id and the table's (or its tournament's) generation.
//   SIGUSR1       park: start no new hand, finish the ones in flight (the break).
//   SIGTERM       GameServer.stop(): stop dealing, release tables, then
//                 tournaments, then (only if both confirmed) leadership; exit 0.
//   lost/promoted leadership  the authoritative shutdown, then exit 75 so the
//                 supervisor restarts it, as Docker does in production.
import { performance } from 'node:perf_hooks';
import { randomUUID } from 'node:crypto';

const shim = process.env.SUPABASE_URL ?? '';
if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(shim)) {
  console.error('REFUSED: SUPABASE_URL must be the loopback probe shim, never a real project');
  process.exit(2);
}
for (const key of ['ENGINE_PG_LISTEN_URL', 'ENGINE_PG_LISTEN_CA_FILE', 'ALERT_WEBHOOK_URL', 'ALERT_WEBHOOK_SECRET']) {
  delete process.env[key];
}
process.env.SUPABASE_SERVICE_ROLE_KEY = 'isolated-probe-placeholder-not-a-credential';
const dist = process.env.ENGINE_DIST;
const name = process.env.PROBE_NAME;
const mode = process.env.PROBE_MODE;
const fleet = JSON.parse(process.env.PROBE_FLEET);
const DISCOVERY_MS = 5000;
const RENEWAL_MS = 5000;
const DEAL_TICK_MS = 250;

const tl = await import(`${dist}/services/tableLease.js`);
const tn = await import(`${dist}/services/tournamentLease.js`);
const ld = await import(`${dist}/services/leadership.js`);
const { supabase } = await import(`${dist}/services/supabase/client.js`);
const instance = tl.INSTANCE_ID;

const out = (ev, fields = {}) =>
  process.stdout.write(JSON.stringify({ t: Date.now(), engine: name, instance, ev, ...fields }) + '\n');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const wallOf = (mono) => Math.round(Date.now() + (mono - performance.now()));

// scope 'table' authorities are keyed by table id, 'tournament' by tournament id.
const authority = new Map();
const key = (scope, id) => `${scope}:${id}`;
let parked = false;
let stopping = false;
const inFlight = new Set();

function current(a) {
  return a && !a.ended && performance.now() < a.deadlineMono;
}
function endAuthority(scope, id, a, reason) {
  if (!a || a.ended) return;
  a.ended = true;
  clearTimeout(a.timer);
  out('authority_end', { scope, id, gen: a.gen, reason, endWall: Date.now() });
}
function arm(scope, id, a) {
  clearTimeout(a.timer);
  a.timer = setTimeout(() => {
    if (performance.now() >= a.deadlineMono) endAuthority(scope, id, a, 'proof_expired');
    else arm(scope, id, a);
  }, Math.max(0, Math.ceil(a.deadlineMono - performance.now())));
}

async function claim(scope, id) {
  const gen = randomUUID();
  const r =
    scope === 'table' ? await tl.claimTableLease(id, gen) : await tn.claimTournamentLease(id, gen);
  if (r.status === 'granted') {
    const a = { gen: r.leaseGeneration, deadlineMono: r.proofDeadlineMonotonicMs, ended: false };
    authority.set(key(scope, id), a);
    arm(scope, id, a);
    out('authority_start', { scope, id, gen: a.gen, startWall: Date.now(), deadlineWall: wallOf(a.deadlineMono) });
  } else if (r.status === 'acquired_but_proof_expired') {
    // GameServer exact-releases a grant that outran its proof before re-trying.
    out('claim_outran_proof', { scope, id, gen: r.leaseGeneration });
    if (scope === 'table') await tl.releaseTables([{ tableId: id, leaseGeneration: r.leaseGeneration }]);
    else await tn.releaseTournaments([{ tournamentId: id, leaseGeneration: r.leaseGeneration }]);
  } else {
    out('claim_refused', { scope, id, status: r.status, holder: r.conflict?.holder ?? null, reason: r.reason ?? null });
  }
}

async function discovery() {
  while (!stopping) {
    if (!parked) {
      const work = [];
      for (const t of fleet.tables) {
        if (t.tournamentId) continue;
        if (!current(authority.get(key('table', t.id)))) work.push(claim('table', t.id));
      }
      for (const t of fleet.tournaments) {
        if (!current(authority.get(key('tournament', t.id)))) work.push(claim('tournament', t.id));
      }
      await Promise.allSettled(work);
    }
    await sleep(DISCOVERY_MS);
  }
}

async function renewal() {
  while (!stopping) {
    const started = performance.now();
    const tables = [];
    const tournaments = [];
    for (const [k, a] of authority) {
      if (!current(a)) continue;
      const [scope, id] = k.split(':');
      if (scope === 'table') tables.push({ tableId: id, leaseGeneration: a.gen });
      else tournaments.push({ tournamentId: id, leaseGeneration: a.gen });
    }
    const [tr, nr] = await Promise.all([tl.heartbeatTables(tables), tn.heartbeatTournaments(tournaments)]);
    apply('table', tr, (p) => p.tableId, tr.lostTableIds);
    apply('tournament', nr, (p) => p.tournamentId, nr.lostTournamentIds);
    await sleep(Math.max(0, RENEWAL_MS - (performance.now() - started)));
  }
}
function apply(scope, outcome, idOf, lost) {
  if (outcome.status !== 'answered') {
    out('renewal_unknown', { scope, reason: outcome.reason });
    return;
  }
  for (const proof of outcome.proofs) {
    const a = authority.get(key(scope, idOf(proof)));
    if (!current(a) || a.gen !== proof.leaseGeneration.toLowerCase()) continue;
    a.deadlineMono = Math.max(a.deadlineMono, proof.proofDeadlineMonotonicMs);
    arm(scope, idOf(proof), a);
    out('authority_extend', { scope, id: idOf(proof), gen: a.gen, deadlineWall: wallOf(a.deadlineMono) });
  }
  for (const id of lost ?? []) endAuthority(scope, id, authority.get(key(scope, id)), 'heartbeat_lost');
}

async function dealOne(table, scope, subject, a) {
  // A dealer resumes its hand counter from the database when it takes a table.
  a.nextHand ??= {};
  if (a.nextHand[table.id] === undefined) {
    const { data, error } = await supabase.rpc('isolated_last_hand', { p_table_id: table.id });
    if (error || typeof data !== 'number') return;
    a.nextHand[table.id] = data + 1;
  }
  if (!current(a) || parked || stopping) return;
  const hand = a.nextHand[table.id];
  const startWall = Date.now();
  out('commit_start', { scope, subject, table: table.id, hand, gen: a.gen, startWall });
  const { data, error } = await supabase.rpc('isolated_commit_hand', {
    p_table_id: table.id,
    p_hand_number: hand,
    p_instance_id: instance,
    p_lease_generation: a.gen,
  });
  const accepted = !error && data?.success === true;
  out('commit_result', { scope, subject, table: table.id, hand, gen: a.gen, startWall, endWall: Date.now(),
                         accepted, reason: error ? `transport:${error.message}` : data?.reason ?? null });
  if (accepted) a.nextHand[table.id] = hand + 1;
  else if (!error && ['hand_lease_lost', 'hand_lease_stale'].includes(data?.reason)) {
    endAuthority(scope, subject, a, `commit_${data.reason}`);
  }
}

async function dealing() {
  while (!stopping) {
    if (!parked) {
      for (const table of fleet.tables) {
        const scope = table.tournamentId ? 'tournament' : 'table';
        const subject = table.tournamentId ?? table.id;
        const a = authority.get(key(scope, subject));
        if (!current(a) || inFlight.has(table.id)) continue;
        inFlight.add(table.id);
        dealOne(table, scope, subject, a)
          .catch((e) => out('commit_threw', { table: table.id, error: String(e) }))
          .finally(() => inFlight.delete(table.id));
      }
    }
    await sleep(DEAL_TICK_MS);
  }
}

async function drainHands(limitMs) {
  const until = performance.now() + limitMs;
  while (inFlight.size > 0 && performance.now() < until) await sleep(50);
  return inFlight.size;
}

async function gracefulStop(reason) {
  if (stopping) return;
  stopping = true;
  const left = await drainHands(5000);
  const tables = [];
  const tournaments = [];
  for (const [k, a] of authority) {
    const [scope, id] = k.split(':');
    endAuthority(scope, id, a, `shutdown:${reason}`);
    if (scope === 'table') tables.push({ tableId: id, leaseGeneration: a.gen });
    else tournaments.push({ tournamentId: id, leaseGeneration: a.gen });
  }
  const tr = await tl.releaseTables(tables);
  const nr = await tn.releaseTournaments(tournaments);
  let leadership = 'retained';
  if (tr.status === 'confirmed' && nr.status === 'confirmed') {
    await ld.releaseLeadership();
    leadership = 'released';
  }
  out('stopped', { reason, handsInFlightAtRelease: left, tables: tr, tournaments: nr, leadership });
}

process.on('SIGUSR1', async () => {
  parked = true;
  const left = await drainHands(10000);
  out('parked', { handsInFlight: left });
});
process.on('SIGTERM', async () => {
  await gracefulStop('SIGTERM');
  process.exit(0);
});

ld.registerLeadershipShutdownHandler(async (reason) => {
  out('leadership_shutdown', { reason });
  await gracefulStop(`leadership: ${reason}`);
  process.exit(75);
});

out('boot', { mode, shim, version: tl.INSTANCE_VERSION, proofWindowMs: tl.TABLE_LEASE_PROOF_WINDOW_MS,
              staleSeconds: tl.LEASE_STALE_SECONDS });
if (mode === 'leader') {
  let role = await ld.renewLeadership();
  if (role === 'standby') {
    const deadline = Date.now() + (ld.LEADERSHIP_STALE_SECONDS + 15) * 1000;
    while (role === 'standby' && Date.now() < deadline && !stopping) {
      await sleep(5000);
      role = await ld.renewLeadership();
    }
  }
  ld.startLeadershipRenewal();
  out('role', { role, leadership: ld.leadershipDiagnostics() });
  if (role === 'standby') {
    ld.markBootedAsStandby();
    // A standby claims nothing, cleans nothing, deals nothing.
    setInterval(() => out('standby_alive', { leadership: ld.leadershipDiagnostics() }), 10000);
  } else {
    discovery();
    renewal();
    dealing();
  }
} else if (mode === 'contend') {
  out('role', { role: 'contender (leadership bypassed)' });
  discovery();
  renewal();
  dealing();
} else {
  console.error(`unknown PROBE_MODE ${mode}`);
  process.exit(2);
}
