/** Explicit prepare/first-execute only. Never resume or retry a financial door.
 * Baseline must have been retained by a successful separate prepare workflow.
 * Workflow owns duplicate-execute admission and artifact provenance, not this process.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { supabaseServerHeaders } from '../ci/supabase-auth-headers.mjs';
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { assertPilotClub, PILOT } from './prepare-lightning-private-pilot.mjs';
export const ROSTER_CLUB = 'e14bc9f7-736d-425f-8f2c-e78305ebac1d';
export const ROSTER_OPERATION = 'lightning-approved-roster-20261016';
export const ROSTER_PAIRS = Object.freeze(
  [
    {
      outgoing: '005428fe-a366-461f-a23d-ef08f837a94b',
      incoming: '3086452e-9b29-47eb-b6f8-5a9692889753',
    },
    {
      outgoing: '00bc0957-1913-4beb-a4d1-acab94950690',
      incoming: '3c1d70c8-c46a-4e2c-bcc8-dbe53798799a',
    },
    {
      outgoing: '01809c11-71bc-42a6-ad86-2130737d8cf9',
      incoming: '3e4ff3e2-f212-4966-abe7-4988e5a62704',
    },
    {
      outgoing: '023a16c3-4ddb-427f-a9f8-cd7b1d9072f1',
      incoming: '3faa1e32-afb8-4b21-9530-2a9fd81c5766',
    },
    {
      outgoing: '06c09311-deea-4402-a759-e188148757a0',
      incoming: '47dd33b3-1bd6-41a7-951e-8582dae98c5a',
    },
    {
      outgoing: '0a8005e8-5d79-4d8f-809e-e9951ef74651',
      incoming: '4a686160-2102-4cba-b3e5-cfa3b1856602',
    },
    {
      outgoing: '0ce13c54-930f-48b5-93a9-df7a38e90b7f',
      incoming: '4ce9fa05-703f-40e4-a14e-40cffc3ba305',
    },
    {
      outgoing: '0d8a22d1-8ea8-40d7-a821-10547198ff6c',
      incoming: '4ed0fef4-d9fd-41d0-852d-4a52f4193dd2',
    },
    {
      outgoing: '0d94b1d9-c7a6-472f-94c7-8728718c92f8',
      incoming: '4ffcc7ec-15a1-4c80-8309-e893ef9db022',
    },
    {
      outgoing: '0f5f1d65-7ce1-4250-93fe-49078f4f14d1',
      incoming: '6162b471-d011-41f7-ad89-9a8d856c9ffb',
    },
    {
      outgoing: '0fb78895-f4e0-4759-9403-a49a5612e0b5',
      incoming: '62f0d4da-b736-4629-ad14-894e432d0f04',
    },
    {
      outgoing: '10f7c3e0-b291-4039-a157-42e5609fe531',
      incoming: '697d34f5-fe65-422a-b624-5a4957ef4196',
    },
    {
      outgoing: '11d2e4ff-a1f7-4845-bb96-a0626eee0d57',
      incoming: '6d301010-3315-4694-b55d-812ae56110c5',
    },
    {
      outgoing: '137ca64e-eb2a-48a1-84ad-1db2b59aa51e',
      incoming: '778f8033-c9e2-45fa-98ca-935f38e2b8ca',
    },
    {
      outgoing: '1545d652-3c85-429f-9354-a753dd6c8afe',
      incoming: '78d65d90-7234-4d43-816e-9c29e81dd33d',
    },
    {
      outgoing: '1beebb19-4155-47eb-be8a-4af53ab30432',
      incoming: '7d1b678f-cea8-41fc-873e-2ec47ea5c318',
    },
    {
      outgoing: '1cdb67d7-27af-4709-817c-9270bd915249',
      incoming: '7d7a80a2-092c-4338-878a-0416611b249c',
    },
    {
      outgoing: '1cf5f118-0af5-482b-9ab9-8cc7043fb20b',
      incoming: '82861181-5a96-4e7b-bfa4-b75ca2bd145f',
    },
    {
      outgoing: '20f6af61-75e1-4954-b61a-9042f8a9e638',
      incoming: '84385ab0-d3ea-44c1-8e93-6fa6b1d25457',
    },
    {
      outgoing: '2421e6ad-5126-43b5-94a2-80d8edaf490f',
      incoming: '86468a23-14cb-4602-92f7-7e270197fc3c',
    },
    {
      outgoing: '25842c55-5295-4c44-ba0d-540dfaebb24a',
      incoming: '8e5a0e02-7832-416d-970f-f6f74e181dcb',
    },
    {
      outgoing: '27ebd8e0-2d90-4c96-882d-cff35f91c53b',
      incoming: '92cd4964-6206-4989-9730-b7959bae6dc5',
    },
    {
      outgoing: '28413120-b60a-4ae1-a2e4-3c771aed4c5b',
      incoming: 'a23ca5c9-b748-482f-9b59-9db35f7aa996',
    },
  ].map(Object.freeze)
);
const CLUSTERS = ['babb43f1-368e-406f-a97a-a0d5013648b2', '3330ff9f-76ec-4487-b0c9-fc8ad8c2fdbb'];
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
        !s.games.some(
          (g) => g.id === id && g.club_id === ROSTER_CLUB && g.lightning_enabled === false
        )
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
  if (!m || [m.credit_used, m.locked_chips, m.held_chips].some((x) => rosterCents(x) !== 0))
    fail('OUTGOING_FINANCIAL_OBLIGATION');
  if (
    !s.hazards ||
    Object.keys(s.hazards).length !== 6 ||
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
  s.members.map(({ chip_balance, credit_used, locked_chips, held_chips, ...identity }) => identity);
export async function prepareRoster({ adapter, sourceRunId, operationId, now = () => Date.now() }) {
  if (!/^[0-9a-f-]{36}$/i.test(operationId ?? '')) fail('OPERATION_ID_REQUIRED');
  if (!/^\d+$/.test(String(sourceRunId))) fail('PREPARE_RUN_ID_REQUIRED');
  const raw = await adapter.snapshot();
  const initial = checked(raw);
  if (initial.members.length !== 73) fail('EXACT_72_HORSES_REQUIRED');
  for (const { outgoing, incoming } of ROSTER_PAIRS) {
    if (
      !initial.members.some((m) => m.user_id === outgoing && m.status === 'active') ||
      initial.members.some((m) => m.user_id === incoming)
    )
      fail('PINNED_ROSTER_CHANGED');
    const s = await adapter.snapshot(outgoing);
    same(membershipIdentity(checked(s)), membershipIdentity(initial));
    assertHazards(s, outgoing);
    await adapter.validateIncoming(incoming);
  }
  // Gross send budget must be available without relying on speculative returns.
  if (initial.treasury < 460000) fail('INSUFFICIENT_GROSS_TREASURY');
  const baseline = {
    version: 1,
    operation: ROSTER_OPERATION,
    operationId,
    clubId: ROSTER_CLUB,
    sourceRunId: String(sourceRunId),
    preparedAt: now(),
    pairs: ROSTER_PAIRS,
    requests: requestManifest(),
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
          if (
            rosterCents(r.amount) !== 20000 ||
            r.destination !== 'player_wallet' ||
            !r.transaction_id ||
            r.replayed === true ||
            report.grossFundingCents + 20000 > 460000
          )
            fail('FUND_RECEIPT_INVALID');
          expected.members.find((m) => m.user_id === incoming).chip_balance += 20000;
          expected.treasury -= 20000;
          report.grossFundingCents += 20000;
          await adapter.verifyFunding(incoming, rosterRequestId('fund', incoming));
        }
      );
    }
    if (expected.members.length !== 73 || report.grossFundingCents !== 460000)
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
export function createRosterAdapter({ admin, owner, createClient, url, timeoutMs = 15000 }) {
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
      await admin.from('profiles').select('id,is_horse,status').eq('id', id).maybeSingle(),
      'INCOMING_PROFILE'
    );
    const u = data(await admin.auth.admin.getUserById(id), 'INCOMING_AUTH').user;
    const [cap, count] = await Promise.all([
      admin.rpc('fn_club_membership_cap'),
      admin.rpc('fn_club_membership_count', { p_user_id: id, p_excluding_club: ROSTER_CLUB }),
    ]);
    if (
      !Number.isSafeInteger(data(cap, 'MEMBERSHIP_CAP')) ||
      !Number.isSafeInteger(data(count, 'MEMBERSHIP_COUNT')) ||
      data(count, 'MEMBERSHIP_COUNT') >= data(cap, 'MEMBERSHIP_CAP')
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
    return u;
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
            'club_id,user_id,role,status,joined_at,created_at,chip_balance::text,credit_used::text,locked_chips::text,held_chips::text'
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
            'user_id,role,status,joined_at,created_at,chip_balance::text,credit_used::text,locked_chips::text,held_chips::text'
          )
          .eq('club_id', ROSTER_CLUB)
          .limit(75),
        admin.from('cash_games').select('id,club_id,lightning_enabled').in('id', CLUSTERS),
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
          ['seats', 'uncashed', 'escrow', 'holds', 'cashouts', 'pool'].map((k, i) => [k, counts[i]])
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
    async verifyFunding(id, op) {
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
          .select('id,from_user_id,to_user_id,amount::text,metadata')
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
        tx[0].metadata?.destination !== 'player_wallet'
      )
        fail('DURABLE_FUNDING_UNVERIFIED');
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
