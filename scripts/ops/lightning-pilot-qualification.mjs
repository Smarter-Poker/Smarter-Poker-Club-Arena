/** Explicit, read-only private-pilot evidence collection. Never enables, seats,
 * funds, synthesizes play, installs, publishes, or issues a launch certificate. */
import { writeFileSync } from 'node:fs';
import { collectReplaySample } from './lightning-pilot-replay-sample.mjs';
import { pathToFileURL } from 'node:url';
import {
  PILOT,
  PILOT_TARGETS as PREPARATION_TARGETS,
  pilotServiceFetch,
} from './prepare-lightning-private-pilot.mjs';

export const PILOT_TARGETS = Object.freeze(
  PREPARATION_TARGETS.map((target) =>
    Object.freeze({
      name: target.gameName,
      handedness: target.handedness,
      sb: target.sb,
      bb: target.bb,
    })
  )
);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SHA = /^[0-9a-f]{40}$/i;
const PROJECT_URL = 'https://kuklfnapbkmacvwxktbh.supabase.co';
const PUBLIC_KEY = 'sb_publishable__41LpJpzrfrb3hSUpEaYCA_tF53bBJx';
const known = (source, data) => ({ status: 'known', source, data });
const unknown = (source, errorCode = 'UNAVAILABLE') => ({ status: 'unknown', source, errorCode });
const object = (v) => v && typeof v === 'object' && !Array.isArray(v);
const count = (v) => Number.isSafeInteger(v) && v >= 0;
const stake = (v) =>
  (typeof v === 'number' || (typeof v === 'string' && v.trim() !== '')) &&
  Number.isFinite(Number(v))
    ? Number(v)
    : null;
const errorCode = (v) => (/^[A-Z0-9_-]{1,40}$/i.test(v?.code ?? '') ? v.code : 'READ_UNAVAILABLE');

