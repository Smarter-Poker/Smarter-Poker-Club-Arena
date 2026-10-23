/** Explicit finite withdrawal of existing, zero-cost, never-seated pre-start
 * bookings. Authorization is the owner's instruction, not the manifest's label.
 * No CLI, new registration, direct wallet writes, retry, identity creation or
 * global policy write. The exact-zero adapter delegates normal unregistration. */
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const ASSIGNMENT_MANIFEST_SHA256 =
  '3e61e6fc2157a833a83a5e7096b4ff2bbfef802f0ce8dfe2feb5944faa680820';
const ASSIGNMENT_SIZE = 144;
const raw = readFileSync(
  new URL('../../docs/lightning/PILOT-ASSIGNMENT-MANIFEST-2026-10-23.json', import.meta.url)
);
const hash = (x) =>
  createHash('sha256')
    .update(typeof x === 'string' || Buffer.isBuffer(x) ? x : JSON.stringify(x))
    .digest('hex');
const fail = (code) => {
  throw Error(code);
};
if (hash(raw) !== ASSIGNMENT_MANIFEST_SHA256) fail('MANIFEST_BYTES_CHANGED');
const manifest = JSON.parse(raw);
export const ASSIGNMENT_CLUB = 'e14bc9f7-736d-425f-8f2c-e78305ebac1d';
if (
  manifest.clubId !== ASSIGNMENT_CLUB ||
  manifest.participants.length !== ASSIGNMENT_SIZE ||
  new Set(manifest.participants).size !== ASSIGNMENT_SIZE ||
  manifest.participants.some((x) => !UUID.test(x)) ||
  !isDeepStrictEqual(manifest.participants, [...manifest.participants].sort())
)
  fail('EXACT_REVIEWED_MANIFEST_REQUIRED');
export const ASSIGNMENT_MEMBERS = Object.freeze([...manifest.participants]);
const OPERATION = 'lightning-pilot-assignment-withdraw';
const scope = (x) => {
  if (
    !x ||
    !ASSIGNMENT_MEMBERS.includes(x.playerId) ||
    !UUID.test(x.eventId) ||
    !UUID.test(x.bookingId)
  )
    fail('BOOKING_SCOPE_INVALID');
  return { playerId: x.playerId, eventId: x.eventId, bookingId: x.bookingId };
};
const zero = (x) =>
  (typeof x === 'number' || typeof x === 'string') && /^(0|0\.0{1,2})$/.test(String(x));
