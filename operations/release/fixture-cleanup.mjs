import { missionHandState, recordMissionHandCleaned } from './run-fixture-state.mjs';
import { cleanupMissionFixtureHand } from './mission-fixture-hand.mjs';
import { writeFile, mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { certificateAuthority, controlledCertificate } from './certification-client.mjs';
import {
  requireCertificate as need,
  fixtureSlots,
  factDigest,
  sameFacts,
} from './component-certificate.mjs';
import { supabaseServerHeaders } from '../../scripts/ci/supabase-auth-headers.mjs';

// Same existing dependent-resource closure used by the native browser fixture
// helper. Every query is an exact reserved user ID; no age/prefix sweeping.
export const fixtureResources = Object.freeze([
  ['profiles', 'id'],
  ['users', 'id'],
  ['push_outbox', 'recipient_user_id'],
  ['notifications', 'actor_id'],
  ['chip_transactions', 'from_user_id'],
  ['chip_transactions', 'to_user_id'],
  ['audit_trail', 'actor_id'],
  ...[
    'daily_mission_operations',
    'daily_challenge_progress_events',
    'daily_challenge_event_outbox',
    'daily_challenge_milestone_claims',
    'daily_challenge_claim_batches',
    'daily_challenge_reroll_receipts',
    'daily_challenge_freeze_entitlements',
    'user_daily_challenges',
    'challenge_streak_state',
    'club_members',
    'user_notification_preferences',
    'notifications',
    'daily_challenge_dashboard_revisions',
    'wallet_credit_idempotency',
    'wallet_transactions',
    'wallets',
    'customization_operations',
    'user_theme_settings',
    'user_table_studio_preferences',
    'theme_asset_unlocks',
    'avatar_unlocks',
    'feature_purchases',
    'diamond_transactions',
    'diamond_wallets',
    'signup_errors',
    'table_waitlist',
    'rate_limits',
  ].map((table) => [table, 'user_id']),
]);
export async function cleanupCertificateFixtures({
  environment = process.env,
  fetchImpl = fetch,
  authority = certificateAuthority,
  wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
} = {}) {
  const request = controlledCertificate(environment);
  need(request && environment.SUPABASE_URL && environment.SUPABASE_SERVICE_ROLE_KEY);
  const barrier = await authority({ action: 'begin-cleanup' }, { environment });
  need(sameFacts(barrier.fixture_roster, request.fixture_roster));
  const accounts = {};
  const headers = supabaseServerHeaders(environment.SUPABASE_SERVICE_ROLE_KEY, {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-cache',
    Accept: 'application/json',
  });
  async function fetchAt(route, options = {}) {
    return fetchImpl(`${environment.SUPABASE_URL.replace(/\/$/, '')}${route}`, {
      ...options,
      headers,
      redirect: 'error',
      signal: AbortSignal.timeout(20000),
    });
  }
  // Exact-run durable hand intent survives a worker timeout. Missing original
  // records during a later recovery cannot resolve an absent ambiguous insert.
  let handState;
  try {
    handState = await missionHandState(request.fixture_roster.missions.user_id, environment);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    // An original run can fail before the missions worker starts. An absent
    // Auth identity then still passes the journal's independent creation-outcome
    // gate below; a later recovery cannot infer this from its new filesystem.
    const auth = await fetchAt(`/auth/v1/admin/users/${request.fixture_roster.missions.user_id}`);
    handState = {
      resolved: !environment.RELEASE_CLEANUP_RECOVERY && auth.status === 404,
      missing: true,
    };
  }
  const missionHand = await cleanupMissionFixtureHand(
    request.fixture_roster.missions,
    async (route, options = {}) => {
      const response = await fetchAt(route, options);
      need(response.ok, 'RELEASE_MISSION_HAND_CLEANUP_REFUSED');
      return response.status === 204 ? null : response.json();
    },
    handState.resolved
  );
  if (!handState.missing)
    await recordMissionHandCleaned(request.fixture_roster.missions.user_id, environment);
  for (const slot of fixtureSlots) {
    const account = request.fixture_roster[slot];
    let auth = await fetchAt(`/auth/v1/admin/users/${account.user_id}`);
    if (auth.status === 200) {
      const found = await auth.json(),
        user = found.user ?? found;
      need(
        user.id === account.user_id && user.email === account.email,
        'RELEASE_FIXTURE_IDENTITY_MISMATCH'
      );
      // A committed exact GET resolves a lost create response. A 404 cannot
      // resolve an ambiguous create and is never promoted by this branch.
      await authority(
        { action: 'creation-result', slot, proof: { ...account, outcome: 'CREATED' } },
        { environment }
      );
      for (let attempt = 0; attempt < 37; attempt++) {
        const response = await fetchAt('/rest/v1/rpc/cleanup_reserved_certification_account', {
          method: 'POST',
          body: JSON.stringify({ p_user_id: account.user_id }),
        });
        need(response.ok, 'RELEASE_GUARDED_FIXTURE_CLEANUP_REFUSED');
        const result = await response.json();
        if (result.success === true) break;
        need(
          result.reason === 'platform_is_frozen' && attempt < 36,
          'RELEASE_GUARDED_FIXTURE_CLEANUP_REFUSED'
        );
        await wait(10000);
      }
      auth = await fetchAt(`/auth/v1/admin/users/${account.user_id}`);
    }
    need(auth.status === 404, 'RELEASE_FIXTURE_AUTH_ABSENCE_REQUIRED');
    try {
      const creation = JSON.parse(
        await readFile(
          path.join(
            environment.RUNNER_TEMP,
            'release-certificate',
            'fixture-claims',
            `${slot}.created.json`
          ),
          'utf8'
        )
      );
      need(
        creation.user_id === account.user_id &&
          creation.email === account.email &&
          creation.outcome === 'CREATED'
      );
      await authority({ action: 'creation-result', slot, proof: creation }, { environment });
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    const observed = [];
    for (const [table, column] of fixtureResources) {
      const response = await fetchAt(
        `/rest/v1/${table}?${new URLSearchParams({
          select: column,
          [column]: `eq.${account.user_id}`,
          limit: '1',
        })}`
      );
      need(response.ok, 'RELEASE_FIXTURE_RESOURCE_READBACK_REQUIRED');
      const rows = await response.json();
      need(Array.isArray(rows) && rows.length === 0, 'RELEASE_FIXTURE_RESOURCE_ABSENCE_REQUIRED');
      observed.push({ table, column, rows: 0 });
    }
    accounts[slot] = {
      ...account,
      auth_absent: true,
      resources_absent: true,
      evidence_sha256: factDigest({
        user_id: account.user_id,
        auth_status: 404,
        resources: observed,
        ...(slot === 'missions' ? { mission_hand: missionHand } : {}),
      }),
    };
  }
  const proof = {
    operation_id: environment.RELEASE_CERTIFICATE_OPERATION,
    run_id: environment.GITHUB_RUN_ID,
    run_attempt: 1,
    accounts,
  };
  const receipt = await authority({ action: 'cleanup-complete', proof }, { environment });
  need(typeof receipt.cleanup_receipt === 'string');
  const directory = path.join(environment.RUNNER_TEMP, 'release-certificate');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const result = { ...proof, cleanup_receipt: receipt.cleanup_receipt };
  await writeFile(path.join(directory, 'cleanup.json'), JSON.stringify(result), { mode: 0o600 });
  return result;
}