export async function observe(source, operation, accept = () => true) {
  try {
    const result = await operation();
    if (result?.error) return unknown(source, errorCode(result.error));
    if (!accept(result?.data)) return unknown(source, 'INVALID_READBACK');
    return known(source, result.data);
  } catch (error) {
    return unknown(source, errorCode(error));
  }
}
async function observeCount(source, operation) {
  return observe(
    source,
    async () => {
      const r = await operation();
      return { error: r.error, data: r.count };
    },
    count
  );
}
async function publicJson(url, fetchImpl, accept, project) {
  return observe(
    url,
    async () => {
      const freshUrl = new URL(url);
      freshUrl.searchParams.set('qualification', new Date().toISOString());
      const r = await fetchImpl(freshUrl.href, {
        cache: 'no-store',
        signal: AbortSignal.timeout(15000),
      });
      if (!r.ok) return { error: { code: `HTTP_${r.status}` } };
      const raw = await r.json();
      return { data: accept(raw) ? project(raw) : null };
    },
    object
  );
}
export async function servingIdentities(fetchImpl = fetch) {
  const stamp = (r) => object(r) && SHA.test(r.ca_sha ?? '');
  const client = (r) => ({
    revision: r.ca_sha,
    runId: /^[0-9]{1,20}$/.test(String(r.github_run_id ?? r.run_id ?? ''))
      ? String(r.github_run_id ?? r.run_id)
      : null,
    builtAt:
      typeof r.built_at === 'string' && Number.isFinite(Date.parse(r.built_at)) ? r.built_at : null,
  });
  const health = (r) =>
    object(r) &&
    typeof r.version === 'string' &&
    /^[0-9a-f]{7,40}$/i.test(r.version) &&
    (!Object.hasOwn(r, 'releaseSha') ||
      (typeof r.releaseSha === 'string' && SHA.test(r.releaseSha) && r.releaseSha.startsWith(r.version)));
  const [origin, publicClient, engine] = await Promise.all([
    publicJson('https://ca-static.smarter.poker/build-info.json', fetchImpl, stamp, client),
    publicJson('https://smarter.poker/hub/club-arena/build-info.json', fetchImpl, stamp, client),
    publicJson('https://engine.smarter.poker/health', fetchImpl, health, (r) => ({
      reportedVersion: r.releaseSha ?? r.version,
      status: r.status === 'ok' ? 'ok' : 'not_ok',
      fullRevisionEstablished: SHA.test(r.releaseSha ?? r.version),
    })),
  ]);
  return { origin, publicClient, engine };
}
export function servingStable(before, after) {
  const reads = ['origin', 'publicClient', 'engine'];
  if (reads.some((key) => before[key]?.status !== 'known' || after[key]?.status !== 'known'))
    return 'unknown';
  if (
    before.origin.data.revision !== before.publicClient.data.revision ||
    after.origin.data.revision !== after.publicClient.data.revision
  )
    return 'failed';
  if (
    before.origin.data.revision !== after.origin.data.revision ||
    before.engine.data.reportedVersion !== after.engine.data.reportedVersion ||
    before.engine.data.status !== 'ok' ||
    after.engine.data.status !== 'ok'
  )
    return 'failed';
  return 'passed';
}
export function selectTargets(games, clubId) {
  if (!Array.isArray(games) || games.some((g) => g.club_id !== clubId))
    throw Object.assign(new Error(), { code: 'INVALID_GAME_SCOPE' });
  return PILOT_TARGETS.map((target) => {
    const found = games.filter((g) => g.name === target.name);
    if (found.length !== 1)
      return {
        ...target,
        observation: unknown(
          'cash_games',
          found.length ? 'AMBIGUOUS_TARGET' : 'TARGET_NOT_PREPARED'
        ),
      };
    const g = found[0];
    if (
      !UUID.test(g.id ?? '') ||
      g.union_id ||
      g.variant !== 'nlh' ||
      g.template_name !== 'classic' ||
      stake(g.sb) !== target.sb ||
      stake(g.bb) !== target.bb ||
      g.handedness !== target.handedness ||
      g.must_move !== true ||
      g.ruleset_snapshot?.options?.is_private !== true
    ) {
      return {
        ...target,
        observation: unknown('cash_games', 'TARGET_IDENTITY_OR_ISOLATION_MISMATCH'),
      };
    }
    return {
      ...target,
      observation: known('cash_games', {
        id: g.id,
        clubId,
        handedness: g.handedness,
        templateName: 'classic',
        sb: target.sb,
        bb: target.bb,
        lightningEnabled: typeof g.lightning_enabled === 'boolean' ? g.lightning_enabled : null,
        mode:
          typeof g.cluster_mode === 'string' && /^[a-z_]{1,30}$/.test(g.cluster_mode)
            ? g.cluster_mode
            : null,
      }),
    };
  });
}
function safeReadiness(raw) {
  if (
    !object(raw) ||
    raw.ok !== true ||
    !['go', 'no_go', 'insufficient_evidence'].includes(raw.verdict) ||
    !Array.isArray(raw.reasons)
  )
    return null;
  return {
    clusterId: raw.cluster_id,
    verdict: raw.verdict,
    asOf: raw.as_of ?? null,
    reasons: raw.reasons.map((r) => ({
      code: /^[A-Z0-9_]{1,80}$/.test(r?.code ?? '') ? r.code : 'UNKNOWN_REASON',
      severity: ['blocking', 'evidence'].includes(r?.severity) ? r.severity : null,
    })),
    liveEligible: count(raw.evidence?.cluster?.live_eligible)
      ? raw.evidence.cluster.live_eligible
      : null,
    onThreshold: count(raw.evidence?.cluster?.on_threshold)
      ? raw.evidence.cluster.on_threshold
      : null,
    aaCalibration: ['calibrated', 'calibration_bias', 'insufficient_evidence'].includes(
      raw.evidence?.shadow?.aa_calibration?.verdict
    )
      ? raw.evidence.shadow.aa_calibration.verdict
      : null,
  };
}
function safeConfig(raw) {
  if (
    !object(raw) ||
    raw.ok !== true ||
    !['off', 'shadow', 'form'].includes(raw.worker_mode) ||
    !count(raw.shadow_window_ms) ||
    raw.shadow_window_ms < 60000 ||
    raw.shadow_window_ms > 3600000 ||
    typeof raw.integrity_telemetry !== 'boolean' ||
    typeof raw.matcher_version !== 'string' ||
    !/^[a-z0-9-]{1,30}$/.test(raw.matcher_version)
  )
    return null;
  return {
    workerMode: ['off', 'shadow', 'form'].includes(raw.worker_mode) ? raw.worker_mode : null,
    shadowWindowMs: count(raw.shadow_window_ms) ? raw.shadow_window_ms : null,
    integrityTelemetry:
      typeof raw.integrity_telemetry === 'boolean' ? raw.integrity_telemetry : null,
    matcherVersion:
      typeof raw.matcher_version === 'string' && /^[a-z0-9-]{1,30}$/.test(raw.matcher_version)
        ? raw.matcher_version
        : null,
  };
}
/** Populated Must-Move Clusters whose existing members already play there.
 * The private pilot club cannot hold horses (the house-board membership law),
 * so populated house-board Clusters are the only legitimate place where both
 * activation thresholds can be crossed without inventing identities. This
 * section only observes them; it never enables, seats or funds anything. */
