/** Explicit prepare/first-execute only. Never resume or retry a financial door.
 * Baseline must have been retained by a successful separate prepare workflow.
 * Workflow owns duplicate-execute admission and artifact provenance, not this process.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { supabaseServerHeaders } from '../ci/supabase-auth-headers.mjs';
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { assertCurrentPilotTarget } from './lightning-pilot-targets.mjs';
import { assertPilotClub, PILOT } from './prepare-lightning-private-pilot.mjs';
export const ROSTER_CLUB = 'e14bc9f7-736d-425f-8f2c-e78305ebac1d';
export const ROSTER_OPERATION = 'lightning-action-latency-roster-20261019';
export const ROSTER_MANIFEST_SHA256 =
  'abc1de189b40d5b7b5ce4e053b331ef74047a5368bc5732d63ac222b58a2557b';
export const ROSTER_PAIRS = Object.freeze(
  [
    {
      outgoing: '03951af5-7cf1-4164-aaf0-571b647d98d5',
      incoming: '00bc0957-1913-4beb-a4d1-acab94950690',
    },
    {
      outgoing: '07534039-d056-45bb-adcd-1415ed6a8a08',
      incoming: '36786473-723c-4104-b39d-eec5bbdeb763',
    },
    {
      outgoing: '0860d731-0d86-409a-8384-41a17b99a1f4',
      incoming: '3f26288c-4923-447a-9f0d-d5d208ab8f8d',
    },
    {
      outgoing: '09faf9f3-ed77-4582-9242-c464cb88fa93',
      incoming: '46394a29-9ca4-4280-952e-e201f4ff9517',
    },
    {
      outgoing: '0a9625c9-f679-4d98-9ebe-d8bb005c45b6',
      incoming: '775f4778-ceda-44bb-a26b-7c4194c8c0c1',
    },
    {
      outgoing: '0b1a64c2-8970-4f89-a396-9863e3aa2ccc',
      incoming: '8384a11c-8930-4b0d-a1c9-748f03569a78',
    },
    {
      outgoing: '10d08b4f-f6da-41ea-a66c-e97a0d4930e0',
      incoming: '852b2be0-4983-4507-a687-fc12f241960d',
    },
    {
      outgoing: '171038e5-f50e-4bdd-988f-621a7ce9479c',
      incoming: '9eb2a231-a42f-4162-8818-3f14ebc19385',
    },
    {
      outgoing: '19de9af5-6576-4ebb-92c6-1fe53599f782',
      incoming: 'a45c237c-495f-4696-8fc1-b73f8a39fe62',
    },
    {
      outgoing: '204a6a80-8b83-4cff-98ed-e89f4da7c4dc',
      incoming: 'a51e2ad3-69aa-4bbc-a82c-06a6581572bf',
    },
    {
      outgoing: '227ba92c-9b8c-4705-ba76-181f1f697638',
      incoming: 'aab5a8fc-f3a8-4f7f-b5fc-5c2e61553caf',
    },
    {
      outgoing: '22f02ebc-4757-4e06-99e6-f7e4a95720b4',
      incoming: 'ac254a0e-a02b-49be-993d-e89a5803a653',
    },
    {
      outgoing: '285055c6-96a7-4a60-9033-51f83f49dbcb',
      incoming: 'ad0c8518-f9e3-4341-a1db-dccf83145838',
    },
    {
      outgoing: '2958f800-0cca-43a8-8486-08e524434199',
      incoming: 'bdaa78a6-95e2-4456-9bce-cdb6cd505f4e',
    },
    {
      outgoing: '4ce9fa05-703f-40e4-a14e-40cffc3ba305',
      incoming: 'd2ce100a-152e-4b0e-8903-2296a9cb7cbe',
    },
    {
      outgoing: '4ffcc7ec-15a1-4c80-8309-e893ef9db022',
      incoming: 'd311fcf5-37da-49a7-b925-63f316a80355',
    },
    {
      outgoing: '6162b471-d011-41f7-ad89-9a8d856c9ffb',
      incoming: 'fb5fe9fe-2fe9-4970-b152-f08871ffec61',
    },
    {
      outgoing: '697d34f5-fe65-422a-b624-5a4957ef4196',
      incoming: 'fb7c947d-79ce-4706-8c33-bb4f39359c59',
    },
  ].map(Object.freeze)
);
export const ROSTER_CLUSTERS = Object.freeze([
  '56d5d6f0-23e9-41b0-b407-852aa1026c2a',
  '0cdc133d-ad23-4ace-bb85-312d0f221edd',
]);
const CLUSTERS = ROSTER_CLUSTERS;
const PUBLIC_KEY = 'sb_publishable__41LpJpzrfrb3hSUpEaYCA_tF53bBJx';
class RosterFailure extends Error {}
const fail = (code) => {
  throw new RosterFailure(code);
};
const hash = (x) => createHash('sha256').update(JSON.stringify(x)).digest('hex');
export function rosterRequestId(kind, user) {
  const h = hash([ROSTER_OPERATION, kind, user]);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
}
export function rosterCents(value) {
  if (!/^(0|[1-9]\d*)(\.\d{1,2})?$/.test(String(value))) fail('INVALID_MONEY');
  const [whole, fraction = ''] = String(value).split('.');
  const n = Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
  if (!Number.isSafeInteger(n)) fail('INVALID_MONEY');
  return n;
}
/** Values captured by UPDATE ... RETURNING inside the one bank-send transaction,
 * not a claim about a wallet after ordinary play resumes. */
