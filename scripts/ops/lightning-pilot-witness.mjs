/** One explicit private-pilot evidence operation. No activation, joins or funding. */
import { writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { resolvePilotTarget } from './lightning-pilot-targets.mjs';
import { PILOT, pilotServiceFetch } from './prepare-lightning-private-pilot.mjs';
import {
  assertPlayerPin,
  witnessPlayer,
  CONSENT_PLAYERS,
  WITNESS_PLAYERS,
} from './lightning-pilot-player.mjs';
import { witnessFinancial } from './lightning-pilot-financial.mjs';
import { witnessAdmission, ADMISSION_PLAYER } from './lightning-pilot-admission.mjs';
import { witnessLatencyWorkload } from './lightning-pilot-latency-workload.mjs';
import { witnessCycle } from './lightning-pilot-cycle.mjs';
import { witnessRecovery } from './lightning-pilot-recovery.mjs';
import { collectReplayBatch } from './lightning-pilot-replay-batch.mjs';
const FINANCIAL_MODES = Object.freeze({
  financial_top_up: 'top_up',
  financial_top_up_sitout: 'top_up',
  financial_cash_out: 'cash_out',
  financial_auto_top_up: 'auto_top_up',
  financial_stop_playing: 'stop_playing',
});
const CLUB = 'e14bc9f7-736d-425f-8f2c-e78305ebac1d';
const KEY = 'sb_publishable__41LpJpzrfrb3hSUpEaYCA_tF53bBJx';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export async function runPilotWitness(env = process.env, dependencies = {}) {
  const inputMode = env.PILOT_WITNESS_MODE;
  const action = Object.hasOwn(FINANCIAL_MODES, inputMode) ? FINANCIAL_MODES[inputMode] : null;
  const mode = action
    ? 'financial'
    : ['player', 'replay', 'cycle', 'recovery', 'latency', 'admission'].includes(inputMode)
      ? inputMode
      : 'invalid';
  const report = {
    mode,
    ...(action ? { inputMode, action, qualification: 'single_action_sample_only' } : {}),
    status: 'unknown',
    startedAt: new Date().toISOString(),
    cleanup: 'not_started',
  };
  let owner;
  try {
    const mode = report.mode,
      clusterId = env.PILOT_CLUSTER_ID;
    if (!UUID.test(clusterId) || mode === 'invalid') throw new Error();
    const pin = {
      clubId: CLUB,
      clusterId,
      playerId: env.PILOT_PLAYER_ID,
      poolSessionId: env.PILOT_POOL_SESSION_ID,
    };
    const consentInput = env.PILOT_ACCEPT_PLAYER_TERMS ?? 'false';
    if (
      !['true', 'false'].includes(consentInput) ||
      (consentInput === 'true' &&
        (!['player', 'admission'].includes(mode) || !CONSENT_PLAYERS.includes(pin.playerId)))
    )
      throw new Error();
    const acceptTerms = consentInput === 'true';
    const from = env.PILOT_FROM,
      to = env.PILOT_TO,
      cursor = env.PILOT_CURSOR || null;
    const maxBatch = Number(env.PILOT_BATCH || '100');
    if (mode !== 'replay') {
      if (mode === 'admission') {
        if (!WITNESS_PLAYERS.includes(pin.playerId)) throw new Error();
      } else assertPlayerPin(pin);
      if (['latency', 'financial'].includes(mode) && !WITNESS_PLAYERS.includes(pin.playerId))
        throw new Error();
      if (
        mode === 'recovery' &&
        (!WITNESS_PLAYERS.includes(pin.playerId) ||
          !UUID.test(env.PILOT_SECOND_POOL_SESSION_ID) ||
          env.PILOT_SECOND_POOL_SESSION_ID === pin.poolSessionId)
      )
        throw new Error();
    } else if (
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
    const firstTarget = await resolvePilotTarget(admin, clusterId, { active: mode !== 'replay' });
    if (mode !== 'replay') {
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
      const common = {
        admin,
        createClient,
        chromium,
        url: env.SUPABASE_URL,
        pin,
        timeoutMs: 240000,
      };
      if (mode === 'financial')
        report.result = await (dependencies.witnessFinancial ?? witnessFinancial)({
          ...common,
          action,
          pauseForTopUp: inputMode === 'financial_top_up_sitout',
        });
      else if (mode === 'admission')
        report.result = await (dependencies.witnessAdmission ?? witnessAdmission)({
          ...common,
          acceptTerms,
          withAdmittedSession: async ({ pin: admittedPin, remaining }) => {
            const result = await (dependencies.witnessPlayer ?? witnessPlayer)({
              ...common,
              pin: admittedPin,
              timeoutMs: Math.min(240000, remaining()),
              acceptTerms: false,
            });
            if (result?.status !== 'observed' || result?.cleanup !== 'local_session_closed')
              throw new Error('Admitted Player Witness Unverified');
            return result;
          },
        });
      else if (mode === 'player')
        report.result = await (dependencies.witnessPlayer ?? witnessPlayer)({
          ...common,
          acceptTerms,
        });
      else if (mode === 'latency')
        report.result = await (dependencies.witnessLatencyWorkload ?? witnessLatencyWorkload)(
          common
        );
      else if (mode === 'cycle')
        report.result = await (dependencies.witnessCycle ?? witnessCycle)({
          ...common,
          timebank: true,
          preaction: true,
        });
      else {
        const WebSocket = dependencies.WebSocket ?? (await import('ws')).default;
        const second = await admin
          .from('lightning_pool_session')
          .select('id,cluster_id,player_id,state,exited_at')
          .eq('id', env.PILOT_SECOND_POOL_SESSION_ID)
          .maybeSingle();
        if (
          second.error ||
          second.data?.id !== env.PILOT_SECOND_POOL_SESSION_ID ||
          second.data.player_id !== pin.playerId ||
          second.data.state !== 'active' ||
          second.data.exited_at !== null ||
          second.data.cluster_id === pin.clusterId
        )
          throw new Error('Second Own Pool Unverified');
        const otherTarget = await resolvePilotTarget(admin, second.data.cluster_id);
        if (otherTarget.target.templateName === firstTarget.target.templateName)
          throw new Error('Other Pilot Target Required');
        const secondPin = {
          ...pin,
          clusterId: second.data.cluster_id,
          poolSessionId: env.PILOT_SECOND_POOL_SESSION_ID,
        };
        assertPlayerPin(secondPin);
        report.result = await (dependencies.witnessRecovery ?? witnessRecovery)({
          ...common,
          WebSocket,
          pins: [pin, secondPin],
        });
      }
      if (
        mode === 'admission' &&
        (report.result?.playerWitness?.status !== 'observed' ||
          report.result?.playerWitness?.cleanup !== 'local_session_closed')
      )
        throw new Error('Admission Player Witness Unverified');
      const expectedCleanup =
        mode === 'recovery'
          ? 'local_sessions_and_browser_closed'
          : ['latency', 'admission', 'financial'].includes(mode)
            ? 'local_session_and_browser_closed'
            : 'local_session_closed';
      report.cleanup = report.result?.cleanup === expectedCleanup ? expectedCleanup : 'unknown';
      report.status =
        report.result?.status === 'observed' && report.cleanup === expectedCleanup
          ? 'observed'
          : 'unknown';
      if (mode === 'financial' && report.result?.action !== action) report.status = 'unknown';
      if (mode === 'latency') {
        report.qualification = 'not_asserted';
        report.status =
          report.result?.status === 'partial_observed' &&
          report.cleanup === expectedCleanup &&
          Number.isSafeInteger(report.result?.counts?.accepted) &&
          report.result.counts.accepted > 0
            ? 'partial_observed'
            : 'unknown';
      }
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