export const MAX_POPULATED_TARGETS = 4;
export function parsePopulatedClusterIds(raw) {
  if (raw === null || raw === undefined || String(raw).trim() === '') return [];
  const ids = [
    ...new Set(
      String(raw)
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
    ),
  ];
  if (ids.length > MAX_POPULATED_TARGETS || ids.some((id) => !UUID.test(id)))
    throw Object.assign(new Error(), { code: 'INVALID_POPULATED_CLUSTER_IDS' });
  return ids;
}
export async function collectPopulatedTargets({ admin, player, clusterIds }) {
  const results = [];
  for (const clusterId of clusterIds) {
    const target = { clusterId, scope: 'populated_cluster_observation_only' };
    target.game = await observe(
      'cash_games:populated_cluster',
      () =>
        admin
          .from('cash_games')
          .select(
            'id,club_id,name,variant,handedness,must_move,enabled,closed_at,lightning_enabled,cluster_mode'
          )
          .eq('id', clusterId)
          .maybeSingle(),
      (v) =>
        object(v) &&
        v.id === clusterId &&
        UUID.test(v.club_id ?? '') &&
        v.must_move === true &&
        v.enabled === true &&
        !v.closed_at &&
        (v.handedness === 6 || v.handedness === 9)
    );
    if (target.game.status !== 'known') {
      results.push(target);
      continue;
    }
    const g = target.game.data;
    target.game = known(target.game.source, {
      id: g.id,
      clubId: g.club_id,
      name: typeof g.name === 'string' ? g.name.slice(0, 80) : null,
      variant:
        typeof g.variant === 'string' && /^[a-z0-9_]{1,20}$/.test(g.variant) ? g.variant : null,
      handedness: g.handedness,
      lightningEnabled: typeof g.lightning_enabled === 'boolean' ? g.lightning_enabled : null,
      mode:
        typeof g.cluster_mode === 'string' && /^[a-z_]{1,30}$/.test(g.cluster_mode)
          ? g.cluster_mode
          : null,
    });
    const tables = await observe(
      'tables:populated_cluster_scope',
      () =>
        admin
          .from('tables')
          .select('id', { count: 'exact' })
          .eq('cluster_id', clusterId)
          .eq('is_deleted', false)
          .then((r) => ({
            error: r.error,
            data: Array.isArray(r.data) && r.count === r.data.length ? r.data : null,
          })),
      (v) => Array.isArray(v) && v.every((t) => UUID.test(t?.id ?? ''))
    );
    target.tables = tables.status === 'known' ? known(tables.source, tables.data.length) : tables;
    target.seatedParticipants =
      tables.status !== 'known'
        ? unknown('table_seats:active_in_cluster', 'TABLE_SCOPE_UNKNOWN')
        : tables.data.length === 0
          ? known('table_seats:active_in_cluster', 0)
          : await observeCount('table_seats:active_in_cluster', () =>
              admin
                .from('table_seats')
                .select('id', { count: 'exact', head: true })
                .in(
                  'table_id',
                  tables.data.map((t) => t.id)
                )
                .is('left_at', null)
            );
    target.config = await observe(
      'fn_lightning_config',
      async () => {
        const r = await admin.rpc('fn_lightning_config', { p_cluster_id: clusterId });
        return { error: r.error, data: safeConfig(r.data) };
      },
      object
    );
    target.readiness = await observe(
      'fn_lightning_rollout_readiness:authenticated_service',
      async () => {
        const r = await player.rpc('fn_lightning_rollout_readiness', { p_cluster_id: clusterId });
        const data = safeReadiness(r.data);
        return { error: r.error, data: data?.clusterId === clusterId ? data : null };
      },
      object
    );
    const seated =
      target.seatedParticipants.status === 'known' ? target.seatedParticipants.data : null;
    const onThreshold =
      target.readiness.status === 'known' ? target.readiness.data.onThreshold : null;
    target.activationPopulation =
      seated === null || onThreshold === null
        ? 'unknown'
        : seated >= onThreshold
          ? 'at_or_above_on_threshold'
          : 'below_on_threshold';
    results.push(target);
  }
  return results;
}

