/** Owner-authorized expansion of the private Lightning pilot roster, 2026-10-23.
 *
 * Dan, 2026-10-23 11:06 America/Chicago: "FINISH UP ANY AND ALL REMAINING WORK,
 * AND USE AS MANY FUNDED PILOT HORSES AS YOU NEED". The funded 72 fill both
 * six-seat pilots from the 05:00 UTC day rollover until early afternoon, then
 * daily caps empty them. This adds the exact 72 existing horses pinned in
 * docs/lightning/PILOT-ROSTER-EXPANSION-2026-10-23.json, each through the same
 * normal doors the 2026-10-19 roster used: the horse's own session joins
 * (fn_join_club_atomic), the club owner approves (fn_review_join_request) and
 * the owner funds 200.00 from the club bank to the player wallet
 * (fn_club_bank_send, one op id per horse). No raw membership or money write.
 *
 * Explicit prepare / first-execute only. Never resume or retry a financial
 * door: an unknown outcome stops the run and its journal is the record. The
 * workflow owns duplicate-execute admission (lightning-pilot-roster-run.mjs).
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { supabaseServerHeaders } from '../ci/supabase-auth-headers.mjs';
import { assertPilotClub, PILOT } from './prepare-lightning-private-pilot.mjs';
import { rosterCents, rosterFundingReadback } from './lightning-pilot-roster.mjs';
import { guardRosterRun } from './lightning-pilot-roster-run.mjs';

export const EXPANSION_OPERATION = 'lightning-pilot-roster-expansion-20261023';
export const EXPANSION_WORKFLOW = '.github/workflows/lightning-pilot-roster-expand.yml';
export const EXPANSION_TITLE = 'Lightning Roster Expansion';
export const EXPANSION_MANIFEST_SHA256 =
  'f1e1b8f58f60ed8e1ba1d4d6158c0849ef8467ce2522f75e906b47f5da2964bc';
const PRIOR_MANIFEST_SHA256 = '121f80d2529012e532b4d3a702e2772cde9aa7778a82df26f5a02082d2b0ba8a';
export const EXPANSION_CLUB = 'e14bc9f7-736d-425f-8f2c-e78305ebac1d';
export const EXPANSION_SIZE = 72;
export const FUND_CENTS = 20000;
const PUBLIC_KEY = 'sb_publishable__41LpJpzrfrb3hSUpEaYCA_tF53bBJx';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
class ExpansionFailure extends Error {}
const fail = (code) => {
  throw new ExpansionFailure(code);
};
const sha = (x) => createHash('sha256').update(x).digest('hex');
const hash = (x) => sha(JSON.stringify(x));

/** The exact pinned incoming horses and the exact original roster beside them. */
export function expansionScope() {
  const raw = readFileSync(
    new URL('../../docs/lightning/PILOT-ROSTER-EXPANSION-2026-10-23.json', import.meta.url)
  );
  const prior = readFileSync(
    new URL('../../docs/lightning/PILOT-ASSIGNMENT-MANIFEST-2026-10-17.json', import.meta.url)
  );
  if (sha(raw) !== EXPANSION_MANIFEST_SHA256 || sha(prior) !== PRIOR_MANIFEST_SHA256)
    fail('MANIFEST_BYTES_CHANGED');
  const scope = JSON.parse(raw);
  const original = JSON.parse(prior).participants;
  if (
    scope.operation !== EXPANSION_OPERATION ||
    scope.clubId !== EXPANSION_CLUB ||
    scope.perHorseFunding !== '200.00' ||
    rosterCents(scope.perHorseFunding) !== FUND_CENTS ||
    scope.destination !== 'player_wallet' ||
    !Array.isArray(scope.incoming) ||
    scope.incoming.length !== EXPANSION_SIZE ||
    new Set(scope.incoming).size !== EXPANSION_SIZE ||
    scope.incoming.some((id) => !UUID.test(id) || original.includes(id)) ||
    !isDeepStrictEqual(scope.incoming, [...scope.incoming].sort()) ||
    !Array.isArray(original) ||
    original.length !== 72
  )
    fail('MANIFEST_SCOPE_REFUSED');
  return { incoming: Object.freeze([...scope.incoming]), original: Object.freeze([...original]) };
}

