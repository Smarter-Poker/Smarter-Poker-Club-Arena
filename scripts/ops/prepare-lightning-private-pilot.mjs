import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { supabaseServerHeaders } from '../ci/supabase-auth-headers.mjs';

export const PILOT = Object.freeze({
  ownerId: '2d1cd6c3-5700-4af9-a271-d4863fdab20d',
  ownerEmail: 'daniel@smarter.poker',
  requestId: '84ad2b53-990b-4fae-91cf-e7fd5509d105',
  name: 'Lightning Internal Pilot',
  gameName: 'Lightning Pilot NLH Action 6',
});

// The existing one-per-key index excludes handedness. Distinct microstakes
// keep both must-move sizes valid without altering the schema or seeded games.
export const PILOT_TARGETS = Object.freeze([
  Object.freeze({
    gameName: PILOT.gameName,
    templateName: 'action',
    handedness: 6,
    sb: 0.01,
    bb: 0.02,
    windowRequestId: '57b786b4-1f87-4b57-b65f-ea9997ca9dc8',
    integrityRequestId: '4ffbcbb6-f273-4c13-9dcb-bcd27b1d1005',
  }),
  // Six seats, Madness's own template default (owner, 2026-10-17). Measured
  // on the nine-seat target it replaces: horses played 49.9% VPIP into the 50%
  // floor (the widening layer's ceiling at nine seats), so 92% of sittings ended
  // vpip_evicted with a two-hour bar and the game could never hold its 27.
  // Six-seat Madness on the same fleet plays 59.3% and needs 18.
  Object.freeze({
    gameName: 'Lightning Pilot NLH Madness 6',
    templateName: 'madness',
    handedness: 6,
    sb: 0.02,
    bb: 0.04,
    windowRequestId: '56373ee1-2e80-4826-b456-60e45a35b8f8',
    integrityRequestId: 'd89cc46f-8d5c-4120-ac46-890f65adaf25',
  }),
]);

/** Targets a later owner decision replaced. Each is closed only through the
 * club owner's ordinary managed close, which refuses while anyone is seated:
 * nobody is stood up, moved or cashed out to retire it. Its stakes share the
 * one-per-key and one-per-band slots its replacement needs, so the replacement
 * is created only after the close is read back. */
export const RETIRED_PILOT_TARGETS = Object.freeze([
  Object.freeze({
    gameName: 'Lightning Pilot NLH Madness 9',
    templateName: 'madness',
    handedness: 9,
    sb: 0.02,
    bb: 0.04,
    replacedBy: 'Lightning Pilot NLH Madness 6',
  }),
]);
const CLOSED_TABLE_STATUSES = new Set(['closed', 'completed', 'cancelled', 'finished']);

/** Close one retired target, or prove it is already closed. Never forces a seat. */
export async function retirePilotTarget({ admin, player, must, clubId, games, retired }) {
  const matches = games.filter((g) => g.name === retired.gameName);
  if (matches.length > 1) throw new Error('Retired Pilot Target Readback Is Ambiguous');
  if (!matches.length) return null;
  const game = matches[0];
  if (game.club_id !== clubId) throw new Error('Retired Pilot Target Scope Is Invalid');
  if (game.enabled !== true) {
    if (!game.closed_at) throw new Error('Retired Pilot Target Is Disabled Without A Close');
    return { gameName: retired.gameName, clusterId: game.id, outcome: 'already_closed' };
  }
  assertPilotGame(game, clubId, retired);
  const tables = must(
    await admin.from('tables').select('id,role,status,cluster_id').eq('cluster_id', game.id),
    'Retired Pilot Target Tables'
  );
  const open = (Array.isArray(tables) ? tables : []).filter(
    (t) =>
      t?.cluster_id === game.id && !CLOSED_TABLE_STATUSES.has(String(t.status ?? '').toLowerCase())
  );
  const mains = open.filter((t) => t.role === 'main');
  if (mains.length !== 1) throw new Error('Retired Pilot Target Main Table Is Ambiguous');
  const versions = must(
    await admin
      .from('managed_game_contract_versions')
      .select('version')
      .eq('game_kind', 'table')
      .eq('game_id', mains[0].id)
      .order('version', { ascending: false })
      .limit(1),
    'Retired Pilot Target Contract Version'
  );
  const version = Array.isArray(versions) ? versions[0]?.version : undefined;
  if (!Number.isSafeInteger(version) || version < 1)
    throw new Error('Retired Pilot Target Contract Version Is Missing');
  // A fresh command per attempt: a refused close is a durable receipt, and
  // replaying its ID would return that refusal for ever.
  const commandId = randomUUID();
  const closed = must(
    await player.rpc('fn_execute_managed_game_command', {
      p_command_id: commandId,
      p_kind: 'table',
      p_game_id: mains[0].id,
      p_action: 'close',
      p_expected_version: version,
      p_payload: {},
    }),
    'Retired Pilot Target Close'
  );
  if (closed?.ok !== true) {
    if (closed?.reason === 'players_seated')
      throw new Error(
        'Retired Pilot Target Still Has Seated Players; Run This Same Setup Again After They Leave Normally'
      );
    throw new Error(`Retired Pilot Target Close Refused: ${closed?.reason || 'Unknown'}`);
  }
  const after = must(
    await admin.from('cash_games').select('*').eq('id', game.id).maybeSingle(),
    'Retired Pilot Target Readback'
  );
  if (after?.id !== game.id || after.enabled !== false || !after.closed_at)
    throw new Error('Retired Pilot Target Close Readback Mismatch');
  return {
    gameName: retired.gameName,
    clusterId: game.id,
    mainTableId: mains[0].id,
    commandId,
    outcome: 'closed',
  };
}