export async function collectQualification({
  admin,
  player,
  fetchImpl = fetch,
  outsiderId = null,
  from = null,
  populatedClusterIds = [],
  now = () => new Date(),
}) {
  if (outsiderId !== null && !UUID.test(outsiderId))
    throw Object.assign(new Error(), { code: 'INVALID_DESIGNATED_OUTSIDER' });
  const observedAt = now().toISOString();
  const servingBefore = await servingIdentities(fetchImpl);
  const creation = await observe(
    'club_creation_requests:stable_creation_request',
    () =>
      admin
        .from('club_creation_requests')
        .select('club_id')
        .eq('user_id', PILOT.ownerId)
        .eq('request_id', PILOT.requestId)
        .maybeSingle(),
    (v) => object(v) && UUID.test(v.club_id ?? '')
  );
  const report = {
    schemaVersion: 1,
    observedAt,
    scope: 'internal_private_pilot_only',
    serviceOwnerId: PILOT.ownerId,
    creation:
      creation.status === 'known'
        ? known(creation.source, { club_id: creation.data.club_id })
        : creation,
    club: unknown('clubs', 'CLUB_NOT_ESTABLISHED'),
    roster: unknown('club_members', 'CLUB_NOT_ESTABLISHED'),
    targets: [],
    servingBefore,
    servingAfter: null,
    servingIdentityStable: 'unknown',
    publicLaunch: 'NOT_CERTIFIED',
    releaseGates: { total: 54, certifiedByThisReport: 0, verdict: 'NOT_EVALUATED' },
    limitations: [
      'Database access decisions do not prove an authenticated outsider browser or WebSocket test.',
      'Recorded hand counts are scoped database observations, not proof of every gameplay or financial gate.',
      'Readiness go is a per-cluster configuration verdict, not a public launch certificate.',
      'Calendar waiting is not a requirement.',
      'Populated Cluster observations describe existing play only; they never enable, seat or fund anyone.',
    ],
  };
  if (creation.status === 'known') {
    const clubId = creation.data.club_id;
    report.club = await observe(
      'clubs:pilot_identity',
      () =>
        admin
          .from('clubs')
          .select('id,name,owner_id,is_public,requires_approval,union_id,created_at')
          .eq('id', clubId)
          .maybeSingle(),
      (v) =>
        object(v) &&
        v.id === clubId &&
        v.owner_id === PILOT.ownerId &&
        v.name === PILOT.name &&
        v.is_public === false &&
        v.requires_approval === true &&
        !v.union_id
    );
    if (report.club.status === 'known') {
      const start = from ?? report.club.data.created_at;
      if (
        typeof start !== 'string' ||
        !Number.isFinite(Date.parse(start)) ||
        Date.parse(start) >= Date.parse(observedAt) ||
        Date.parse(start) < Date.parse(observedAt) - 90 * 86400000
      )
        throw Object.assign(new Error(), { code: 'INVALID_REPORT_WINDOW' });
      report.window = {
        from: new Date(start).toISOString(),
        to: observedAt,
        scope: 'formed_hands_with_settlement_and_history_in_this_pilot',
      };
      const members = await observe(
        'club_members:pilot_roster',
        () =>
          admin
            .from('club_members')
            .select('user_id,status,chip_balance', { count: 'exact' })
            .eq('club_id', clubId)
            .then((r) => ({
              error: r.error,
              data: Array.isArray(r.data) && r.count === r.data.length ? r.data : null,
            })),
        Array.isArray
      );
      if (members.status === 'known') {
        report.roster = known(members.source, {
          members: members.data.length,
          activeMembers: members.data.filter((m) => m.status === 'active').length,
          fundedActiveMembers: members.data.every(
            (m) =>
              (typeof m.chip_balance === 'number' ||
                (typeof m.chip_balance === 'string' && m.chip_balance.trim() !== '')) &&
              Number.isFinite(Number(m.chip_balance))
          )
            ? members.data.filter((m) => m.status === 'active' && Number(m.chip_balance) > 0).length
            : null,
        });
      } else report.roster = members;
      const games = await observe(
        'cash_games:pilot_targets',
        () =>
          admin
            .from('cash_games')
            .select(
              'id,club_id,union_id,name,template_name,variant,sb,bb,handedness,must_move,lightning_enabled,cluster_mode,ruleset_snapshot',
              { count: 'exact' }
            )
            .eq('club_id', clubId)
            .then((r) => ({
              error: r.error,
              data: Array.isArray(r.data) && r.count === r.data.length ? r.data : null,
            })),
        Array.isArray
      );
      report.targets =
        games.status === 'known'
          ? selectTargets(games.data, clubId)
          : PILOT_TARGETS.map((t) => ({ ...t, observation: games }));
      let designated = unknown(
        'profiles/club_members:designated_outsider',
        'NO_DESIGNATED_OUTSIDER'
      );
      if (outsiderId) {
        const profile = await observe(
          'profiles:designated_outsider',
          () => admin.from('profiles').select('id,status').eq('id', outsiderId).maybeSingle(),
          (v) => object(v) && v.id === outsiderId && v.status === 'active'
        );
        const membership = await observe(
          'club_members:designated_outsider',
          () =>
            admin
              .from('club_members')
              .select('user_id,status')
              .eq('club_id', clubId)
              .eq('user_id', outsiderId)
              .maybeSingle(),
          (v) => v === null || object(v)
        );
        if (
          profile.status === 'known' &&
          membership.status === 'known' &&
          membership.data === null &&
          outsiderId !== PILOT.ownerId
        )
          designated = known('profiles/club_members:designated_outsider', { id: outsiderId });
        else
          designated = unknown(
            'profiles/club_members:designated_outsider',
            'OUTSIDER_NOT_ESTABLISHED'
          );
      }
      for (const target of report.targets) {
        if (target.observation.status !== 'known') continue;
        const clusterId = target.observation.data.id;
        target.config = await observe(
          'fn_lightning_config',
          async () => {
            const r = await admin.rpc('fn_lightning_config', { p_cluster_id: clusterId });
            return { error: r.error, data: safeConfig(r.data) };
          },
          object
        );
        target.readiness = await observe(
          'fn_lightning_rollout_readiness:authenticated_service',
          async () => {
            const r = await player.rpc('fn_lightning_rollout_readiness', {
              p_cluster_id: clusterId,
            });
            const data = safeReadiness(r.data);
            return { error: r.error, data: data?.clusterId === clusterId ? data : null };
          },
          object
        );
        target.completedRecordedHands = await observeCount(
          'lightning_hand:formed_window/settled/history',
          () =>
            admin
              .from('lightning_hand')
              .select('hand_id', { count: 'exact', head: true })
              .eq('cluster_id', clusterId)
              .gte('formed_at', report.window.from)
              .lte('formed_at', report.window.to)
              .not('settled_at', 'is', null)
              .not('hand_history_id', 'is', null)
        );
        target.replaySample = await collectReplaySample({
          admin,
          player,
          clusterId,
          from: report.window.from,
          to: report.window.to,
        });
        target.poolSessions = await observeCount('lightning_pool_session:entered_window', () =>
          admin
            .from('lightning_pool_session')
            .select('id', { count: 'exact', head: true })
            .eq('cluster_id', clusterId)
            .gte('entered_at', report.window.from)
            .lte('entered_at', report.window.to)
        );
        target.configurationAuditEvents = await observeCount(
          'cash_cluster_events:configuration_actions/window',
          () =>
            admin
              .from('cash_cluster_events')
              .select('id', { count: 'exact', head: true })
              .eq('game_id', clusterId)
              .in('kind', ['operator_set_shadow_window', 'operator_set_integrity_telemetry'])
              .gte('at', report.window.from)
              .lte('at', report.window.to)
        );
        target.telemetry = await observe(
          'fn_lightning_operator_cluster:bounded_window',
          async () => {
            const r = await player.rpc('fn_lightning_operator_cluster', {
              p_cluster_id: clusterId,
              p_from: report.window.from,
              p_to: report.window.to,
            });
            if (r.data?.ok !== true || r.data.cluster_id !== clusterId)
              return { error: r.error, data: null };
            return {
              error: r.error,
              data: {
                from: r.data.from,
                to: r.data.to,
                windowClamped: r.data.window_clamped === true,
                latencyWindowsReturned: Array.isArray(r.data.latency_windows)
                  ? r.data.latency_windows.length
                  : null,
                latencyWindowLimit: 60,
                shadowVersionPairs: Array.isArray(r.data.shadow_report?.version_pairs)
                  ? r.data.shadow_report.version_pairs.map((p) => ({
                      live:
                        typeof p.live_matcher_version === 'string' &&
                        /^[a-z0-9-]{1,30}$/.test(p.live_matcher_version)
                          ? p.live_matcher_version
                          : null,
                      candidate:
                        typeof p.shadow_matcher_version === 'string' &&
                        /^[a-z0-9-]{1,30}$/.test(p.shadow_matcher_version)
                          ? p.shadow_matcher_version
                          : null,
                      verdict: [
                        'insufficient_evidence',
                        'calibrated',
                        'calibration_bias',
                        'better',
                        'worse',
                        'no_significant_difference',
                      ].includes(p.verdict)
                        ? p.verdict
                        : null,
                      windows: count(p.windows) ? p.windows : null,
                      scoredWindows: count(p.n) ? p.n : null,
                      aaCalibration: p.aa_calibration === true,
                    }))
                  : null,
              },
            };
          },
          object
        );
        const tables = await observe(
          'tables:nondeleted_pilot_scope',
          () =>
            admin
              .from('tables')
              .select('id,is_private,max_players', { count: 'exact' })
              .eq('cluster_id', clusterId)
              .eq('is_deleted', false)
              .then((r) => ({
                error: r.error,
                data: Array.isArray(r.data) && r.count === r.data.length ? r.data : null,
              })),
          Array.isArray
        );
        const tableObservation =
          tables.status === 'known'
            ? known(
                tables.source,
                tables.data.map((t) => ({
                  id: UUID.test(t.id ?? '') ? t.id : null,
                  is_private: typeof t.is_private === 'boolean' ? t.is_private : null,
                  max_players: count(t.max_players) ? t.max_players : null,
                }))
              )
            : tables;
        target.databaseAccess = {
          tables: tableObservation,
          designatedOutsider: designated,
          owner: [],
          outsider: [],
          authenticatedBrowserAndSocket: 'NOT_PROVED',
        };
        if (tables.status === 'known')
          for (const table of tables.data) {
            if (!UUID.test(table.id ?? '')) continue;
            const readAccess = (userId) =>
              observe(
                'fn_ca_engine_table_connection_access:database_decision',
                () =>
                  admin
                    .rpc('fn_ca_engine_table_connection_access', {
                      p_table_id: table.id,
                      p_user_id: userId,
                    })
                    .then((r) => ({
                      error: r.error,
                      data:
                        object(r.data) &&
                        r.data.table_id === table.id &&
                        r.data.user_id === userId &&
                        typeof r.data.allowed === 'boolean'
                          ? {
                              tableId: table.id,
                              allowed: r.data.allowed,
                              reason: /^[a-z_]{1,60}$/.test(r.data.reason ?? '')
                                ? r.data.reason
                                : null,
                            }
                          : null,
                    })),
                object
              );
            target.databaseAccess.owner.push(await readAccess(PILOT.ownerId));
            if (designated.status === 'known')
              target.databaseAccess.outsider.push(await readAccess(outsiderId));
          }
      }
      // Publish only the confirmed identity/isolation fields, never arbitrary club data.
      report.club = known(report.club.source, {
        id: clubId,
        ownerId: PILOT.ownerId,
        private: true,
        requiresApproval: true,
      });
    }
  }
  report.populatedTargets = await collectPopulatedTargets({
    admin,
    player,
    clusterIds: populatedClusterIds,
  });
  report.servingAfter = await servingIdentities(fetchImpl);
  report.servingIdentityStable = servingStable(report.servingBefore, report.servingAfter);
  report.completedAt = now().toISOString();
  report.consistency = 'Independent Read Observations; Not An Atomic Database Snapshot';
  report.blockers = [
    ...(report.club.status !== 'known' ? ['PILOT_CLUB_NOT_ESTABLISHED'] : []),
    ...report.targets
      .filter((t) => t.observation.status !== 'known')
      .map((t) => `${t.handedness}_MAX_TARGET_NOT_ESTABLISHED`),
    ...report.targets.flatMap((t) => {
      if (t.observation.status !== 'known') return [];
      const blockers = [];
      if (t.config?.status !== 'known') blockers.push('PILOT_CONFIGURATION_UNKNOWN');
      if (t.completedRecordedHands?.status !== 'known')
        blockers.push('RECORDED_HAND_COVERAGE_UNKNOWN');
      else if (t.completedRecordedHands.data === 0)
        blockers.push('NO_RECORDED_SETTLED_LIGHTNING_HANDS');
      if (t.replaySample?.status !== 'known') blockers.push('REPLAY_SAMPLE_UNKNOWN');
      else if (t.replaySample.data.verdict === 'sample_failed')
        blockers.push('REPLAY_SAMPLE_FAILED');
      else if (t.replaySample.data.verdict === 'no_samples') blockers.push('REPLAY_SAMPLE_MISSING');
      if (t.poolSessions?.status !== 'known') blockers.push('POOL_SESSION_COVERAGE_UNKNOWN');
      if (t.configurationAuditEvents?.status !== 'known')
        blockers.push('CONFIGURATION_AUDIT_UNKNOWN');
      if (t.telemetry?.status !== 'known') blockers.push('TELEMETRY_EVIDENCE_UNKNOWN');
      const a = t.databaseAccess;
      if (a?.tables?.status !== 'known') blockers.push('PRIVATE_TABLE_SCOPE_UNKNOWN');
      else if (a.tables.data.length === 0) blockers.push('PRIVATE_PILOT_TABLES_NOT_ESTABLISHED');
      else {
        if (
          a.tables.data.some(
            (table) => !table.id || table.is_private !== true || table.max_players !== t.handedness
          )
        )
          blockers.push('PRIVATE_TABLE_IDENTITY_OR_ISOLATION_MISMATCH');
        if (
          a.owner.length !== a.tables.data.length ||
          a.owner.some((read) => read.status !== 'known')
        )
          blockers.push('OWNER_DATABASE_ACCESS_UNKNOWN');
        else if (a.owner.some((read) => read.data.allowed !== true))
          blockers.push('OWNER_DATABASE_ACCESS_REFUSED');
        if (a.designatedOutsider.status !== 'known')
          blockers.push('DESIGNATED_OUTSIDER_NOT_ESTABLISHED');
        else if (
          a.outsider.length !== a.tables.data.length ||
          a.outsider.some((read) => read.status !== 'known')
        )
          blockers.push('OUTSIDER_DATABASE_ACCESS_UNKNOWN');
        else if (a.outsider.some((read) => read.data.allowed !== false))
          blockers.push('OUTSIDER_DATABASE_ACCESS_ALLOWED');
      }
      return blockers;
    }),
    ...report.targets.flatMap((t) =>
      t.readiness?.status === 'known'
        ? t.readiness.data.reasons.map((r) => r.code)
        : ['READINESS_UNKNOWN']
    ),
    ...(report.roster.status !== 'known'
      ? ['ROSTER_UNKNOWN']
      : report.roster.data.activeMembers < 2
        ? ['PARTICIPANTS_NOT_ESTABLISHED']
        : []),
    ...(report.servingIdentityStable !== 'passed' ? ['SERVING_IDENTITY_UNKNOWN_OR_CHANGED'] : []),
    ...(report.servingAfter.engine.status !== 'known' ||
    report.servingAfter.engine.data.fullRevisionEstablished !== true
      ? ['ENGINE_FULL_REVISION_NOT_ESTABLISHED']
      : []),
    'AUTHENTICATED_OUTSIDER_BROWSER_AND_SOCKET_PROOF_REQUIRED',
    'ALL_54_RELEASE_GATES_NOT_CERTIFIED',
  ];
  report.blockers = [...new Set(report.blockers)];
  return report;
}