export function expansionRequestId(kind, user) {
  const h = hash([EXPANSION_OPERATION, kind, user]);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
}
const requestManifest = (incoming) =>
  incoming.map((userId) => ({
    userId,
    joinRequestId: expansionRequestId('join', userId),
    fundRequestId: expansionRequestId('fund', userId),
  }));

const departed = (m) =>
  m.status === 'suspended' && m.membership_lifecycle_status === 'departed' && m.is_active === false;
const identity = (m) => ({
  user_id: m.user_id,
  role: m.role,
  status: m.status,
  joined_at: m.joined_at,
  created_at: m.created_at,
});

/** The live roster beside the expansion: owner + original 72 + only pinned
 * incoming rows. Departed historical rows are set aside exactly as the
 * assignment tooling does. Balances move with play and are not identity. */
export function checkedRoster(s, scope) {
  assertPilotClub(s.club);
  if (s.frozen !== false || s.admission?.allowed !== true)
    fail('FINANCIAL_OR_ADMISSION_GATE_CLOSED');
  if (s.club.id !== EXPANSION_CLUB || s.club.settlement_locked === true) fail('CLUB_SCOPE_CHANGED');
  if (!Array.isArray(s.members) || s.members.length > 1000) fail('ROSTER_UNREADABLE');
  const live = s.members.filter((m) => !departed(m));
  if (
    s.members.some(
      (m) =>
        departed(m) &&
        (m.user_id === PILOT.ownerId ||
          scope.original.includes(m.user_id) ||
          scope.incoming.includes(m.user_id))
    )
  )
    fail('PILOT_MEMBER_DEPARTED');
  const rows = live.map(identity).sort((a, b) => a.user_id.localeCompare(b.user_id));
  if (new Set(rows.map((r) => r.user_id)).size !== rows.length) fail('DUPLICATE_MEMBER');
  const owner = rows.find((r) => r.user_id === PILOT.ownerId);
  if (!owner || owner.role !== 'owner' || owner.status !== 'active') fail('OWNER_CHANGED');
  for (const id of scope.original)
    if (!rows.some((r) => r.user_id === id && r.role === 'player' && r.status === 'active'))
      fail('ORIGINAL_ROSTER_CHANGED');
  if (
    rows.some(
      (r) =>
        r.user_id !== PILOT.ownerId &&
        !scope.original.includes(r.user_id) &&
        !scope.incoming.includes(r.user_id)
    )
  )
    fail('UNEXPECTED_MEMBER');
  if (
    rows.some(
      (r) =>
        scope.incoming.includes(r.user_id) &&
        (r.role !== 'player' || !['active', 'pending'].includes(r.status))
    )
  )
    fail('INCOMING_ROLE_CHANGED');
  if (
    !Array.isArray(s.profiles) ||
    rows.some(
      (r) =>
        r.user_id !== PILOT.ownerId &&
        !s.profiles.some((p) => p.id === r.user_id && p.is_horse === true && p.status === 'active')
    )
  )
    fail('NON_HORSE_ROSTER');
  return { rows, treasury: rosterCents(s.club.chip_treasury) };
}