const result = (r) => {
  if (r?.error || r?.data === undefined) fail('READ_UNAVAILABLE');
  return r.data;
};
const rows = (r) => {
  const x = result(r);
  if (!Array.isArray(x) || x.length >= 1000) fail('READ_INCOMPLETE');
  return x;
};
const same = (a, b) => {
  if (!isDeepStrictEqual(a, b)) fail('BASELINE_SCOPE_CHANGED');
};
const sortIds = (xs) => {
  if (!Array.isArray(xs) || xs.some((x) => !UUID.test(x)) || new Set(xs).size !== xs.length)
    fail('READ_UNAVAILABLE');
  return [...xs].sort();
};
export function assignmentWithdrawalRequestId(operationId, entry) {
  scope(entry);
  if (!UUID.test(operationId)) fail('OPERATION_ID_REQUIRED');
  const h = hash([OPERATION, operationId, entry.playerId, entry.eventId, entry.bookingId]);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
}
/** Raw rows plus explicit exact counts, supplied by the concrete SELECT adapter. */
function obviousPreservation(snapshot, entry, nowMs) {
  scope(entry);
  if (!Number.isFinite(nowMs)) fail('CLOCK_UNAVAILABLE');
  const r = snapshot?.registration,
    t = snapshot?.event;
  if (!r) return { allowed: false, cause: 'REGISTRATION_ABSENT' };
  if (
    r.id !== entry.bookingId ||
    r.user_id !== entry.playerId ||
    r.tournament_id !== entry.eventId ||
    t?.id !== entry.eventId
  )
    fail('BOOKING_SCOPE_CHANGED');
  if (
    !['ANNOUNCED', 'REGISTERING'].includes(t.status) ||
    t.started_at !== null ||
    !Number.isFinite(Date.parse(t.start_time)) ||
    Date.parse(t.start_time) <= nowMs
  )
    return { allowed: false, cause: 'EVENT_NOT_PRESTART' };
  if (r.status !== 'registered' || r.table_id !== null || r.seat_number !== null)
    return { allowed: false, cause: 'SEAT_OR_PLAY_CONTRACT_PRESERVED' };
  if (!zero(t.buy_in_amount) || !zero(t.buy_in_fee) || !zero(t.bounty_amount))
    return { allowed: false, cause: 'PAID_ENTRY_PRESERVED' };
  return null;
}
export function withdrawalPreflight(snapshot, entry, nowMs) {
  const preserved = obviousPreservation(snapshot, entry, nowMs);
  if (preserved) return preserved;
  const r = snapshot.registration,
    t = snapshot.event;
  if (
    !['chips', 'diamonds'].includes(snapshot.asset) ||
    !Number.isFinite(Date.parse(r.registered_at))
  )
    fail('READ_UNAVAILABLE');
  const names = [
    'activeSeats',
    'activeHands',
    'seatContracts',
    'positiveChipFunding',
    'positiveDiamondFunding',
    'diamondLedger',
  ];
  if (names.some((k) => !Number.isSafeInteger(snapshot.counts?.[k]) || snapshot.counts[k] < 0))
    fail('READ_UNAVAILABLE');
  if (names.some((k) => snapshot.counts[k] !== 0))
    return { allowed: false, cause: 'EXISTING_OBLIGATION_PRESERVED' };
  if (!Array.isArray(snapshot.entitlements) || !Array.isArray(snapshot.custodies))
    fail('READ_UNAVAILABLE');
  for (const e of snapshot.entitlements) {
    if (
      e.user_id !== entry.playerId ||
      e.tournament_id !== entry.eventId ||
      e.registration_id !== entry.bookingId ||
      !UUID.test(e.id)
    )
      fail('FUNDING_SCOPE_CHANGED');
    if (!zero(e.gross) || e.entitlement_kind !== 'wallet_charge')
      return { allowed: false, cause: 'PAID_ENTRY_PRESERVED' };
  }
  let custodyId = null;
  if (snapshot.asset === 'diamonds') {
    if (snapshot.entitlements.length !== 0 || snapshot.custodies.length !== 1)
      return { allowed: false, cause: 'CUSTODY_NOT_ZERO_FREE_ENTRY' };
    const c = snapshot.custodies[0];
    if (
      !UUID.test(c.id) ||
      c.user_id !== entry.playerId ||
      c.target_id !== entry.eventId ||
      c.purpose !== 'tournament_entry' ||
      c.entry_key !== `entry:${entry.bookingId}`
    )
      fail('CUSTODY_SCOPE_CHANGED');
    if (c.state !== 'active' || !zero(c.balance) || c.seat_id !== null)
      return { allowed: false, cause: 'CUSTODY_NOT_ZERO_FREE_ENTRY' };
    custodyId = c.id;
  } else if (snapshot.custodies.length !== 0)
    return { allowed: false, cause: 'CUSTODY_NOT_ZERO_FREE_ENTRY' };
  return {
    allowed: true,
    identity: {
      asset: snapshot.asset,
      registeredAt: r.registered_at,
      startTime: t.start_time,
      custodyId,
      entitlementIds: sortIds(snapshot.entitlements.map((e) => e.id)),
    },
  };
}
export function proveAssignmentWithdrawal(entry, outcome) {
  scope(entry);
  if (outcome?.registrationAbsent !== true) fail('WITHDRAWAL_OUTCOME_UNKNOWN');
  if (entry.identity.asset === 'chips') {
    const r = outcome.chipReceipt;
    if (
      r?.ok !== true ||
      r.registration_id !== entry.bookingId ||
      r.request_id !== entry.requestId ||
      !zero(r.refunded_chips) ||
      !zero(r.returned_ticket_value) ||
      !zero(r.fees_reversed) ||
      !Number.isFinite(Date.parse(r.settled_at)) ||
      Date.parse(r.settled_at) >= Date.parse(entry.identity.startTime) ||
      !isDeepStrictEqual(sortIds(r.entitlement_ids), entry.identity.entitlementIds) ||
      ['credit_ledger_ids', 'wallet_transaction_ids', 'ticket_ids', 'fee_reversal_ids'].some(
        (k) => !Array.isArray(r[k]) || r[k].length !== 0
      )
    )
      fail('CHIP_RECEIPT_UNVERIFIED');
    return {
      asset: 'chips',
      registrationId: r.registration_id,
      requestId: r.request_id,
      refunded: 0,
      registrationAbsent: true,
    };
  }
  const c = outcome.custody,
    m = outcome.movement,
    r = m?.receipt;
  if (
    c?.id !== entry.identity.custodyId ||
    c.user_id !== entry.playerId ||
    c.target_id !== entry.eventId ||
    c.purpose !== 'tournament_entry' ||
    c.entry_key !== `entry:${entry.bookingId}` ||
    c.state !== 'released' ||
    !zero(c.balance) ||
    c.seat_id !== null ||
    !Number.isFinite(Date.parse(c.released_at)) ||
    outcome.diamondLedgerCount !== 0 ||
    m?.request_id !== entry.requestId ||
    m.custody_id !== c.id ||
    m.user_id !== entry.playerId ||
    m.action !== 'release' ||
    !zero(m.amount) ||
    m.wallet_journal_id !== null ||
    m.request?.action !== 'release' ||
    m.request?.custody_id !== c.id ||
    m.request?.user_id !== entry.playerId ||
    r?.success !== true ||
    r.custody_id !== c.id ||
    r.request_id !== entry.requestId ||
    !zero(r.amount) ||
    !zero(r.custody_balance) ||
    !zero(r.debt_settled) ||
    r.journal_id !== null
  )
    fail('DIAMOND_RELEASE_UNVERIFIED');
  return {
    asset: 'diamonds',
    registrationId: entry.bookingId,
    requestId: entry.requestId,
    custodyId: c.id,
    released: 0,
    registrationAbsent: true,
  };
}
function clockBudget(timeoutMs, now) {
  if (!Number.isInteger(timeoutMs) || timeoutMs < 30000 || timeoutMs > 600000)
    fail('BOUNDED_TIMEOUT_REQUIRED');
  const end = now() + timeoutMs;
  const remaining = (cleanup = false) => {
    const ms = end - now() - (cleanup ? 0 : 20000);
    if (ms <= 0) fail('DEADLINE');
    return ms;
  };
  const bound = async (p, cleanup = false) => {
    const ms = remaining(cleanup);
    let timer;
    try {
      return await Promise.race([
        p,
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(Error('DEADLINE')), ms);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  };
  return { remaining, bound };
}
export async function prepareAssignmentWithdrawals({
  adapter,
  operationId,
  now = Date.now,
  timeoutMs = 240000,
  maxWithdrawals = 72,
}) {
  if (!Number.isInteger(maxWithdrawals) || maxWithdrawals < 1 || maxWithdrawals > 72)
    fail('BOUNDED_BATCH_REQUIRED');
  if (!UUID.test(operationId)) fail('OPERATION_ID_REQUIRED');
  const { bound } = clockBudget(timeoutMs, now),
    list = await bound(adapter.listRegistrations(ASSIGNMENT_MEMBERS));
  if (!Array.isArray(list) || list.length >= 1000) fail('REGISTRATION_LIST_INCOMPLETE');
  const ordered = [...list].sort((a, b) =>
    `${a.playerId}:${a.eventId}:${a.bookingId}`.localeCompare(
      `${b.playerId}:${b.eventId}:${b.bookingId}`
    )
  );
  const seen = new Set();
  for (const item of ordered) {
    const e = scope(item),
      key = `${e.playerId}:${e.eventId}`;
    if (seen.has(key)) fail('DUPLICATE_REGISTRATION_SCOPE');
    seen.add(key);
  }
  const results = new Array(ordered.length);
  let cursor = 0,
    failed = false;
  const worker = async () => {
    while (!failed && cursor < ordered.length) {
      const index = cursor++,
        item = ordered[index];
      try {
        const e = scope(item),
          requestId = assignmentWithdrawalRequestId(operationId, e);
        const check = withdrawalPreflight(await bound(adapter.readRegistration(e)), e, now());
        if (check.allowed) {
          const entry = { ...e, requestId, identity: check.identity };
          const prior = await bound(adapter.readOutcome(entry));
          if (
            prior?.registrationAbsent !== false ||
            prior.chipReceipt !== null ||
            prior.movement !== null
          )
            fail('PRIOR_OR_UNKNOWN_OUTCOME_NO_REPLAY');
          results[index] = { entry };
        } else results[index] = { preserved: { ...e, cause: check.cause } };
      } catch (error) {
        failed = true;
        throw error;
      }
    }
  };
  const settled = await Promise.allSettled(
    Array.from({ length: Math.min(6, ordered.length) }, worker)
  );
  const failure = settled.find((r) => r.status === 'rejected');
  if (failure) throw failure.reason;
  const eligible = results.flatMap((r) => (r?.entry ? [r.entry] : [])),
    entries = eligible.slice(0, maxWithdrawals),
    deferred = eligible.slice(maxWithdrawals),
    preserved = results.flatMap((r) => (r?.preserved ? [r.preserved] : []));
  const body = {
    version: 1,
    operation: OPERATION,
    operationId,
    manifestSha256: ASSIGNMENT_MANIFEST_SHA256,
    clubId: ASSIGNMENT_CLUB,
    participants: ASSIGNMENT_MEMBERS,
    preparedAt: now(),
    entries,
    deferred,
    maxWithdrawals,
    preserved,
  };
  return { ...body, digest: hash(body) };
}
export async function withdrawAssignment({
  adapter,
  baseline,
  persist,
  now = Date.now,
  timeoutMs = 240000,
}) {
  if (typeof persist !== 'function') fail('DURABLE_RESULT_SINK_REQUIRED');
  const { digest, ...body } = baseline ?? {};
  if (
    hash(body) !== digest ||
    body.version !== 1 ||
    body.operation !== OPERATION ||
    body.manifestSha256 !== ASSIGNMENT_MANIFEST_SHA256 ||
    body.clubId !== ASSIGNMENT_CLUB ||
    !UUID.test(body.operationId) ||
    !isDeepStrictEqual(body.participants, ASSIGNMENT_MEMBERS) ||
    !Array.isArray(body.entries) ||
    body.entries.length >= 1000 ||
    !Array.isArray(body.preserved) ||
    !Array.isArray(body.deferred) ||
    !Number.isInteger(body.maxWithdrawals) ||
    body.maxWithdrawals < 1 ||
    body.maxWithdrawals > 72 ||
    body.entries.length > body.maxWithdrawals ||
    !Number.isFinite(body.preparedAt) ||
    now() < body.preparedAt ||
    now() - body.preparedAt > 1800000
  )
    fail('INVALID_OR_EXPIRED_BASELINE');
  const seen = new Set();
  for (const e of body.entries) {
    scope(e);
    if (
      e.requestId !== assignmentWithdrawalRequestId(body.operationId, e) ||
      seen.has(`${e.playerId}:${e.eventId}`)
    )
      fail('INVALID_BASELINE_REQUEST');
    seen.add(`${e.playerId}:${e.eventId}`);
  }
  const { bound, remaining } = clockBudget(timeoutMs, now),
    clients = new Set();
  const report = {
    operation: OPERATION,
    operationId: body.operationId,
    baselineDigest: digest,
    status: 'started',
    steps: [],
    preserved: body.preserved,
    deferred: body.deferred,
    cleanup: 'pending',
    counts: {
      verified: 0,
      preserved: body.preserved.length,
      remaining: body.entries.length,
      deferred: body.deferred.length,
    },
  };
  let client,
    currentPlayer,
    opening,
    openingSettled = true;
  const save = () => bound(persist(structuredClone(report)));
  const close = async (c) => {
    const out = await bound(c.auth.signOut({ scope: 'local' }), true);
    if (out?.error) fail('LOCAL_CLEANUP_UNKNOWN');
    clients.delete(c);
  };
  try {
    const active = await bound(adapter.assertAssignmentActive());
    if (
      active?.active !== true ||
      active.manifest_sha256 !== ASSIGNMENT_MANIFEST_SHA256 ||
      !isDeepStrictEqual(sortIds(active.player_ids), ASSIGNMENT_MEMBERS)
    )
      fail('EXACT_ACTIVE_ASSIGNMENT_REQUIRED');
    await save();
    for (const entry of body.entries) {
      remaining();
      const step = { ...scope(entry), requestId: entry.requestId, status: 'preflight' };
      report.steps.push(step);
      const check = withdrawalPreflight(await bound(adapter.readRegistration(entry)), entry, now());
      if (!check.allowed) {
        step.status = 'preserved';
        step.cause = check.cause;
        report.counts.preserved++;
        report.counts.remaining--;
        await save();
        continue;
      }
      same(check.identity, entry.identity);
      const prior = await bound(adapter.readOutcome(entry));
      if (
        prior?.registrationAbsent !== false ||
        prior.chipReceipt !== null ||
        prior.movement !== null
      )
        fail('PRIOR_OR_UNKNOWN_OUTCOME_NO_REPLAY');
      if (currentPlayer !== entry.playerId) {
        if (client) await close(client);
        client = null;
        currentPlayer = null;
        openingSettled = false;
        opening = Promise.resolve(
          adapter.openPlayer(entry.playerId, { remaining, onClient: (c) => clients.add(c) })
        ).then(
          (value) => {
            openingSettled = true;
            return value;
          },
          (error) => {
            openingSettled = true;
            throw error;
          }
        );
        const opened = await bound(opening);
        client = opened?.client ?? opened;
        clients.add(client);
        const verified = result(await bound(client.auth.getUser()));
        if (verified?.user?.id !== entry.playerId) fail('PLAYER_AUTH_MISMATCH');
        currentPlayer = entry.playerId;
      }
      // Recheck after authentication; never adopt a replacement registration.
      const finalCheck = withdrawalPreflight(
        await bound(adapter.readRegistration(entry)),
        entry,
        now()
      );
      if (!finalCheck.allowed) {
        step.status = 'preserved';
        step.cause = finalCheck.cause;
        report.counts.preserved++;
        report.counts.remaining--;
        await save();
        continue;
      }
      same(finalCheck.identity, entry.identity);
      step.status = 'intent';
      await save();
      let reply;
      try {
        remaining();
        reply = result(
          await bound(
            client.rpc('fn_lightning_pilot_withdraw_zero', {
              p_tournament_id: entry.eventId,
              p_registration_id: entry.bookingId,
              p_request_id: entry.requestId,
            })
          )
        );
        step.reply = reply?.ok === true ? 'acknowledged' : 'refused';
      } catch {
        step.reply = 'unknown';
      }
      if (reply?.replayed === true || reply?.idempotent === true) fail('REPLAY_RESPONSE_REFUSED');
      const outcome = await bound(adapter.readOutcome(entry));
      if (
        step.reply === 'refused' &&
        outcome?.registrationAbsent === false &&
        outcome.chipReceipt === null &&
        outcome.movement === null
      ) {
        step.status = 'preserved';
        step.cause = 'NORMAL_DOOR_REFUSED';
        report.counts.preserved++;
        report.counts.remaining--;
        await save();
        continue;
      }
      step.proof = proveAssignmentWithdrawal(entry, outcome);
      step.status = 'verified';
      report.counts.verified++;
      report.counts.remaining--;
      await save();
    }
    report.status = report.counts.deferred
      ? 'verified_batch_with_deferred'
      : report.counts.preserved
        ? 'verified_with_preserved'
        : 'verified';
  } catch (error) {
    report.status = 'stopped';
    const codes = [
      'DEADLINE',
      'EXACT_ACTIVE_ASSIGNMENT_REQUIRED',
      'PRIOR_OR_UNKNOWN_OUTCOME_NO_REPLAY',
      'PLAYER_AUTH_MISMATCH',
      'REPLAY_RESPONSE_REFUSED',
      'BASELINE_SCOPE_CHANGED',
      'CHIP_RECEIPT_UNVERIFIED',
      'DIAMOND_RELEASE_UNVERIFIED',
      'WITHDRAWAL_OUTCOME_UNKNOWN',
      'LOCAL_CLEANUP_UNKNOWN',
    ];
    report.cause = codes.includes(error?.message) ? error.message : 'READ_OR_SCOPE_UNVERIFIED';
  } finally {
    let clean = true;
    if (opening && !openingSettled)
      try {
        await bound(opening, true);
      } catch {
        if (!openingSettled) clean = false;
      }
    for (const c of clients)
      try {
        await close(c);
      } catch {
        clean = false;
      }
    report.cleanup = clean ? 'local_sessions_closed' : 'unknown';
    if (!clean) report.status = 'stopped';
    try {
      await bound(persist(structuredClone(report)), true);
    } catch {
      report.status = 'stopped';
      report.cause = 'DURABLE_REPORT_UNAVAILABLE';
    }
  }
  return report;
}
/** SELECTs use the actual existing schema. readChipReceipt must be a supported
 * read-only owner: its raw table and existing internal verifier deny service_role.
 * Never substitute a call to the money-writing unregister door for this read. */
export function createAssignmentWithdrawalAdapter({
  admin,
  openPlayer,
  assertAssignmentActive,
  readChipReceipt,
  now = Date.now,
}) {
  const boundedRows = async (q) => {
    const r = await q,
      list = rows(r);
    if (!Number.isSafeInteger(r.count) || r.count !== list.length) fail('READ_INCOMPLETE');
    return list;
  };
  const count = async (table, apply) => {
    const r = await apply(admin.from(table).select('id', { count: 'exact', head: true }));
    if (r.error || !Number.isSafeInteger(r.count) || r.count < 0) fail('COUNT_UNAVAILABLE');
    return r.count;
  };
  const registration = async (e) =>
    result(
      await admin
        .from('tournament_players')
        .select('id,user_id,tournament_id,status,registered_at,table_id,seat_number')
        .eq('id', e.bookingId)
        .eq('user_id', e.playerId)
        .eq('tournament_id', e.eventId)
        .maybeSingle()
    );
  return {
    openPlayer,
    assertAssignmentActive,
    async listRegistrations(members) {
      same(members, ASSIGNMENT_MEMBERS);
      const list = await boundedRows(
        admin
          .from('tournament_players')
          .select('id,user_id,tournament_id', { count: 'exact' })
          .in('user_id', members)
          .in('status', ['registered', 'playing'])
          .order('id', { ascending: true })
          .limit(1000)
      );
      return list.map((r) =>
        scope({ bookingId: r.id, playerId: r.user_id, eventId: r.tournament_id })
      );
    },
    async readRegistration(e) {
      scope(e);
      const r = await registration(e);
      if (!r) return { registration: null };
      const event = result(
        await admin
          .from('tournaments')
          .select('id,club_id,status,start_time,started_at,buy_in_amount,buy_in_fee,bounty_amount')
          .eq('id', e.eventId)
          .maybeSingle()
      );
      if (!event) fail('EVENT_UNAVAILABLE');
      if (obviousPreservation({ registration: r, event }, e, now()))
        return { registration: r, event };
      const club = result(
        await admin.from('clubs').select('id,asset').eq('id', event.club_id).maybeSingle()
      );
      if (club?.id !== event.club_id) fail('EVENT_ASSET_UNKNOWN');
      const tables = await boundedRows(
          admin
            .from('tables')
            .select('id,hands_dealt', { count: 'exact' })
            .eq('tournament_id', e.eventId)
            .limit(1000)
        ),
        tableIds = tables.map((t) => t.id);
      if (
        tables.some(
          (t) => !UUID.test(t.id) || !Number.isSafeInteger(t.hands_dealt) || t.hands_dealt < 0
        )
      )
        fail('EVENT_HAND_STATE_UNAVAILABLE');
      const entitlements = await boundedRows(
        admin
          .from('tournament_refund_entitlements')
          .select('id,user_id,tournament_id,registration_id,gross,entitlement_kind', {
            count: 'exact',
          })
          .eq('user_id', e.playerId)
          .eq('tournament_id', e.eventId)
          .limit(1000)
      );
      const custodies = await boundedRows(
        admin
          .from('poker_diamond_custody')
          .select('id,user_id,target_id,purpose,entry_key,state,balance,seat_id', {
            count: 'exact',
          })
          .eq('user_id', e.playerId)
          .eq('target_id', e.eventId)
          .eq('purpose', 'tournament_entry')
          .neq('state', 'released')
          .limit(1000)
      );
      const [activeSeats, history, chipWallet, chipLedger, diamondFunding, diamondLedger] =
        await Promise.all([
          tableIds.length
            ? count('table_seats', (q) =>
                q.eq('user_id', e.playerId).in('table_id', tableIds).is('left_at', null)
              )
            : 0,
          count('hand_history', (q) => q.eq('tournament_id', e.eventId)),
          count('wallet_transactions', (q) =>
            q
              .eq('user_id', e.playerId)
              .eq('related_entity_id', e.eventId)
              .eq('type', 'debit')
              .gt('amount', 0)
          ),
          count('chip_ledger', (q) =>
            q.eq('from_entity_id', e.playerId).eq('tournament_id', e.eventId).gt('amount', 0)
          ),
          count('poker_diamond_tournament_ledger', (q) =>
            q.eq('user_id', e.playerId).eq('tournament_id', e.eventId).gt('amount', 0)
          ),
          custodies.length
            ? count('poker_diamond_tournament_ledger', (q) =>
                q.in(
                  'custody_id',
                  custodies.map((c) => c.id)
                )
              )
            : 0,
        ]);
      return {
        registration: r,
        event,
        asset: club.asset,
        entitlements,
        custodies,
        counts: {
          activeSeats,
          activeHands: history + tables.reduce((n, t) => n + t.hands_dealt, 0),
          seatContracts: r.table_id !== null || r.seat_number !== null ? 1 : 0,
          positiveChipFunding: chipWallet + chipLedger,
          positiveDiamondFunding: diamondFunding,
          diamondLedger,
        },
      };
    },
    async readOutcome(e) {
      scope(e);
      const absent =
        result(
          await admin
            .from('tournament_players')
            .select('id')
            .eq('user_id', e.playerId)
            .eq('tournament_id', e.eventId)
            .maybeSingle()
        ) === null;
      if (e.identity.asset === 'chips') {
        const receipt =
          typeof readChipReceipt === 'function'
            ? await readChipReceipt(e)
            : result(
                await admin.rpc('fn_lightning_pilot_withdrawal_receipt', {
                  p_player_id: e.playerId,
                  p_tournament_id: e.eventId,
                  p_registration_id: e.bookingId,
                  p_request_id: e.requestId,
                })
              );
        return { registrationAbsent: absent, chipReceipt: receipt, movement: null };
      }
      const custody = result(
        await admin
          .from('poker_diamond_custody')
          .select('id,user_id,target_id,purpose,entry_key,state,balance,seat_id,released_at')
          .eq('id', e.identity.custodyId)
          .maybeSingle()
      );
      const movement = result(
        await admin
          .from('poker_diamond_movements')
          .select('request_id,custody_id,user_id,action,amount,wallet_journal_id,request,receipt')
          .eq('request_id', e.requestId)
          .maybeSingle()
      );
      const diamondLedgerCount = await count('poker_diamond_tournament_ledger', (q) =>
        q.eq('custody_id', e.identity.custodyId)
      );
      return {
        registrationAbsent: absent,
        chipReceipt: null,
        custody,
        movement,
        diamondLedgerCount,
      };
    },
  };
}