export function assertPilotClub(club) {
  if (
    !club?.id ||
    club.owner_id !== PILOT.ownerId ||
    club.name !== PILOT.name ||
    club.is_public !== false ||
    club.requires_approval !== true ||
    club.union_id
  )
    throw new Error('Pilot Club Identity Or Isolation Configuration Mismatch');
}

/** Preserve the template's immutable normal-poker terms; never relabel Classic. */
export function pilotTemplateMatches(game, target) {
  const s = game?.ruleset_snapshot;
  const action = target?.templateName === 'action';
  if (!action && target?.templateName !== 'madness') return false;
  return (
    game.template_name === target.templateName &&
    s?.template === target.templateName &&
    s.variant === 'nlh' &&
    s.regular_ante === (action ? 'sb' : 'bb') &&
    s.vpip_floor === (action ? 30 : 50) &&
    s.vpip_window === 10 &&
    s.bombs?.enabled === true &&
    s.bombs.trigger === (action ? 'timed_15m' : 'every_orbit') &&
    s.bombs.ante_bb === (action ? 2 : 3) &&
    s.bombs.boards === 2
  );
}

export function assertPilotGame(game, clubId, target = null) {
  const expected = target ?? PILOT_TARGETS[0];
  if (
    !game?.id ||
    game.club_id !== clubId ||
    game.union_id ||
    game.name !== expected.gameName ||
    game.handedness !== expected.handedness ||
    !pilotTemplateMatches(game, expected) ||
    (target && (game.sb !== target.sb || game.bb !== target.bb || game.enabled !== true)) ||
    game.variant !== 'nlh' ||
    game.must_move !== true ||
    game.ruleset_snapshot?.options?.is_private !== true
  )
    throw new Error('Pilot Game Identity Or Isolation Configuration Mismatch');
  if (game.lightning_enabled !== false || game.cluster_mode !== 'must_move') {
    throw new Error('Pilot Is Already Active; Preserve Its State And Use The Operator Door');
  }
}

/** The pilot roster is the service owner plus, by Dan's 2026-10-14 ruling, only
 * existing horses admitted as ordinary players. Any other member (a human, a
 * non-player role, an unreadable profile) stops preparation before a receipt. */
export function assertPilotRoster(members, horseIds = new Set()) {
  const owners = Array.isArray(members) ? members.filter((m) => m?.user_id === PILOT.ownerId) : [];
  if (
    !Array.isArray(members) ||
    owners.length !== 1 ||
    owners[0].status !== 'active' ||
    owners[0].role !== 'owner' ||
    members.some(
      (m) =>
        m?.user_id !== PILOT.ownerId &&
        (m?.role !== 'player' || m?.status !== 'active' || !horseIds.has(m?.user_id))
    )
  ) {
    throw new Error(
      'Existing Pilot Participants Require Explicit Recovery; No Qualification Receipt Issued'
    );
  }
  return members.length - 1;
}