export async function prepareExpansion({
  adapter,
  sourceRunId,
  operationId,
  now = () => Date.now(),
}) {
  if (!UUID.test(operationId ?? '')) fail('OPERATION_ID_REQUIRED');
  if (!/^\d+$/.test(String(sourceRunId))) fail('PREPARE_RUN_ID_REQUIRED');
  const scope = expansionScope();
  const initial = checkedRoster(await adapter.snapshot(), scope);
  // A later operation completes an earlier stopped one. A pinned horse that
  // is already a member counts as done only when it is active and its one
  // durable 200.00 funding receipt (its deterministic fund op id) is proved;
  // it is never joined, approved or funded again. Anything else refuses.
  const joined = initial.rows.filter((r) => scope.incoming.includes(r.user_id));
  if (initial.rows.length !== 73 + joined.length) fail('EXACT_ORIGINAL_ROSTER_REQUIRED');
  const completed = [];
  for (const r of joined) {
    if (r.status !== 'active') fail('PARTIAL_MEMBER_NOT_ACTIVE');
    completed.push({
      userId: r.user_id,
      ...(await adapter.provenFunding(r.user_id, expansionRequestId('fund', r.user_id))),
    });
  }
  const remaining = scope.incoming.filter((id) => !joined.some((r) => r.user_id === id));
  if (remaining.length === 0) fail('NOTHING_REMAINING');
  const incomingEvidence = [];
  for (const id of remaining)
    incomingEvidence.push({
      userId: id,
      ...(await adapter.validateIncoming(id, { strict: true })),
    });
  if (initial.treasury < FUND_CENTS * remaining.length) fail('INSUFFICIENT_GROSS_TREASURY');
  const baseline = {
    version: 2,
    operation: EXPANSION_OPERATION,
    operationId,
    clubId: EXPANSION_CLUB,
    sourceRunId: String(sourceRunId),
    preparedAt: now(),
    manifestSha256: EXPANSION_MANIFEST_SHA256,
    incoming: scope.incoming,
    requests: requestManifest(scope.incoming),
    fundCentsEach: FUND_CENTS,
    completed,
    remaining,
    incomingEvidence,
    initial,
  };
  return { ...baseline, digest: hash(baseline) };
}

export async function executeExpansion({
  adapter,
  baseline,
  admission,
  persist,
  now = () => Date.now(),
  timeoutMs = 900000,
}) {
  if (typeof persist !== 'function') fail('DURABLE_RESULT_SINK_REQUIRED');
  const scope = expansionScope();
  const { digest, ...body } = baseline ?? {};
  if (
    digest !== hash(body) ||
    body.version !== 2 ||
    !Array.isArray(body.remaining) ||
    !Array.isArray(body.completed) ||
    body.remaining.length === 0 ||
    body.remaining.some((id) => !scope.incoming.includes(id)) ||
    !isDeepStrictEqual(
      [...body.remaining, ...body.completed.map((c) => c.userId)].sort(),
      scope.incoming
    ) ||
    body.initial?.rows?.length !== 73 + body.completed.length ||
    body.operation !== EXPANSION_OPERATION ||
    body.clubId !== EXPANSION_CLUB ||
    body.manifestSha256 !== EXPANSION_MANIFEST_SHA256 ||
    body.fundCentsEach !== FUND_CENTS ||
    !isDeepStrictEqual(body.incoming, scope.incoming) ||
    !isDeepStrictEqual(body.requests, requestManifest(scope.incoming)) ||
    !UUID.test(body.operationId ?? '')
  )
    fail('INVALID_BASELINE');
  if (
    admission?.firstInvocation !== true ||
    admission?.prepareRunId !== body.sourceRunId ||
    !/^\d+$/.test(String(admission?.executeRunId)) ||
    admission.executeRunId === body.sourceRunId
  )
    fail('FIRST_EXECUTION_ADMISSION_REQUIRED');
  if (now() - body.preparedAt < 0 || now() - body.preparedAt > 1800000) fail('BASELINE_EXPIRED');
  const deadline = now() + Math.min(timeoutMs, 900000);
  const report = {
    operation: EXPANSION_OPERATION,
    operationId: body.operationId,
    baselineDigest: digest,
    prepareRunId: body.sourceRunId,
    executeRunId: String(admission.executeRunId),
    status: 'started',
    steps: [],
    added: 0,
    grossFundingCents: 0,
  };
  // Identity only; balances move with live play in the original roster.
  const expected = new Map(body.initial.rows.map((r) => [r.user_id, r]));
  const save = () => persist(structuredClone(report));
  const checkTime = () => {
    if (now() >= deadline) fail('DEADLINE');
  };
  const read = async () => {
    checkTime();
    const { rows } = checkedRoster(await adapter.snapshot(), scope);
    if (
      !isDeepStrictEqual(
        rows,
        [...expected.values()].sort((a, b) => a.user_id.localeCompare(b.user_id))
      )
    )
      fail('BASELINE_OR_READBACK_CHANGED');
  };
  async function door(kind, id, call, update) {
    checkTime();
    const step = { kind, userId: id, status: 'intent', requestId: expansionRequestId(kind, id) };
    report.steps.push(step);
    await save();
    let response;
    try {
      response = await call(step.requestId);
    } catch (error) {
      step.status = 'unknown';
      step.error = error instanceof ExpansionFailure ? error.message : 'THROWN_BEFORE_RECEIPT';
      fail('DOOR_OUTCOME_UNKNOWN');
    }
    if (response?.success !== true) {
      step.status = 'refused';
      fail('DOOR_REFUSED');
    }
    step.status = 'acknowledged';
    await save();
    await update(response, step);
    step.status = 'verified';
    await save();
  }
  try {
    await save();
    await read();
    // Every pinned horse is re-proved before the first write: identity,
    // horse status, membership cap and not already a pilot member.
    for (const id of body.remaining) await adapter.validateIncoming(id, { strict: false });
    for (const id of body.remaining) {
      await door(
        'join',
        id,
        (requestId) => adapter.join(id, requestId),
        (r) => {
          const m = r.membership ?? {};
          if (
            r.status !== 'pending' ||
            m.user_id !== id ||
            m.role !== 'player' ||
            m.status !== 'pending' ||
            rosterCents(m.chip_balance) !== 0 ||
            !m.joined_at ||
            !m.created_at
          )
            fail('JOIN_SCOPE_CHANGED');
          expected.set(id, identity(m));
        }
      );
      await door(
        'approve',
        id,
        () => adapter.approve(id),
        async () => {
          expected.get(id).status = 'active';
          await read();
        }
      );
      await door(
        'fund',
        id,
        (requestId) => adapter.fund(id, requestId),
        async (r, step) => {
          const atomic = rosterFundingReadback(r);
          if (report.grossFundingCents + FUND_CENTS > FUND_CENTS * body.remaining.length)
            fail('FUND_RECEIPT_INVALID');
          const proof = await adapter.verifyFunding(id, expansionRequestId('fund', id), r);
          if (!isDeepStrictEqual(proof, atomic)) fail('DURABLE_FUNDING_UNVERIFIED');
          report.grossFundingCents += FUND_CENTS;
          report.added += 1;
          Object.assign(step, proof);
        }
      );
    }
    await read();
    if (
      report.added !== body.remaining.length ||
      report.grossFundingCents !== FUND_CENTS * body.remaining.length ||
      expected.size !== 73 + EXPANSION_SIZE
    )
      fail('FINAL_ROSTER_INCOMPLETE');
    report.status = 'verified';
    report.rosterAfter = expected.size;
  } catch (error) {
    report.status = 'stopped';
    report.cause = ['DOOR_OUTCOME_UNKNOWN', 'DOOR_REFUSED', 'DEADLINE'].includes(error.message)
      ? error.message
      : 'READBACK_OR_SCOPE_UNVERIFIED';
    report.diagnostic = error instanceof ExpansionFailure ? error.message : 'UNEXPECTED_FAILURE';
  }
  await save();
  return report;
}