export function rosterFundingReadback(r) {
  const amount = rosterCents(r?.amount),
    bankBefore = rosterCents(r?.bank_before),
    bankAfter = rosterCents(r?.bank_after),
    walletAfter = rosterCents(r?.recipient_balance_after);
  if (
    r?.success !== true ||
    amount !== 20000 ||
    r.destination !== 'player_wallet' ||
    !r.transaction_id ||
    r.replayed === true ||
    walletAfter !== 20000 ||
    bankBefore - bankAfter !== 20000
  )
    fail('FUND_RECEIPT_INVALID');
  return {
    transactionId: r.transaction_id,
    walletAfterAtFunding: walletAfter / 100,
    bankBeforeAtFunding: bankBefore / 100,
    bankAfterAtFunding: bankAfter / 100,
  };
}
function member(m) {
  return {
    user_id: m.user_id,
    role: m.role,
    status: m.status,
    joined_at: m.joined_at,
    created_at: m.created_at,
    chip_balance: rosterCents(m.chip_balance),
    credit_used: rosterCents(m.credit_used),
    locked_chips: rosterCents(m.locked_chips),
    held_chips: rosterCents(m.held_chips),
    promo_balance: rosterCents(m.promo_balance ?? 0),
    diamonds: rosterCents(m.diamonds ?? 0),
  };
}
/** Normal HorseBehavior activity hours and StableHandTags day rules. Host clock,
 * not a database-time certificate; no invented minimum activity duration. */