export async function runQualification(env = process.env) {
  if (
    env.SUPABASE_URL !== PROJECT_URL ||
    env.SP_EMAIL?.toLowerCase() !== PILOT.ownerEmail ||
    !env.SP_PASS ||
    !env.SUPABASE_SERVICE_ROLE_KEY
  )
    throw Object.assign(new Error(), { code: 'VERIFIED_SERVICE_CONFIGURATION_REQUIRED' });
  const populatedClusterIds = parsePopulatedClusterIds(env.PILOT_POPULATED_CLUSTER_IDS);
  const { createClient } = await import('@supabase/supabase-js');
  const options = { auth: { persistSession: false, autoRefreshToken: false } };
  const admin = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
    ...options,
    global: { fetch: pilotServiceFetch(env.SUPABASE_SERVICE_ROLE_KEY) },
  });
  const player = createClient(env.SUPABASE_URL, PUBLIC_KEY, options);
  try {
    const login = await player.auth.signInWithPassword({
      email: env.SP_EMAIL,
      password: env.SP_PASS,
    });
    if (
      login.error ||
      login.data?.user?.id !== PILOT.ownerId ||
      login.data?.session?.user?.id !== PILOT.ownerId ||
      typeof login.data?.session?.access_token !== 'string' ||
      !login.data.session.access_token
    )
      throw Object.assign(new Error(), { code: 'SERVICE_AUTHENTICATION_FAILED' });
    const profile = await admin
      .from('profiles')
      .select('id,role,status,is_horse')
      .eq('id', PILOT.ownerId)
      .maybeSingle();
    if (
      profile.error ||
      profile.data?.id !== PILOT.ownerId ||
      profile.data?.role !== 'god' ||
      profile.data.status !== 'active' ||
      profile.data.is_horse === true
    )
      throw Object.assign(new Error(), { code: 'SERVICE_AUTHORITY_MISMATCH' });
    const report = await collectQualification({
      admin,
      player,
      outsiderId: env.PILOT_DESIGNATED_OUTSIDER_ID || null,
      from: env.PILOT_REPORT_FROM || null,
      populatedClusterIds,
    });
    if (env.PILOT_REPORT_PATH)
      writeFileSync(env.PILOT_REPORT_PATH, JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));
    return report;
  } finally {
    const cleanup = await player.auth.signOut({ scope: 'local' });
    if (cleanup.error) throw Object.assign(new Error(), { code: 'SERVICE_SESSION_CLEANUP_FAILED' });
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runQualification().catch((e) => {
    console.error(`Pilot Qualification: ${errorCode(e)}`);
    process.exitCode = 1;
  });
}