const readFailure = (r, context) => {
  const code = /^(?:[0-9A-Z]{5}|PGRST[0-9]{3})$/.test(r?.error?.code ?? '')
    ? r.error.code
    : 'UNKNOWN';
  fail(`${context}_UNAVAILABLE_${code}`);
};
const data = (r, context = 'READ') => {
  if (r?.error || r?.data == null) readFailure(r, context);
  return r.data;
};

/** Real normal authenticated doors; admin is SELECT/auth only, never a money RPC. */
export function createExpansionAdapter({ admin, owner, createClient, url, timeoutMs = 15000 }) {
  const scope = expansionScope();
  const authOptions = {
    auth: { persistSession: false, autoRefreshToken: false },
    global: {
      fetch: (input, init = {}) =>
        fetch(input, { ...init, signal: AbortSignal.timeout(timeoutMs) }),
    },
  };
  async function assertOwner() {
    if (data(await owner.auth.getUser()).user?.id !== PILOT.ownerId) fail('OWNER_AUTH_MISMATCH');
  }
  const count = async (table, apply) => {
    const r = await apply(admin.from(table).select('*', { count: 'exact', head: true }));
    if (r.error || !Number.isSafeInteger(r.count)) readFailure(r, `COUNT_${table.toUpperCase()}`);
    return r.count;
  };
  async function validateIncoming(id) {
    if (!scope.incoming.includes(id)) fail('UNPINNED_HORSE');
    const p = data(
      await admin
        .from('profiles')
        .select('id,is_horse,status,horse_profile')
        .eq('id', id)
        .maybeSingle(),
      'INCOMING_PROFILE'
    );
    const u = data(await admin.auth.admin.getUserById(id), 'INCOMING_AUTH').user;
    const [cap, membershipCount, memberRead] = await Promise.all([
      admin.rpc('fn_club_membership_cap'),
      admin.rpc('fn_club_membership_count', { p_user_id: id, p_excluding_club: EXPANSION_CLUB }),
      admin
        .from('club_members')
        .select('user_id')
        .eq('club_id', EXPANSION_CLUB)
        .eq('user_id', id)
        .maybeSingle(),
    ]);
    if (
      !Number.isSafeInteger(data(cap, 'MEMBERSHIP_CAP')) ||
      !Number.isSafeInteger(data(membershipCount, 'MEMBERSHIP_COUNT')) ||
      data(membershipCount, 'MEMBERSHIP_COUNT') >= data(cap, 'MEMBERSHIP_CAP')
    )
      fail('HORSE_MEMBERSHIP_CAP_REACHED');
    if (
      p.id !== id ||
      p.is_horse !== true ||
      p.status !== 'active' ||
      !['cash', 'both'].includes(p.horse_profile?.lane) ||
      u?.id !== id ||
      typeof u.email !== 'string' ||
      !u.email.trim() ||
      (u.banned_until &&
        (!Number.isFinite(Date.parse(u.banned_until)) || Date.parse(u.banned_until) > Date.now()))
    )
      fail('HORSE_IDENTITY_CHANGED');
    if (memberRead.error) readFailure(memberRead, 'INCOMING_MEMBERSHIP');
    if (memberRead.data !== null) fail('INCOMING_ALREADY_PILOT_MEMBER');
    const [seats, openCashSessions, bookings] = await Promise.all([
      count('table_seats', (q) => q.eq('user_id', id).is('left_at', null)),
      count('cash_player_session', (q) => q.eq('player_id', id).is('closed_at', null)),
      admin
        .from('tournament_players')
        .select('tournament_id,status')
        .eq('user_id', id)
        .in('status', ['registered', 'playing'])
        .limit(100),
    ]);
    const booked = data(bookings, 'INCOMING_BOOKINGS');
    if (!Array.isArray(booked) || booked.length >= 100) fail('INCOMING_BOOKINGS_UNREADABLE');
    let liveBookings = 0,
      playing = 0;
    if (booked.length) {
      const events = data(
        await admin
          .from('tournaments')
          .select('id,status')
          .in('id', [...new Set(booked.map((b) => b.tournament_id))]),
        'INCOMING_EVENTS'
      );
      liveBookings = booked.filter((b) => {
        const t = events.find((e) => e.id === b.tournament_id);
        return !t || !['COMPLETED', 'CANCELLED'].includes(String(t.status).toUpperCase());
      }).length;
      playing = booked.filter((b) => b.status === 'playing').length;
    }
    // Selection (2026-10-23 17:05 UTC, docs/lightning/PILOT-ROSTER-EXPANSION-
    // 2026-10-23.json) took only horses seated in no running tournament. The
    // house freerolls register cash-lane horses too (Midday Free Buy, 17:30
    // UTC, seated 156 of them), so a later seat is recorded, never refused:
    // joining and funding touch no seat or entry, and the standing assignment
    // lets every running game and existing entry finish normally, exactly as
    // for the original 72. It only stops new automated entries.
    return { seats, openCashSessions, liveBookings, playing };
  }
  return {
    validateIncoming,
    async snapshot() {
      const [club, members] = await Promise.all([
        admin
          .from('clubs')
          .select(
            'id,owner_id,name,is_public,requires_approval,union_id,chip_treasury,settlement_locked'
          )
          .eq('id', EXPANSION_CLUB)
          .maybeSingle(),
        admin
          .from('club_members')
          .select('user_id,role,status,joined_at,created_at,membership_lifecycle_status,is_active')
          .eq('club_id', EXPANSION_CLUB)
          .limit(1001),
      ]);
      const memberRows = data(members, 'MEMBERS');
      const ids = memberRows.filter((m) => !departed(m)).map((m) => m.user_id);
      const profiles = data(
        await admin.from('profiles').select('id,is_horse,status').in('id', ids).limit(1001),
        'ROSTER_PROFILES'
      );
      const [freeze, admissionRead] = await Promise.all([
        admin.rpc('fn_platform_frozen'),
        admin.rpc('fn_ca_commerce_admission', {
          p_scope_kind: 'club',
          p_scope_id: EXPANSION_CLUB,
          p_action: 'approve_member',
        }),
      ]);
      return {
        club: data(club, 'CLUB'),
        members: memberRows,
        profiles,
        frozen: data(freeze, 'FREEZE'),
        admission: data(admissionRead, 'ADMISSION'),
      };
    },
    async join(id, requestId) {
      await validateIncoming(id, { strict: false });
      const u = data(await admin.auth.admin.getUserById(id), 'INCOMING_AUTH').user;
      const link = data(await admin.auth.admin.generateLink({ type: 'magiclink', email: u.email }));
      if (link.user?.id !== id || typeof link.properties?.hashed_token !== 'string')
        fail('LINK_IDENTITY_MISMATCH');
      const client = createClient(url, PUBLIC_KEY, authOptions);
      try {
        const login = data(
          await client.auth.verifyOtp({ token_hash: link.properties.hashed_token, type: 'email' })
        );
        if (
          login.user?.id !== id ||
          login.session?.user?.id !== id ||
          data(await client.auth.getUser()).user?.id !== id
        )
          fail('HORSE_SESSION_MISMATCH');
        const joined = data(
          await client.rpc('fn_join_club_atomic', {
            p_identifier: EXPANSION_CLUB,
            p_request_id: requestId,
            p_referral_code: null,
          })
        );
        if (joined.success !== true) return joined;
        if (
          joined.club?.id !== EXPANSION_CLUB ||
          joined.status !== 'pending' ||
          joined.membership?.user_id !== id ||
          joined.membership?.club_id !== EXPANSION_CLUB
        )
          fail('JOIN_RECEIPT_SCOPE_MISMATCH');
        const persisted = data(
          await admin
            .from('club_members')
            .select('club_id,user_id,role,status,joined_at,created_at,chip_balance::text')
            .eq('club_id', EXPANSION_CLUB)
            .eq('user_id', id)
            .maybeSingle()
        );
        if (
          persisted.club_id !== EXPANSION_CLUB ||
          persisted.user_id !== id ||
          !isDeepStrictEqual(identity(persisted), identity(joined.membership))
        )
          fail('JOIN_READBACK_SCOPE_MISMATCH');
        return { ...joined, membership: persisted };
      } finally {
        const out = await client.auth.signOut({ scope: 'local' });
        if (out?.error) fail('HORSE_SESSION_CLEANUP_UNKNOWN');
      }
    },
    async approve(id) {
      await assertOwner();
      return data(
        await owner.rpc('fn_review_join_request', {
          p_club_id: EXPANSION_CLUB,
          p_user_id: id,
          p_approve: true,
        })
      );
    },
    async fund(id, op) {
      await assertOwner();
      return data(
        await owner.rpc('fn_club_bank_send', {
          p_club_id: EXPANSION_CLUB,
          p_to_user_id: id,
          p_amount: FUND_CENTS / 100,
          p_destination: 'player_wallet',
          p_reason: EXPANSION_OPERATION,
          p_op_id: op,
        })
      );
    },
    /** The one durable receipt of an earlier completed funding, read only. */
    async provenFunding(id, op) {
      const tx = data(
        await admin
          .from('chip_transactions')
          .select('id,from_user_id,to_user_id,amount::text,metadata')
          .eq('club_id', EXPANSION_CLUB)
          .eq('transaction_type', 'club_bank_send')
          .eq('metadata->>op_id', op)
      );
      const intent = data(
        await admin
          .from('cashier_rpc_operation_intents')
          .select('actor_user_id,action,club_id,receipt,completed_at')
          .eq('operation_id', op)
          .maybeSingle()
      );
      if (
        tx.length !== 1 ||
        tx[0].from_user_id !== PILOT.ownerId ||
        tx[0].to_user_id !== id ||
        rosterCents(tx[0].amount) !== FUND_CENTS ||
        tx[0].metadata?.destination !== 'player_wallet' ||
        intent.actor_user_id !== PILOT.ownerId ||
        intent.action !== 'club_bank_send' ||
        intent.club_id !== EXPANSION_CLUB ||
        !intent.completed_at ||
        intent.receipt?.success !== true ||
        intent.receipt?.transaction_id !== tx[0].id
      )
        fail('EARLIER_FUNDING_UNPROVED');
      return { transactionId: tx[0].id };
    },
    async verifyFunding(id, op, response) {
      const intent = data(
        await admin
          .from('cashier_rpc_operation_intents')
          .select('actor_user_id,action,club_id,operation_intent,receipt,completed_at')
          .eq('operation_id', op)
          .maybeSingle()
      );
      const tx = data(
        await admin
          .from('chip_transactions')
          .select('id,from_user_id,to_user_id,amount::text,metadata,balance_after::text')
          .eq('club_id', EXPANSION_CLUB)
          .eq('transaction_type', 'club_bank_send')
          .eq('metadata->>op_id', op)
      );
      if (
        !isDeepStrictEqual(intent.operation_intent, {
          actor: PILOT.ownerId,
          club: EXPANSION_CLUB,
          action: 'club_bank_send',
          target: id,
          amount: FUND_CENTS / 100,
          effective_wallet: 'player_wallet',
          reason: EXPANSION_OPERATION,
        }) ||
        intent.actor_user_id !== PILOT.ownerId ||
        intent.action !== 'club_bank_send' ||
        intent.club_id !== EXPANSION_CLUB ||
        !intent.completed_at ||
        intent.receipt?.success !== true ||
        tx.length !== 1 ||
        tx[0].id !== intent.receipt.transaction_id ||
        tx[0].from_user_id !== PILOT.ownerId ||
        tx[0].to_user_id !== id ||
        rosterCents(tx[0].amount) !== FUND_CENTS ||
        tx[0].metadata?.destination !== 'player_wallet' ||
        tx[0].metadata?.op_id !== op ||
        rosterCents(tx[0].balance_after) !== rosterCents(response.bank_after)
      )
        fail('DURABLE_FUNDING_UNVERIFIED');
      const proof = rosterFundingReadback(response);
      if (!isDeepStrictEqual(rosterFundingReadback(intent.receipt), proof))
        fail('DURABLE_FUNDING_UNVERIFIED');
      return proof;
    },
  };
}