export function assertIncomingEligibility(
  { id, profile, state, load, activeCashSeats, openCashSessions },
  nowMs
) {
  if (!Number.isFinite(nowMs)) fail('INCOMING_CLOCK_UNAVAILABLE');
  if (!['cash', 'both'].includes(profile?.horse_profile?.lane)) fail('INCOMING_CASH_LANE_REQUIRED');
  if (!Number.isSafeInteger(load) || load < 0 || load > 2) fail('INCOMING_GAME_LOAD_CHANGED');
  if (activeCashSeats !== 0 || openCashSessions !== 0) fail('INCOMING_CASH_EXPOSURE_CHANGED');
  const at = new Date(nowMs),
    hourUTC = at.getUTCHours();
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  if ((hourUTC - (h % 24) + 24) % 24 >= 10 + ((h >>> 5) % 8)) fail('INCOMING_ASLEEP');
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/Chicago',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      weekday: 'short',
    })
      .formatToParts(at)
      .map((p) => [p.type, p.value])
  );
  const weekday = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(parts.weekday);
  const day = `${parts.year}-${parts.month}-${parts.day}`;
  if (state !== null && state !== undefined) {
    if (state.horse_id !== id) fail('INCOMING_DAY_IDENTITY_CHANGED');
    if (
      state.rest_weekday != null &&
      (!Number.isInteger(Number(state.rest_weekday)) ||
        Number(state.rest_weekday) < 0 ||
        Number(state.rest_weekday) > 6)
    )
      fail('INCOMING_DAY_STATE_UNREADABLE');
    if (
      state.daily_cap_minutes != null &&
      (!Number.isFinite(Number(state.daily_cap_minutes)) || Number(state.daily_cap_minutes) < 0)
    )
      fail('INCOMING_DAY_STATE_UNREADABLE');
    if (
      !Number.isFinite(Number(state.minutes_played_today)) ||
      Number(state.minutes_played_today) < 0
    )
      fail('INCOMING_DAY_STATE_UNREADABLE');
    if (
      state.rest_weekday !== null &&
      state.rest_weekday !== undefined &&
      Number(state.rest_weekday) === weekday
    )
      fail('INCOMING_REST_DAY');
    if (
      state.counters_reset_on === day &&
      state.daily_cap_minutes !== null &&
      state.daily_cap_minutes !== undefined &&
      Number(state.minutes_played_today) >= Number(state.daily_cap_minutes)
    )
      fail('INCOMING_DAILY_CAP');
  }
  return {
    observedAt: at.toISOString(),
    clock: 'host_normal_fleet_clock',
    hourUTC,
    chicagoDay: day,
    gameLoad: load,
  };
}
function checked(s) {
  assertPilotClub(s.club);
  if (s.frozen !== false || s.admission?.allowed !== true)
    fail('FINANCIAL_OR_ADMISSION_GATE_CLOSED');
  if (s.club.id !== ROSTER_CLUB || s.club.settlement_locked === true) fail('CLUB_SCOPE_CHANGED');
  if (
    !Array.isArray(s.games) ||
    s.games.length !== 2 ||
    CLUSTERS.some(
      (id) =>
        !s.games.some((g) => {
          if (g.id !== id) return false;
          assertCurrentPilotTarget(g, ROSTER_CLUB, { active: false });
          return (
            g.enabled === true &&
            !g.closed_at &&
            g.lightning_enabled === false &&
            g.cluster_mode === 'must_move'
          );
        })
    )
  )
    fail('PILOT_MUST_BE_DISABLED');
  if (!Array.isArray(s.members) || s.members.length > 74) fail('ROSTER_UNREADABLE');
  if (
    !Array.isArray(s.profiles) ||
    s.members.some(
      (m) =>
        m.user_id !== PILOT.ownerId &&
        !s.profiles.some((p) => p.id === m.user_id && p.is_horse === true && p.status === 'active')
    )
  )
    fail('NON_HORSE_ROSTER');
  const rows = s.members.map(member).sort((a, b) => a.user_id.localeCompare(b.user_id));
  if (new Set(rows.map((m) => m.user_id)).size !== rows.length) fail('DUPLICATE_MEMBER');
  const owner = rows.find((m) => m.user_id === PILOT.ownerId);
  if (!owner || owner.role !== 'owner' || owner.status !== 'active') fail('OWNER_CHANGED');
  if (
    rows.some(
      (m) =>
        m.user_id !== PILOT.ownerId &&
        (m.role !== 'player' || !['active', 'pending'].includes(m.status))
    )
  )
    fail('ROSTER_ROLE_CHANGED');
  return { members: rows, treasury: rosterCents(s.club.chip_treasury) };
}
function assertHazards(s, id) {
  const m = s.members.find((m) => m.user_id === id);
  if (
    !m ||
    [m.credit_used, m.locked_chips, m.held_chips, m.promo_balance ?? 0, m.diamonds ?? 0].some(
      (x) => rosterCents(x) !== 0
    )
  )
    fail('OUTGOING_FINANCIAL_OBLIGATION');
  if (
    !s.hazards ||
    Object.keys(s.hazards).length !== 7 ||
    Object.values(s.hazards).some((n) => n !== 0)
  )
    fail('OUTGOING_NOT_SETTLED');
}
function same(actual, expected) {
  if (!isDeepStrictEqual(actual, expected)) fail('BASELINE_OR_READBACK_CHANGED');
}
const requestManifest = () =>
  ROSTER_PAIRS.map(({ incoming }) => ({
    userId: incoming,
    joinRequestId: rosterRequestId('join', incoming),
    fundRequestId: rosterRequestId('fund', incoming),
  }));
const membershipIdentity = (s) =>
  s.members.map(
    ({
      chip_balance,
      credit_used,
      locked_chips,
      held_chips,
      promo_balance,
      diamonds,
      ...identity
    }) => identity
  );