async function readPilotRoster(admin, clubId, label, must) {
  const members = must(
    await admin.from('club_members').select('user_id,status,role').eq('club_id', clubId),
    label
  );
  const others = Array.isArray(members)
    ? members.map((m) => m?.user_id).filter((id) => id && id !== PILOT.ownerId)
    : [];
  let horseIds = new Set();
  if (others.length > 0) {
    const profiles = must(
      await admin.from('profiles').select('id,is_horse').in('id', others),
      label + ' Profiles'
    );
    horseIds = new Set(
      (Array.isArray(profiles) ? profiles : []).filter((p) => p?.is_horse === true).map((p) => p.id)
    );
  }
  return { members, horses: assertPilotRoster(members, horseIds) };
}

export function selectPilotGame(games, clubId, target = null) {
  const expected = target ?? PILOT_TARGETS[0];
  if (!Array.isArray(games) || games.some((game) => game.club_id !== clubId)) {
    throw new Error('Pilot Game Readback Scope Is Invalid');
  }
  // Club creation provisions default games. They remain ordinary games and
  // must never be adopted, reconfigured or deleted by pilot preparation.
  const matches = games.filter((game) => game.name === expected.gameName);
  if (matches.length > 1) throw new Error('Pilot Game Readback Is Ambiguous');
  if (!matches.length) return null;
  assertPilotGame(matches[0], clubId, target);
  return matches[0];
}

export function pilotServiceFetch(key, fetchImpl = fetch) {
  return (input, init = {}) =>
    fetchImpl(input, {
      ...init,
      headers: supabaseServerHeaders(key, Object.fromEntries(new Headers(init.headers))),
    });
}

function assertPilotControlReceipt(row, clusterId, action, requestId, target) {
  const state = (s) =>
    s &&
    typeof s === 'object' &&
    !Array.isArray(s) &&
    typeof s.cluster_mode === 'string' &&
    s.cluster_mode.trim().length > 0 &&
    typeof s.lightning_enabled === 'boolean';
  const event = row?.event_id;
  const audited =
    (typeof event === 'number' && Number.isSafeInteger(event) && event > 0) ||
    (typeof event === 'string' && /^[1-9]\d*$/.test(event));
  const already = row?.already === true;
  const legacyWindow =
    action === 'set_shadow_window' &&
    requestId === PILOT_TARGETS[0].windowRequestId &&
    row?.replayed === true &&
    row?.idempotent === true &&
    row?.after?.shadow_window_ms === undefined;
  const actual =
    action === 'set_shadow_window' ? row?.after?.shadow_window_ms : row?.after?.integrity_telemetry;
  if (
    !row ||
    row.ok !== true ||
    row.cluster_id !== clusterId ||
    row.action !== action ||
    row.request_id !== requestId ||
    typeof row.idempotent !== 'boolean' ||
    !state(row.before) ||
    !state(row.after) ||
    (row.replayed !== undefined && typeof row.replayed !== 'boolean') ||
    (row.already !== undefined && typeof row.already !== 'boolean') ||
    (already ? row.idempotent !== true || event !== null : !audited) ||
    (already && !isDeepStrictEqual(row.before, row.after)) ||
    (!legacyWindow && actual !== target) ||
    (legacyWindow && !already && row.detail?.shadow_window_ms !== target)
  ) {
    throw new Error('Pilot Control Receipt Is Missing Or Does Not Match The Requested Operation');
  }
}

/** The targets one setup run prepares, by template. A target already live
 * in a Lightning stage is left out by name rather than refused as a whole run,
 * so the other one can still be prepared; unknown names select nothing. */
export function selectSetupTargets(value) {
  const wanted = new Set(
    String(value ?? 'action,madness')
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean)
  );
  const selected = PILOT_TARGETS.filter((t) => wanted.has(t.templateName));
  if (!selected.length || selected.length !== wanted.size)
    throw new Error('Pilot Setup Targets Must Name Action, Madness Or Both');
  return selected;
}