export async function expansionMain(env = process.env, clientFactory) {
  const reportPath = env.PILOT_EXPANSION_REPORT_PATH ?? 'lightning-roster-expansion-report.json';
  const baselinePath =
    env.PILOT_EXPANSION_BASELINE_PATH ?? 'lightning-roster-expansion-baseline.json';
  const persist = (r) => writeFileSync(reportPath, JSON.stringify(r, null, 2));
  let owner;
  let result;
  let cleanup = 'not_opened';
  let phase = 'input';
  try {
    if (
      !['prepare', 'execute'].includes(env.PILOT_EXPANSION_PHASE) ||
      !UUID.test(env.PILOT_EXPANSION_OPERATION_ID ?? '')
    )
      fail('INVALID_MANUAL_INPUT');
    if (
      env.SP_EMAIL?.toLowerCase() !== PILOT.ownerEmail ||
      !env.SP_PASS ||
      !env.SUPABASE_URL ||
      !env.SUPABASE_SERVICE_ROLE_KEY
    )
      fail('CONFIGURED_AUTH_REQUIRED');
    phase = 'authentication';
    const createClient = clientFactory ?? (await import('@supabase/supabase-js')).createClient;
    const end = Date.now() + 1200000;
    const boundedFetch =
      (key) =>
      (input, init = {}) =>
        fetch(input, {
          ...init,
          headers: key
            ? supabaseServerHeaders(key, Object.fromEntries(new Headers(init.headers)))
            : init.headers,
          signal: AbortSignal.timeout(Math.max(1, Math.min(15000, end - Date.now()))),
        });
    const options = {
      auth: { persistSession: false, autoRefreshToken: false },
      global: { fetch: boundedFetch() },
    };
    const admin = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
      ...options,
      global: { fetch: boundedFetch(env.SUPABASE_SERVICE_ROLE_KEY) },
    });
    owner = createClient(env.SUPABASE_URL, PUBLIC_KEY, options);
    cleanup = 'unknown';
    const login = data(
      await owner.auth.signInWithPassword({ email: env.SP_EMAIL, password: env.SP_PASS }),
      'OWNER_LOGIN'
    );
    if (
      login.user?.id !== PILOT.ownerId ||
      login.session?.user?.id !== PILOT.ownerId ||
      data(await owner.auth.getUser(), 'OWNER_SESSION').user?.id !== PILOT.ownerId
    )
      fail('OWNER_AUTH_MISMATCH');
    const adapter = createExpansionAdapter({ admin, owner, createClient, url: env.SUPABASE_URL });
    phase = env.PILOT_EXPANSION_PHASE;
    if (phase === 'prepare') {
      const baseline = await prepareExpansion({
        adapter,
        sourceRunId: env.GITHUB_RUN_ID,
        operationId: env.PILOT_EXPANSION_OPERATION_ID,
      });
      writeFileSync(baselinePath, JSON.stringify(baseline, null, 2));
      result = {
        status: 'prepared',
        operation: EXPANSION_OPERATION,
        operationId: baseline.operationId,
        baselineDigest: baseline.digest,
        sourceRunId: baseline.sourceRunId,
        incoming: baseline.incoming.length,
        noRosterOrMoneyWrites: true,
      };
    } else {
      const baseline = JSON.parse(readFileSync(baselinePath, 'utf8'));
      if (baseline.operationId !== env.PILOT_EXPANSION_OPERATION_ID)
        fail('BASELINE_OPERATION_MISMATCH');
      result = await executeExpansion({
        adapter,
        baseline,
        persist,
        admission: {
          firstInvocation:
            env.PILOT_EXPANSION_EXECUTE_ADMITTED === 'true' && env.GITHUB_RUN_ATTEMPT === '1',
          prepareRunId: env.PILOT_EXPANSION_PREPARE_RUN_ID,
          executeRunId: env.GITHUB_RUN_ID,
        },
      });
    }
  } catch (error) {
    result = {
      ...result,
      status: 'stopped',
      cause: 'INPUT_AUTH_OR_EXECUTION_UNVERIFIED',
      phase,
      diagnostic: error instanceof ExpansionFailure ? error.message : 'UNEXPECTED_FAILURE',
    };
  } finally {
    if (owner)
      try {
        const r = await owner.auth.signOut({ scope: 'local' });
        cleanup = r?.error ? 'unknown' : 'local_session_closed';
      } catch {
        cleanup = 'unknown';
      }
  }
  if (!result?.steps)
    try {
      const previous = JSON.parse(readFileSync(reportPath, 'utf8'));
      if (previous.operation === EXPANSION_OPERATION && previous.executeRunId === env.GITHUB_RUN_ID)
        result = { ...previous, ...result };
    } catch {}
  result = { ...result, cleanup };
  if (cleanup !== 'local_session_closed') result.status = 'stopped';
  persist(result);
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv[2] === '--guard')
    guardRosterRun(
      {
        ...process.env,
        PILOT_ROSTER_PHASE: process.env.PILOT_EXPANSION_PHASE,
        PILOT_ROSTER_OPERATION_ID: process.env.PILOT_EXPANSION_OPERATION_ID,
        PILOT_ROSTER_PREPARE_RUN: process.env.PILOT_EXPANSION_PREPARE_RUN,
      },
      fetch,
      { workflow: EXPANSION_WORKFLOW, title: EXPANSION_TITLE }
    ).then(
      () => console.log('Expansion Provider Ownership Verified'),
      () => {
        console.error('Expansion Provider Ownership Refused');
        process.exitCode = 1;
      }
    );
  else
    expansionMain()
      .then((r) => {
        const { steps, ...summary } = r;
        console.log(JSON.stringify({ ...summary, steps: steps?.length }));
        if (!['prepared', 'verified'].includes(r.status)) process.exitCode = 1;
      })
      .catch(() => {
        console.error('EXPANSION_RESULT_UNAVAILABLE');
        process.exitCode = 1;
      });
}