export async function prepareRoster({ adapter, sourceRunId, operationId, now = () => Date.now() }) {
  if (!/^[0-9a-f-]{36}$/i.test(operationId ?? '')) fail('OPERATION_ID_REQUIRED');
  if (!/^\d+$/.test(String(sourceRunId))) fail('PREPARE_RUN_ID_REQUIRED');
  const raw = await adapter.snapshot();
  const initial = checked(raw);
  if (initial.members.length !== 73) fail('EXACT_72_HORSES_REQUIRED');
  const incomingEligibility = [];
  for (const { outgoing, incoming } of ROSTER_PAIRS) {
    if (
      !initial.members.some((m) => m.user_id === outgoing && m.status === 'active') ||
      initial.members.some((m) => m.user_id === incoming)
    )
      fail('PINNED_ROSTER_CHANGED');
    const s = await adapter.snapshot(outgoing);
    same(membershipIdentity(checked(s)), membershipIdentity(initial));
    assertHazards(s, outgoing);
    const verified = await adapter.validateIncoming(incoming);
    incomingEligibility.push({ userId: incoming, ...verified?.eligibility });
  }
  // Gross send budget must be available without relying on speculative returns.
  if (initial.treasury < 360000) fail('INSUFFICIENT_GROSS_TREASURY');
  const baseline = {
    version: 1,
    operation: ROSTER_OPERATION,
    operationId,
    clubId: ROSTER_CLUB,
    sourceRunId: String(sourceRunId),
    preparedAt: now(),
    pairs: ROSTER_PAIRS,
    requests: requestManifest(),
    incomingEligibility,
    manifestSha256: ROSTER_MANIFEST_SHA256,
    initial,
  };
  return { ...baseline, digest: hash(baseline) };
}
export async function executeRoster({
  adapter,
  baseline,
  admission,
  persist,
  now = () => Date.now(),
  timeoutMs = 480000,
}) {
  if (typeof persist !== 'function') fail('DURABLE_RESULT_SINK_REQUIRED');
  const { digest, ...body } = baseline ?? {};
  if (
    digest !== hash(body) ||
    body.operation !== ROSTER_OPERATION ||
    body.clubId !== ROSTER_CLUB ||
    body.version !== 1 ||
    body.manifestSha256 !== ROSTER_MANIFEST_SHA256 ||
    !isDeepStrictEqual(body.pairs, ROSTER_PAIRS) ||
    !isDeepStrictEqual(body.requests, requestManifest()) ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(body.operationId ?? '')
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
  const deadline = now() + Math.min(timeoutMs, 480000);
  const report = {
    operation: ROSTER_OPERATION,
    operationId: body.operationId,
    baselineDigest: digest,
    prepareRunId: body.sourceRunId,
    executeRunId: String(admission.executeRunId),
    status: 'started',
    steps: [],
    grossFundingCents: 0,
    returnedCents: 0,
  };
  let expected = structuredClone(body.initial);
  const save = () => persist(structuredClone(report));
  const checkTime = () => {
    if (now() >= deadline) fail('DEADLINE');
  };
  const read = async (id) => {
    checkTime();
    const raw = await adapter.snapshot(id);
    same(membershipIdentity(checked(raw)), membershipIdentity(expected));
    return raw;
  };
  async function door(kind, id, call, update) {
    checkTime();
    const step = { kind, userId: id, status: 'intent', requestId: rosterRequestId(kind, id) };
    report.steps.push(step);
    await save();
    let response;
    try {
      response = await call(step.requestId);
    } catch {
      step.status = 'unknown';
      fail('DOOR_OUTCOME_UNKNOWN');
    }
    if (response?.success !== true) {
      step.status = 'refused';
      fail('DOOR_REFUSED');
    }
    step.status = 'acknowledged';
    await save();
    await update(response);
    await read();
    step.status = 'verified';
    await save();
  }
  try {
    await save();
    await read();
    for (const { incoming } of ROSTER_PAIRS) await adapter.validateIncoming(incoming);
    await adapter.assertAssignmentReleased();
    // All departures precede admissions; no bookings or other clubs are edited.
    for (const { outgoing } of ROSTER_PAIRS) {
      const raw = await read(outgoing);
      assertHazards(raw, outgoing);
      const old = expected.members.find((m) => m.user_id === outgoing);
      if (member(raw.members.find((m) => m.user_id === outgoing)).chip_balance !== old.chip_balance)
        fail('OUTGOING_BALANCE_CHANGED');
      await door(
        'leave',
        outgoing,
        () => adapter.leave(outgoing),
        async (r) => {
          if (rosterCents(r.chips_returned) !== old.chip_balance) fail('RETURN_AMOUNT_CHANGED');
          expected.members = expected.members.filter((m) => m.user_id !== outgoing);
          expected.treasury += old.chip_balance;
          report.returnedCents += old.chip_balance;
          const proof = await adapter.verifyLeave(outgoing, old.chip_balance, body.preparedAt);
          report.steps.at(-1).transactionId = proof.transactionId;
        }
      );
    }
    for (const { incoming } of ROSTER_PAIRS) {
      await adapter.validateIncoming(incoming);
      await read();
      // Pending row identity is obtained ONLY from the authoritative normal join.
      await door(
        'join',
        incoming,
        (id) => adapter.join(incoming, id),
        (r) => {
          const m = member(r.membership ?? {});
          if (
            r.status !== 'pending' ||
            m.user_id !== incoming ||
            m.role !== 'player' ||
            m.status !== 'pending' ||
            m.chip_balance !== 0 ||
            !m.joined_at ||
            !m.created_at
          )
            fail('JOIN_SCOPE_CHANGED');
          expected.members.push(m);
          expected.members.sort((a, b) => a.user_id.localeCompare(b.user_id));
        }
      );
      await door(
        'approve',
        incoming,
        () => adapter.approve(incoming),
        () => {
          expected.members.find((m) => m.user_id === incoming).status = 'active';
        }
      );
      await door(
        'fund',
        incoming,
        (id) => adapter.fund(incoming, id),
        async (r) => {
          const atomic = rosterFundingReadback(r);
          if (report.grossFundingCents + 20000 > 360000) fail('FUND_RECEIPT_INVALID');
          expected.members.find((m) => m.user_id === incoming).chip_balance += 20000;
          expected.treasury -= 20000;
          report.grossFundingCents += 20000;
          const proof = await adapter.verifyFunding(incoming, rosterRequestId('fund', incoming), r);
          same(proof, atomic);
          Object.assign(report.steps.at(-1), proof);
        }
      );
    }
    if (expected.members.length !== 73 || report.grossFundingCents !== 360000)
      fail('FINAL_ROSTER_INCOMPLETE');
    await read();
    report.status = 'verified';
    report.capacityQualification = 'not_asserted';
    report.retainedWalletProtection =
      'no_retained_wallet_mutation_requested; natural_play_not_frozen';
  } catch (error) {
    report.status = 'stopped';
    report.cause = ['DOOR_OUTCOME_UNKNOWN', 'DOOR_REFUSED', 'DEADLINE'].includes(error.message)
      ? error.message
      : 'READBACK_OR_SCOPE_UNVERIFIED';
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
/** Real normal authenticated doors; admin is SELECT/auth only, never financial RPC. */
export function createRosterAdapter({
  admin,
  owner,
  createClient,
  url,
  timeoutMs = 15000,
  now = () => Date.now(),
}) {
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
    if (!ROSTER_PAIRS.some((p) => p.incoming === id)) fail('UNPINNED_HORSE');
    const p = data(
      await admin
        .from('profiles')
        .select('id,is_horse,status,horse_profile')
        .eq('id', id)
        .maybeSingle(),
      'INCOMING_PROFILE'
    );
    const u = data(await admin.auth.admin.getUserById(id), 'INCOMING_AUTH').user;
    const [cap, membershipCount] = await Promise.all([
      admin.rpc('fn_club_membership_cap'),
      admin.rpc('fn_club_membership_count', { p_user_id: id, p_excluding_club: ROSTER_CLUB }),
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
      u?.id !== id ||
      typeof u.email !== 'string' ||
      !u.email.trim() ||
      (u.banned_until &&
        (!Number.isFinite(Date.parse(u.banned_until)) || Date.parse(u.banned_until) > Date.now()))
    )
      fail('HORSE_IDENTITY_CHANGED');
    const stateRead = await admin
      .from('stable_hand_horse_state')
      .select('horse_id,rest_weekday,daily_cap_minutes,minutes_played_today,counters_reset_on')
      .eq('horse_id', id)
      .maybeSingle();
    if (stateRead.error) readFailure(stateRead, 'INCOMING_DAY_STATE');
    const [loadRead, memberRead, seatsRead, openCashSessions] = await Promise.all([
      admin.rpc('fn_concurrent_game_load', {
        p_user_id: id,
        p_exclude_seat_id: null,
        p_exclude_table_id: null,
        p_exclude_tournament_id: null,
      }),
      admin
        .from('club_members')
        .select('user_id')
        .eq('club_id', ROSTER_CLUB)
        .eq('user_id', id)
        .maybeSingle(),
      admin
        .from('table_seats')
        .select('id,table_id,stack::text')
        .eq('user_id', id)
        .is('left_at', null)
        .limit(100),
      count('cash_player_session', (q) => q.eq('player_id', id).is('closed_at', null)),
    ]);
    if (memberRead.error) readFailure(memberRead, 'INCOMING_MEMBERSHIP');
    if (memberRead.data !== null) fail('INCOMING_ALREADY_PILOT_MEMBER');
    const seats = data(seatsRead, 'INCOMING_CASH_SEATS');
    if (!Array.isArray(seats) || seats.length >= 100) fail('INCOMING_SEATS_UNREADABLE');
    let activeCashSeats = 0;
    if (seats.length) {
      const tables = data(
        await admin
          .from('tables')
          .select('id,status,tournament_id,club_id')
          .in('id', [...new Set(seats.map((s) => s.table_id))]),
        'INCOMING_SEAT_TABLES'
      );
      if (!Array.isArray(tables) || seats.some((s) => !tables.some((t) => t.id === s.table_id)))
        fail('INCOMING_SEATS_UNREADABLE');
      activeCashSeats = seats.filter((s) => {
        const t = tables.find((t) => t.id === s.table_id);
        return t.status !== 'closed' && t.tournament_id === null;
      }).length;
    }
    const eligibility = assertIncomingEligibility(
      {
        id,
        profile: p,
        state: stateRead.data,
        load: data(loadRead, 'INCOMING_GAME_LOAD'),
        activeCashSeats,
        openCashSessions,
      },
      now()
    );
    return { ...u, eligibility };
  }
  async function horseJoin(id, requestId) {
    const u = await validateIncoming(id);
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
          p_identifier: ROSTER_CLUB,
          p_request_id: requestId,
          p_referral_code: null,
        })
      );
      if (joined.success !== true) return joined;
      if (
        joined.club?.id !== ROSTER_CLUB ||
        joined.status !== 'pending' ||
        joined.membership?.user_id !== id ||
        joined.membership?.club_id !== ROSTER_CLUB
      )
        fail('JOIN_RECEIPT_SCOPE_MISMATCH');
      const persisted = data(
        await admin
          .from('club_members')
          .select(
            'club_id,user_id,role,status,joined_at,created_at,chip_balance::text,credit_used::text,locked_chips::text,held_chips::text,promo_balance::text,diamonds::text'
          )
          .eq('club_id', ROSTER_CLUB)
          .eq('user_id', id)
          .maybeSingle()
      );
      if (persisted.club_id !== ROSTER_CLUB || persisted.user_id !== id)
        fail('JOIN_READBACK_SCOPE_MISMATCH');
      same(member(persisted), member(joined.membership));
      return { ...joined, membership: persisted };
    } finally {
      const out = await client.auth.signOut({ scope: 'local' });
      if (out?.error) fail('HORSE_SESSION_CLEANUP_UNKNOWN');
    }
  }
  return {
    validateIncoming,
    async assertAssignmentReleased() {
      await assertOwner();
      const status = data(
        await owner.rpc('fn_lightning_pilot_assignment_status'),
        'PILOT_ASSIGNMENT'
      );
      if (status.club_id !== ROSTER_CLUB || typeof status.active !== 'boolean')
        fail('PILOT_ASSIGNMENT_UNVERIFIED');
      if (status.active) fail('PILOT_ASSIGNMENT_STILL_ACTIVE');
    },
    async snapshot(hazardsFor) {
      const [club, members, games] = await Promise.all([
        admin
          .from('clubs')
          .select(
            'id,owner_id,name,is_public,requires_approval,union_id,chip_treasury,settlement_locked'
          )
          .eq('id', ROSTER_CLUB)
          .maybeSingle(),
        admin
          .from('club_members')
          .select(
            'user_id,role,status,joined_at,created_at,chip_balance::text,credit_used::text,locked_chips::text,held_chips::text,promo_balance::text,diamonds::text'
          )
          .eq('club_id', ROSTER_CLUB)
          .limit(75),
        admin.from('cash_games').select('*').in('id', CLUSTERS),
      ]);
      const memberRows = data(members, 'MEMBERS');
      const profiles = data(
        await admin
          .from('profiles')
          .select('id,is_horse,status')
          .in(
            'id',
            memberRows.map((m) => m.user_id)
          )
          .limit(75),
        'ROSTER_PROFILES'
      );
      const [freeze, admission] = await Promise.all([
        admin.rpc('fn_platform_frozen'),
        admin.rpc('fn_ca_commerce_admission', {
          p_scope_kind: 'club',
          p_scope_id: ROSTER_CLUB,
          p_action: 'approve_member',
        }),
      ]);
      const result = {
        club: data(club, 'CLUB'),
        members: memberRows,
        games: data(games, 'GAMES'),
        profiles,
        frozen: data(freeze, 'FREEZE'),
        admission: data(admission, 'ADMISSION'),
      };
      if (hazardsFor) {
        const tournamentRows = data(
          await admin
            .from('tournaments')
            .select('id,status')
            .eq('club_id', ROSTER_CLUB)
            .limit(1000),
          'PILOT_EVENTS'
        );
        if (!Array.isArray(tournamentRows) || tournamentRows.length >= 1000)
          fail('PILOT_EVENTS_UNREADABLE');
        const liveEvents = tournamentRows
          .filter((t) => !['COMPLETED', 'CANCELLED'].includes(String(t.status).toUpperCase()))
          .map((t) => t.id);
        const eventCount = liveEvents.length
          ? await count('tournament_players', (q) =>
              q
                .eq('user_id', hazardsFor)
                .in('tournament_id', liveEvents)
                .in('status', ['registered', 'playing'])
            )
          : 0;
        const base = (q) => q.eq('club_id', ROSTER_CLUB);
        const counts = await Promise.all([
          count('table_seats', (q) => base(q).eq('user_id', hazardsFor).is('left_at', null)),
          count('cash_player_session', (q) =>
            base(q).eq('player_id', hazardsFor).is('closed_at', null)
          ),
          count('chip_escrow', (q) => base(q).eq('player_id', hazardsFor).is('released_at', null)),
          count('chip_escrow_holds', (q) => base(q).eq('user_id', hazardsFor).eq('status', 'held')),
          count('cashout_requests', (q) =>
            base(q).eq('player_id', hazardsFor).in('status', ['pending', 'approved', 'processing'])
          ),
          count('lightning_pool_session', (q) =>
            q.in('cluster_id', CLUSTERS).eq('player_id', hazardsFor).is('exited_at', null)
          ),
        ]);
        result.hazards = Object.fromEntries(
          ['seats', 'uncashed', 'escrow', 'holds', 'cashouts', 'pool', 'events'].map((k, i) => [
            k,
            [...counts, eventCount][i],
          ])
        );
      }
      return result;
    },
    async leave(id) {
      await assertOwner();
      return data(
        await owner.rpc('fn_member_leave_to_treasury', { p_club_id: ROSTER_CLUB, p_user_id: id })
      );
    },
    join: horseJoin,
    async approve(id) {
      await assertOwner();
      return data(
        await owner.rpc('fn_review_join_request', {
          p_club_id: ROSTER_CLUB,
          p_user_id: id,
          p_approve: true,
        })
      );
    },
    async fund(id, op) {
      await assertOwner();
      return data(
        await owner.rpc('fn_club_bank_send', {
          p_club_id: ROSTER_CLUB,
          p_to_user_id: id,
          p_amount: 200,
          p_destination: 'player_wallet',
          p_reason: ROSTER_OPERATION,
          p_op_id: op,
        })
      );
    },
    async verifyLeave(id, cents, preparedAt) {
      const rows = data(
        await admin
          .from('chip_transactions')
          .select('id,from_user_id,amount::text')
          .eq('club_id', ROSTER_CLUB)
          .eq('from_user_id', id)
          .eq('transaction_type', 'leave_club_chip_return')
          .gte('created_at', new Date(preparedAt).toISOString())
          .limit(2)
      );
      if (cents === 0) {
        if (rows.length !== 0) fail('LEAVE_LEDGER_UNVERIFIED');
        return { transactionId: null };
      }
      if (rows.length !== 1 || rows[0].from_user_id !== id || rosterCents(rows[0].amount) !== cents)
        fail('LEAVE_LEDGER_UNVERIFIED');
      return { transactionId: rows[0].id };
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
          .eq('club_id', ROSTER_CLUB)
          .eq('transaction_type', 'club_bank_send')
          .eq('metadata->>op_id', op)
      );
      same(intent.operation_intent, {
        actor: PILOT.ownerId,
        club: ROSTER_CLUB,
        action: 'club_bank_send',
        target: id,
        amount: 200,
        effective_wallet: 'player_wallet',
        reason: ROSTER_OPERATION,
      });
      if (
        intent.actor_user_id !== PILOT.ownerId ||
        intent.action !== 'club_bank_send' ||
        intent.club_id !== ROSTER_CLUB ||
        !intent.completed_at ||
        intent.receipt?.success !== true ||
        tx.length !== 1 ||
        tx[0].id !== intent.receipt.transaction_id ||
        tx[0].from_user_id !== PILOT.ownerId ||
        tx[0].to_user_id !== id ||
        rosterCents(tx[0].amount) !== 20000 ||
        tx[0].metadata?.destination !== 'player_wallet' ||
        tx[0].metadata?.op_id !== op
      )
        fail('DURABLE_FUNDING_UNVERIFIED');
      const proof = rosterFundingReadback(response);
      same(rosterFundingReadback(intent.receipt), proof);
      same(
        rosterFundingReadback({
          ...tx[0].metadata,
          success: true,
          amount: tx[0].amount,
          destination: tx[0].metadata.destination,
          transaction_id: tx[0].id,
        }),
        proof
      );
      if (rosterCents(tx[0].balance_after) !== rosterCents(response.bank_after))
        fail('DURABLE_FUNDING_UNVERIFIED');
      return proof;
    },
  };
}

