/** Explicit owner controls and one finite normal withdrawal operation. No scheduler. */
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { supabaseServerHeaders } from '../ci/supabase-auth-headers.mjs';
import { PILOT } from './prepare-lightning-private-pilot.mjs';
import { resolveCurrentPilotTargets } from './lightning-pilot-targets.mjs';
const PUBLIC_KEY = 'sb_publishable__41LpJpzrfrb3hSUpEaYCA_tF53bBJx';
const PHASES = ['prepare', 'assign', 'withdraw', 'release', 'report'];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** The standing reviewed manifest. 2026-10-23 (owner: "USE AS MANY FUNDED PILOT
 * HORSES AS YOU NEED"): the original funded 72 plus the 72 added and funded by
 * lightning-pilot-roster-expansion-20261023. The 2026-10-17 manifest stays
 * admissible in the database for its own exact 72. */
export const ASSIGNMENT_MANIFEST_SHA256 =
  '3e61e6fc2157a833a83a5e7096b4ff2bbfef802f0ce8dfe2feb5944faa680820';
export const ASSIGNMENT_SIZE = 144;
export function assignmentScope() {
  const raw = readFileSync(
    new URL('../../docs/lightning/PILOT-ASSIGNMENT-MANIFEST-2026-10-23.json', import.meta.url),
    'utf8'
  );
  const scope = JSON.parse(raw);
  if (
    createHash('sha256').update(raw).digest('hex') !== ASSIGNMENT_MANIFEST_SHA256 ||
    scope.clubId !== 'e14bc9f7-736d-425f-8f2c-e78305ebac1d' ||
    !Array.isArray(scope.participants) ||
    scope.participants.length !== ASSIGNMENT_SIZE ||
    new Set(scope.participants).size !== ASSIGNMENT_SIZE ||
    scope.participants.some((id) => !UUID.test(id)) ||
    !isDeepStrictEqual(scope.participants, [...scope.participants].sort())
  )
    throw new Error('Assignment Manifest Refused');
  return scope;
}
export function assignmentControlRequestId(operationId, active) {
  if (!UUID.test(operationId)) throw new Error('Assignment Operation Required');
  const h = createHash('sha256')
    .update(JSON.stringify(['lightning-pilot-assignment-20261017', operationId, active]))
    .digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
}
export function assertAssignmentStatus(status, active) {
  const scope = assignmentScope();
  if (
    !status ||
    typeof status.active !== 'boolean' ||
    status.club_id !== scope.clubId ||
    status.manifest_sha256 !== ASSIGNMENT_MANIFEST_SHA256 ||
    !isDeepStrictEqual(status.player_ids, scope.participants) ||
    (active !== undefined && status.active !== active)
  )
    throw new Error('Assignment Status Unverified');
  return status;
}
const data = (r) => {
  if (r?.error || r?.data == null) throw new Error('Assignment Read Or Door Unverified');
  return r.data;
};
export async function assertAssignmentRoster(admin) {
  const scope = assignmentScope();
  const all = data(
    await admin
      .from('club_members')
      .select('user_id,status,role,membership_lifecycle_status,is_active')
      .eq('club_id', scope.clubId)
      .limit(1001)
  );
  // A DEPARTED MEMBERSHIP IS NOT A MEMBER (2026-10-22). Historical rakeback
  // retention keeps a departed horse's row (status suspended, lifecycle
  // departed, inactive) so its payer receipts survive; 47 such rows landed in
  // the pilot club at 2026-10-22 00:05 UTC. They can play nothing, so they are
  // set aside - but only rows that are exactly that shape and belong to no
  // participant or owner. Anything else is roster drift, as before.
  if (!Array.isArray(all) || all.length > 1000) throw new Error('Assignment Roster Changed');
  const departed = (r) =>
    r.status === 'suspended' &&
    r.membership_lifecycle_status === 'departed' &&
    r.is_active === false;
  const rows = all.filter((r) => !departed(r));
  if (
    all.some(
      (r) => departed(r) && (scope.participants.includes(r.user_id) || r.user_id === PILOT.ownerId)
    ) ||
    rows.length !== ASSIGNMENT_SIZE + 1 ||
    !rows.some((r) => r.user_id === PILOT.ownerId && r.role === 'owner') ||
    !isDeepStrictEqual(
      rows
        .filter((r) => r.user_id !== PILOT.ownerId)
        .map((r) => r.user_id)
        .sort(),
      scope.participants
    ) ||
    rows.some((r) => !['active', 'approved'].includes(r.status))
  )
    throw new Error('Assignment Roster Changed');
  const profiles = data(
    await admin
      .from('profiles')
      .select('id,is_horse,status')
      .in('id', scope.participants)
      .limit(ASSIGNMENT_SIZE + 1)
  );
  if (
    !Array.isArray(profiles) ||
    profiles.length !== ASSIGNMENT_SIZE ||
    !isDeepStrictEqual(profiles.map((p) => p.id).sort(), scope.participants) ||
    profiles.some((p) => p.is_horse !== true || p.status !== 'active')
  )
    throw new Error('Assignment Participant Identity Changed');
  await resolveCurrentPilotTargets(admin, { active: false });
}
export async function assignmentMain(env = process.env, dependencies = {}) {
  const reportPath = env.PILOT_ASSIGNMENT_REPORT_PATH || 'lightning-assignment-report.json';
  const baselinePath = env.PILOT_ASSIGNMENT_BASELINE_PATH || 'lightning-assignment-baseline.json';
  let latestReport;
  const save =
    dependencies.persist || ((r) => writeFileSync(reportPath, JSON.stringify(r, null, 2)));
  const persist = async (r) => {
    latestReport = structuredClone(r);
    await save(r);
  };
  let owner,
    result,
    ownerCleanup = 'not_opened',
    phase = 'input';
  const end = Date.now() + 660000;
  try {
    const scope = assignmentScope();
    if (
      !PHASES.includes(env.PILOT_ASSIGNMENT_PHASE) ||
      !UUID.test(env.PILOT_ASSIGNMENT_OPERATION_ID || '') ||
      typeof env.PILOT_ASSIGNMENT_REASON !== 'string' ||
      env.PILOT_ASSIGNMENT_REASON.trim().length < 12 ||
      env.SP_EMAIL?.toLowerCase() !== PILOT.ownerEmail ||
      !env.SP_PASS ||
      !env.SUPABASE_URL ||
      !env.SUPABASE_SERVICE_ROLE_KEY
    )
      throw new Error('Assignment Manual Input Required');
    phase = 'authentication';
    const factory =
      dependencies.createClient || (await import('@supabase/supabase-js')).createClient;
    const boundedFetch =
      (key, budget = () => end - Date.now()) =>
      (input, init = {}) =>
        fetch(input, {
          ...init,
          headers: key
            ? supabaseServerHeaders(key, Object.fromEntries(new Headers(init.headers)))
            : init.headers,
          signal: AbortSignal.timeout(Math.max(1, Math.min(15000, budget()))),
        });
    const options = {
      auth: { persistSession: false, autoRefreshToken: false },
      global: { fetch: boundedFetch() },
    };
    const admin = factory(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
      ...options,
      global: { fetch: boundedFetch(env.SUPABASE_SERVICE_ROLE_KEY) },
    });
    owner = factory(env.SUPABASE_URL, PUBLIC_KEY, options);
    ownerCleanup = 'unknown';
    const login = data(
      await owner.auth.signInWithPassword({ email: env.SP_EMAIL, password: env.SP_PASS })
    );
    if (
      login.user?.id !== PILOT.ownerId ||
      login.session?.user?.id !== PILOT.ownerId ||
      data(await owner.auth.getUser()).user?.id !== PILOT.ownerId
    )
      throw new Error('Assignment Owner Identity Refused');
    const readStatus = async (active) =>
      assertAssignmentStatus(data(await owner.rpc('fn_lightning_pilot_assignment_status')), active);
    phase = env.PILOT_ASSIGNMENT_PHASE;
    if (['prepare', 'assign', 'withdraw'].includes(phase)) await assertAssignmentRoster(admin);
    if (phase === 'report')
      result = {
        status: 'observed',
        assignment: await readStatus(),
        qualification: 'not_asserted',
      };
    else if (phase === 'assign' || phase === 'release') {
      const active = phase === 'assign';
      const requestId = assignmentControlRequestId(env.PILOT_ASSIGNMENT_OPERATION_ID, active);
      await persist({
        status: 'control_outcome_unknown',
        phase,
        operationId: env.PILOT_ASSIGNMENT_OPERATION_ID,
        requestId,
      });
      const receipt = data(
        await owner.rpc('fn_lightning_pilot_assignment_set', {
          p_active: active,
          p_request_id: requestId,
          p_manifest_sha256: ASSIGNMENT_MANIFEST_SHA256,
          p_player_ids: scope.participants,
          p_reason: env.PILOT_ASSIGNMENT_REASON.trim(),
        })
      );
      if (receipt.ok !== true || receipt.active !== active || receipt.last_request_id !== requestId)
        throw new Error('Assignment Control Unverified');
      result = {
        status: 'verified',
        phase,
        requestId,
        assignment: await readStatus(active),
        qualification: 'not_asserted',
      };
    } else {
      const utility =
        dependencies.utility || (await import('./lightning-pilot-assignment-withdraw.mjs'));
      const openPlayer = async (id, { onClient, remaining }) => {
        remaining();
        if (!scope.participants.includes(id)) throw new Error('Assignment Player Outside Scope');
        const profile = data(
          await admin.from('profiles').select('id,is_horse,status').eq('id', id).maybeSingle()
        );
        remaining();
        const user = data(await admin.auth.admin.getUserById(id)).user;
        if (
          profile.id !== id ||
          profile.is_horse !== true ||
          profile.status !== 'active' ||
          user?.id !== id ||
          typeof user.email !== 'string' ||
          !user.email.trim() ||
          (user.banned_until &&
            (!Number.isFinite(Date.parse(user.banned_until)) ||
              Date.parse(user.banned_until) > Date.now()))
        )
          throw new Error('Assignment Player Identity Changed');
        remaining();
        const link = data(
          await admin.auth.admin.generateLink({ type: 'magiclink', email: user.email })
        );
        if (link.user?.id !== id || typeof link.properties?.hashed_token !== 'string')
          throw new Error('Assignment Link Identity Refused');
        remaining();
        const client = factory(env.SUPABASE_URL, PUBLIC_KEY, {
          ...options,
          global: { fetch: boundedFetch(undefined, () => remaining(true)) },
        });
        onClient(client);
        const logged = data(
          await client.auth.verifyOtp({ token_hash: link.properties.hashed_token, type: 'email' })
        );
        remaining();
        if (
          logged.user?.id !== id ||
          logged.session?.user?.id !== id ||
          data(await client.auth.getUser()).user?.id !== id
        )
          throw new Error('Assignment Player Session Refused');
        return { client };
      };
      const adapter = utility.createAssignmentWithdrawalAdapter({
        admin,
        openPlayer,
        assertAssignmentActive: () => readStatus(true),
      });
      if (phase === 'prepare') {
        const baseline = await utility.prepareAssignmentWithdrawals({
          adapter,
          operationId: env.PILOT_ASSIGNMENT_OPERATION_ID,
          maxWithdrawals: 72,
          timeoutMs: Math.max(1, Math.min(600000, end - Date.now() - 20000)),
        });
        (
          dependencies.writeBaseline ||
          ((b) => writeFileSync(baselinePath, JSON.stringify(b, null, 2)))
        )(baseline);
        result = {
          status: 'prepared',
          phase,
          operationId: baseline.operationId,
          baselineDigest: baseline.digest,
          noRegistrationOrMoneyWrites: true,
        };
      } else {
        const baseline = (
          dependencies.readBaseline || (() => JSON.parse(readFileSync(baselinePath, 'utf8')))
        )();
        if (baseline.operationId !== env.PILOT_ASSIGNMENT_OPERATION_ID)
          throw new Error('Assignment Baseline Operation Changed');
        result = await utility.withdrawAssignment({
          adapter,
          baseline,
          persist,
          timeoutMs: Math.max(1, Math.min(600000, end - Date.now() - 20000)),
        });
      }
    }
  } catch {
    result = {
      ...latestReport,
      status: 'stopped',
      phase,
      operationId: env.PILOT_ASSIGNMENT_OPERATION_ID,
      cause: 'INPUT_AUTH_DOOR_OR_READBACK_UNVERIFIED',
      qualification: 'not_asserted',
    };
  } finally {
    if (owner) {
      try {
        const r = await owner.auth.signOut({ scope: 'local' });
        ownerCleanup = r?.error ? 'unknown' : 'local_session_closed';
      } catch {
        ownerCleanup = 'unknown';
      }
    }
  }
  result ||= { status: 'stopped', phase };
  result.ownerCleanup = ownerCleanup;
  if (ownerCleanup === 'unknown') result.status = 'stopped';
  await persist(result);
  return result;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  assignmentMain().then(
    (r) => {
      if (
        ![
          'verified',
          'verified_with_preserved',
          'verified_batch_with_deferred',
          'prepared',
          'observed',
        ].includes(r.status)
      )
        process.exitCode = 1;
    },
    () => {
      console.error('Assignment Outcome Unverified');
      process.exitCode = 1;
    }
  );
