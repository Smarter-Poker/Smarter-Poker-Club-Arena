/** One explicit private-pilot evidence operation. No activation, joins or funding. */
import { writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { PILOT, pilotServiceFetch } from './prepare-lightning-private-pilot.mjs';
import { assertPlayerPin, witnessPlayer } from './lightning-pilot-player.mjs';
import { collectReplayBatch } from './lightning-pilot-replay-batch.mjs';
const CLUB = 'e14bc9f7-736d-425f-8f2c-e78305ebac1d';
const CLUSTERS = ['babb43f1-368e-406f-a97a-a0d5013648b2', '3330ff9f-76ec-4487-b0c9-fc8ad8c2fdbb'];
const CONSENT_PLAYER = '0097309f-2864-4d09-b02b-56bca012a9c3';
const KEY = 'sb_publishable__41LpJpzrfrb3hSUpEaYCA_tF53bBJx';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export async function runPilotWitness(env = process.env, dependencies = {}) {
  const report = {
    mode: ['player', 'replay'].includes(env.PILOT_WITNESS_MODE)
      ? env.PILOT_WITNESS_MODE
      : 'invalid',
    status: 'unknown',
    startedAt: new Date().toISOString(),
    cleanup: 'not_started',
  };
  let owner;
  try {
    const mode = report.mode,
      clusterId = env.PILOT_CLUSTER_ID;
    if (!CLUSTERS.includes(clusterId) || mode === 'invalid') throw new Error();
    const pin = {
      clubId: CLUB,
      clusterId,
      playerId: env.PILOT_PLAYER_ID,
      poolSessionId: env.PILOT_POOL_SESSION_ID,
    };
    const consentInput = env.PILOT_ACCEPT_PLAYER_TERMS ?? 'false';
    if (
      !['true', 'false'].includes(consentInput) ||
      (consentInput === 'true' && (mode !== 'player' || pin.playerId !== CONSENT_PLAYER))
    )
      throw new Error();
    const acceptTerms = consentInput === 'true';
    const from = env.PILOT_FROM,
      to = env.PILOT_TO,
      cursor = env.PILOT_CURSOR || null;
    const maxBatch = Number(env.PILOT_BATCH || '100');
    if (mode === 'player') assertPlayerPin(pin);
    else if (
      !Number.isFinite(Date.parse(from)) ||
      !Number.isFinite(Date.parse(to)) ||
      Date.parse(from) >= Date.parse(to) ||
      Date.parse(to) > Date.now() ||
      (cursor !== null && !UUID.test(cursor)) ||
      !Number.isSafeInteger(maxBatch) ||
      maxBatch < 1 ||
      maxBatch > 1000
    )
      throw new Error();
    report.clusterId = clusterId;
    if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) throw new Error();
    const createClient =
      dependencies.createClient ?? (await import('@supabase/supabase-js')).createClient;
    const options = { auth: { persistSession: false, autoRefreshToken: false } };
    const admin = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
      ...options,
      global: { fetch: pilotServiceFetch(env.SUPABASE_SERVICE_ROLE_KEY) },
    });
    if (mode === 'player') {
      // Consent is required unless this exact owner-authorized pin uses the normal UI.
      const profile = await admin
        .from('profiles')
        .select('id,club_arena_tos_accepted_at')
        .eq('id', pin.playerId)
        .maybeSingle();
      if (
        profile.error ||
        profile.data?.id !== pin.playerId ||
        (!acceptTerms && !Number.isFinite(Date.parse(profile.data.club_arena_tos_accepted_at)))
      )
        throw new Error();
      const chromium = dependencies.chromium ?? (await import('@playwright/test')).chromium;
      report.result = await (dependencies.witnessPlayer ?? witnessPlayer)({
        admin,
        createClient,
        chromium,
        url: env.SUPABASE_URL,
        pin,
        timeoutMs: 240000,
        acceptTerms,
      });
      report.cleanup =
        report.result?.cleanup === 'local_session_closed' ? 'local_session_closed' : 'unknown';
      report.status =
        report.result?.status === 'observed' && report.cleanup === 'local_session_closed'
          ? 'observed'
          : 'unknown';
    } else {
      if (env.SP_EMAIL?.toLowerCase() !== PILOT.ownerEmail || !env.SP_PASS) throw new Error();
      owner = createClient(env.SUPABASE_URL, KEY, options);
      report.cleanup = 'pending';
      const login = await owner.auth.signInWithPassword({
        email: env.SP_EMAIL,
        password: env.SP_PASS,
      });
      const identity = await owner.auth.getUser();
      if (
        login.error ||
        identity.error ||
        login.data?.user?.id !== PILOT.ownerId ||
        login.data?.session?.user?.id !== PILOT.ownerId ||
        identity.data?.user?.id !== PILOT.ownerId
      )
        throw new Error();
      report.result = await (dependencies.collectReplayBatch ?? collectReplayBatch)({
        admin,
        player: owner,
        clusterId,
        from,
        to,
        cursor,
        maxBatch,
      });
      report.status = report.result?.status === 'known' ? 'known' : 'unknown';
    }
  } catch {
    report.status = 'unknown';
    report.errorCode = 'WITNESS_INPUT_AUTH_OR_EXECUTION_UNAVAILABLE';
  } finally {
    if (owner) {
      const out = await owner.auth.signOut({ scope: 'local' }).catch(() => ({ error: true }));
      report.cleanup = out?.error ? 'unknown' : 'local_session_closed';
      if (out?.error) report.status = 'unknown';
    }
    report.completedAt = new Date().toISOString();
    if (env.PILOT_WITNESS_REPORT_PATH)
      writeFileSync(env.PILOT_WITNESS_REPORT_PATH, JSON.stringify(report, null, 2) + '\n');
  }
  return report;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runPilotWitness().then(
    (r) => {
      console.log(JSON.stringify({ mode: r.mode, status: r.status, cleanup: r.cleanup }));
      if (r.status === 'unknown' || r.result?.verdict === 'batch_failed') process.exitCode = 1;
    },
    () => {
      console.error('Witness Report Persistence Failed');
      process.exitCode = 1;
    }
  );
}