export async function rosterMain(env = process.env, clientFactory) {
  const reportPath = env.PILOT_ROSTER_REPORT_PATH ?? 'lightning-roster-report.json';
  const baselinePath = env.PILOT_ROSTER_BASELINE_PATH ?? 'lightning-roster-baseline.json';
  const persist = (r) => writeFileSync(reportPath, JSON.stringify(r, null, 2));
  let owner;
  let result;
  let cleanup = 'not_opened';
  let phase = 'input';
  try {
    if (
      !['prepare', 'execute'].includes(env.PILOT_ROSTER_PHASE) ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
        env.PILOT_ROSTER_OPERATION_ID ?? ''
      )
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
    const end = Date.now() + 540000;
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
    const adapter = createRosterAdapter({ admin, owner, createClient, url: env.SUPABASE_URL });
    phase = env.PILOT_ROSTER_PHASE;
    if (env.PILOT_ROSTER_PHASE === 'prepare') {
      const baseline = await prepareRoster({
        adapter,
        sourceRunId: env.GITHUB_RUN_ID,
        operationId: env.PILOT_ROSTER_OPERATION_ID,
      });
      writeFileSync(baselinePath, JSON.stringify(baseline, null, 2));
      result = {
        status: 'prepared',
        operation: ROSTER_OPERATION,
        operationId: baseline.operationId,
        baselineDigest: baseline.digest,
        sourceRunId: baseline.sourceRunId,
        noRosterOrMoneyWrites: true,
      };
    } else {
      const baseline = JSON.parse(readFileSync(baselinePath, 'utf8'));
      if (baseline.operationId !== env.PILOT_ROSTER_OPERATION_ID)
        fail('BASELINE_OPERATION_MISMATCH');
      result = await executeRoster({
        adapter,
        baseline,
        persist,
        admission: {
          firstInvocation:
            env.PILOT_ROSTER_EXECUTE_ADMITTED === 'true' && env.GITHUB_RUN_ATTEMPT === '1',
          prepareRunId: env.PILOT_ROSTER_PREPARE_RUN_ID,
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
      diagnostic: error instanceof RosterFailure ? error.message : 'UNEXPECTED_FAILURE',
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
  // Preserve the granular execute journal even if CLI setup/cleanup fails.
  if (!result?.steps)
    try {
      const previous = JSON.parse(readFileSync(reportPath, 'utf8'));
      if (previous.operation === ROSTER_OPERATION && previous.executeRunId === env.GITHUB_RUN_ID)
        result = { ...previous, ...result };
    } catch {}
  result = { ...result, cleanup };
  if (cleanup !== 'local_session_closed') result.status = 'stopped';
  persist(result);
  return result;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  rosterMain()
    .then((r) => {
      console.log(JSON.stringify(r));
      if (!['prepared', 'verified'].includes(r.status)) process.exitCode = 1;
    })
    .catch(() => {
      console.error('ROSTER_RESULT_UNAVAILABLE');
      process.exitCode = 1;
    });
}