export async function preparePilot(env = process.env, clientFactory) {
  const createClient = clientFactory ?? (await import('@supabase/supabase-js')).createClient;
  if (
    env.SP_EMAIL?.toLowerCase() !== PILOT.ownerEmail ||
    !env.SP_PASS ||
    !env.SUPABASE_URL ||
    !env.SUPABASE_SERVICE_ROLE_KEY
  ) {
    throw new Error('Configured Verified Service Credentials Are Required');
  }
  const setupTargets = selectSetupTargets(env.PILOT_SETUP_TARGETS);
  const options = { auth: { persistSession: false, autoRefreshToken: false } };
  const admin = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
    ...options,
    global: { fetch: pilotServiceFetch(env.SUPABASE_SERVICE_ROLE_KEY) },
  });
  const player = createClient(
    env.SUPABASE_URL,
    'sb_publishable__41LpJpzrfrb3hSUpEaYCA_tF53bBJx',
    options
  );
  const must = (result, label) => {
    if (result.error) throw new Error(`${label}: ${result.error.code || 'Request Failed'}`);
    return result.data;
  };
  let receipt;
  let primaryError;
  let preparationFailed = false;
  try {
    const login = must(
      await player.auth.signInWithPassword({ email: env.SP_EMAIL, password: env.SP_PASS }),
      'Service Login'
    );
    if (login.user?.id !== PILOT.ownerId)
      throw new Error('Authenticated Service Identity Mismatch');
    const profile = must(
      await admin
        .from('profiles')
        .select('id,role,status,is_horse')
        .eq('id', PILOT.ownerId)
        .maybeSingle(),
      'Service Profile'
    );
    if (profile?.role !== 'god' || profile.status !== 'active' || profile.is_horse === true)
      throw new Error('Service Profile Authority Mismatch');

    // Same persisted creation request on every recovery: never duplicate a club.
    const club = must(
      await player.rpc('fn_create_club_atomic', {
        p_request_id: PILOT.requestId,
        p_name: PILOT.name,
        p_description: 'Internal Lightning functional pilot. Team access only.',
        p_color_theme: 'royal-blue',
        p_is_public: false,
        p_requires_approval: true,
        p_logo_url: null,
      }),
      'Pilot Club Creation'
    );
    assertPilotClub(club);
    await readPilotRoster(admin, club.id, 'Pilot Roster', must);
    let games = must(
      await admin.from('cash_games').select('*').eq('club_id', club.id),
      'Pilot Games'
    );
    // Validate every existing named target before any setup mutation. Ordinary
    // seeded games remain untouched, including the default nine-seat game.
    for (const target of setupTargets) selectPilotGame(games, club.id, target);
    // A replaced target is closed, and read back closed, before its
    // replacement may claim the same stake slot.
    const retirements = [];
    for (const retired of RETIRED_PILOT_TARGETS.filter((r) =>
      setupTargets.some((t) => t.templateName === r.templateName)
    )) {
      const outcome = await retirePilotTarget({
        admin,
        player,
        must,
        clubId: club.id,
        games,
        retired,
      });
      if (outcome) retirements.push(outcome);
    }
    if (retirements.some((r) => r.outcome === 'closed'))
      games = must(
        await admin.from('cash_games').select('*').eq('club_id', club.id),
        'Pilot Games After Retirement'
      );
    const operations = [];
    for (const target of setupTargets) {
      let game = selectPilotGame(games, club.id, target);
      if (!game) {
        // One creation attempt. Unknown acknowledgement ends this run; the next
        // explicit run reads the persisted named target before considering creation.
        const created = must(
          await player.rpc('fn_cash_game_create', {
            p_club_id: club.id,
            p_template: target.templateName,
            p_variant: 'nlh',
            p_sb: target.sb,
            p_bb: target.bb,
            p_handedness: target.handedness,
            p_overrides: { options: { is_private: true }, lightning_enabled: false },
            p_name: target.gameName,
            p_must_move: true,
          }),
          'Pilot Game Creation'
        );
        if (created?.ok !== true) throw new Error('Pilot Game Creation Did Not Confirm Success');
        games = must(
          await admin.from('cash_games').select('*').eq('club_id', club.id),
          'Pilot Game Readback'
        );
        game = selectPilotGame(games, club.id, target);
      }
      if (!game) throw new Error('Pilot Game Readback Is Missing');
      const result = must(
        await player.rpc('fn_lightning_operator_control', {
          p_cluster_id: game.id,
          p_action: 'set_shadow_window',
          p_reason:
            'Prepare one-minute private-pilot A/A windows; leave the worker and Lightning off',
          p_args: { request_id: target.windowRequestId, shadow_window_ms: 60000 },
        }),
        'Pilot Calibration Window'
      );
      if (result?.code === 'REQUEST_IN_PROGRESS')
        throw new Error(
          'Pilot Calibration Window Is Still In Progress; Retry The Same Operation ID'
        );
      if (result?.ok !== true)
        throw new Error(`Pilot Window Refused: ${result?.code || 'Unknown'}`);
      assertPilotControlReceipt(
        result,
        game.id,
        'set_shadow_window',
        target.windowRequestId,
        60000
      );
      const telemetry = must(
        await player.rpc('fn_lightning_operator_control', {
          p_cluster_id: game.id,
          p_action: 'set_integrity_telemetry',
          p_reason:
            'Prepare integrity recording for the internal pilot; keep Lightning and worker off',
          p_args: { request_id: target.integrityRequestId, value: true },
        }),
        'Pilot Integrity Telemetry'
      );
      if (telemetry?.code === 'REQUEST_IN_PROGRESS')
        throw new Error(
          'Pilot Integrity Telemetry Is Still In Progress; Retry The Same Operation ID'
        );
      if (telemetry?.ok !== true)
        throw new Error(`Pilot Integrity Refused: ${telemetry?.code || 'Unknown'}`);
      assertPilotControlReceipt(
        telemetry,
        game.id,
        'set_integrity_telemetry',
        target.integrityRequestId,
        true
      );
      operations.push({ target, game, result, telemetry });
    }

    // Re-read all targets after both setup operations. Cached receipts prove the
    // original request, never that later activation or admission remained unchanged.
    const targets = [];
    for (const { target, game, result, telemetry } of operations) {
      const config = must(
        await admin.rpc('fn_lightning_config', { p_cluster_id: game.id }),
        'Pilot Config Readback'
      );
      if (
        config?.ok !== true ||
        config.worker_mode !== 'off' ||
        config.shadow_window_ms !== 60000 ||
        config.matcher_version !== 'm1' ||
        config.integrity_telemetry !== true
      )
        throw new Error('Pilot Configuration Readback Mismatch');
      const currentGame = must(
        await admin.from('cash_games').select('*').eq('id', game.id).maybeSingle(),
        'Pilot Final Game Readback'
      );
      assertPilotGame(currentGame, club.id, target);
      if (currentGame.id !== game.id) throw new Error('Pilot Final Game Identity Mismatch');
      targets.push({
        gameName: target.gameName,
        handedness: target.handedness,
        sb: target.sb,
        bb: target.bb,
        clusterId: game.id,
        windowRequestId: result.request_id,
        windowEventId: result.event_id,
        shadowWindowMs: config.shadow_window_ms,
        integrityTelemetry: config.integrity_telemetry,
        integrityRequestId: telemetry.request_id,
        integrityEventId: telemetry.event_id,
        lightningEnabled: false,
        workerMode: config.worker_mode,
        matcherVersion: config.matcher_version,
      });
    }
    const currentClub = must(
      await admin
        .from('clubs')
        .select('id,owner_id,name,is_public,requires_approval,union_id')
        .eq('id', club.id)
        .maybeSingle(),
      'Pilot Final Club Readback'
    );
    assertPilotClub(currentClub);
    if (currentClub.id !== club.id) throw new Error('Pilot Final Club Identity Mismatch');
    const finalRoster = await readPilotRoster(admin, club.id, 'Pilot Final Roster Readback', must);
    receipt = {
      clubId: club.id,
      ...targets[0],
      targets,
      retirements,
      ownerId: PILOT.ownerId,
      creationRequestId: PILOT.requestId,
      participants: finalRoster.horses === 0 ? 'owner_only' : 'owner_and_admitted_horses',
      admittedHorses: finalRoster.horses,
      outsiderAccessProof: 'pending',
      functionalHandProof: 'pending',
      publicLaunch: 'NO_GO',
      observedAt: new Date().toISOString(),
    };
  } catch (error) {
    preparationFailed = true;
    primaryError = error;
    throw error;
  } finally {
    // Only the service session made here. Never revoke other sessions.
    try {
      const cleanup = await player.auth.signOut({ scope: 'local' });
      if (cleanup?.error) throw new Error('Service Session Cleanup Failed');
    } catch {
      const primaryMessage =
        primaryError instanceof Error ? primaryError.message : 'Pilot Preparation Failed';
      throw new Error(
        preparationFailed
          ? `${primaryMessage}; Service Session Cleanup Failed`
          : 'Service Session Cleanup Failed',
        preparationFailed ? { cause: primaryError } : undefined
      );
    }
  }
  // Publish a qualification receipt only after the owning local session is closed.
  if (env.PILOT_RECEIPT_PATH)
    writeFileSync(env.PILOT_RECEIPT_PATH, JSON.stringify(receipt, null, 2));
  console.log(JSON.stringify(receipt, null, 2));
  return receipt;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  preparePilot().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
