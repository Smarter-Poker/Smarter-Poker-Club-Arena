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

/** Owner ruling 2026-10-19: "classic games never get lightning games, only
 * action and madness, make all lightning games 6 handed". A pilot target is a
 * six-seat Action or Madness game, and nothing else is ever accepted as one. */
export const LIGHTNING_PILOT_TABLE_SIZE = 6;
export function assertLightningPilotTarget(target) {
  if (
    !target ||
    (target.templateName !== 'action' && target.templateName !== 'madness') ||
    target.handedness !== LIGHTNING_PILOT_TABLE_SIZE
  )
    throw new Error('Lightning Pilot Targets Must Be Six Seat Action Or Madness');
  return target;
}

// The existing one-per-key index excludes handedness. Distinct microstakes
// keep each must-move target valid without altering the schema or seeded games.
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
for (const target of PILOT_TARGETS) assertLightningPilotTarget(target);

/** Games a later owner decision took out of the pilot. Each is retired only
 * through the club owner's switch (fn_cash_game_switch_off): no new seating or
 * opening, nobody is stood up, moved or cashed out, and its tables close as
 * they empty. A replaced target's stakes share the one-per-key and one-per-band
 * slots its replacement needs, so the replacement is created only after the
 * switch is read back. Each keeps one stable request id and one stable reason,
 * so a rerun replays rather than acting twice. */
export const RETIRED_PILOT_TARGETS = Object.freeze([
  Object.freeze({
    gameName: 'Lightning Pilot NLH Madness 9',
    templateName: 'madness',
    handedness: 9,
    sb: 0.02,
    bb: 0.04,
    replacedBy: 'Lightning Pilot NLH Madness 6',
    switchOffReason: 'Replaced by Lightning Pilot NLH Madness 6; seated players finish normally',
    switchOffRequestId: 'a6f1c0de-5b7e-4d2a-9c3f-6e8b1d4a7f20',
  }),
  // Owner ruling 2026-10-19: Classic never gets Lightning, so the two Classic
  // games in the pilot club have no purpose in the Lightning pilot. They held
  // most of its horses away from the two Lightning targets. Retired on every
  // setup run (and by the retirement-only run), whatever targets it names.
  Object.freeze({
    gameName: 'Lightning Pilot NLH 6',
    templateName: 'classic',
    handedness: 6,
    sb: 0.01,
    bb: 0.02,
    replacedBy: null,
    switchOffReason:
      'Classic never gets Lightning (owner ruling 2026-10-19); seated players finish normally',
    switchOffRequestId: '852ba69e-b057-4358-a724-236f5ba8ae63',
  }),
  Object.freeze({
    gameName: 'Lightning Pilot NLH 9',
    templateName: 'classic',
    handedness: 9,
    sb: 0.02,
    bb: 0.04,
    replacedBy: null,
    switchOffReason:
      'Classic never gets Lightning (owner ruling 2026-10-19); seated players finish normally',
    switchOffRequestId: 'd493b753-5083-45ff-9faf-4e4e4f3633e5',
  }),
]);

/** The exact identity of a retired game before its owner switch is used: the
 * pilot club, its name, size, stakes and template, private, must-move, still
 * enabled, and never in a Lightning state (that needs the operator drain). */
export function assertRetiredPilotGame(game, clubId, retired) {
  const classic = retired?.templateName === 'classic';
  const template = classic
    ? game?.template_name === 'classic' && game?.ruleset_snapshot?.template === 'classic'
    : pilotTemplateMatches(game, retired);
  if (
    !game?.id ||
    game.club_id !== clubId ||
    game.union_id ||
    game.name !== retired.gameName ||
    game.handedness !== retired.handedness ||
    !template ||
    Number(game.sb) !== retired.sb ||
    Number(game.bb) !== retired.bb ||
    game.enabled !== true ||
    game.variant !== 'nlh' ||
    game.must_move !== true ||
    game.ruleset_snapshot?.options?.is_private !== true
  )
    throw new Error('Pilot Game Identity Or Isolation Configuration Mismatch');
  if (game.lightning_enabled !== false || game.cluster_mode !== 'must_move') {
    throw new Error('Pilot Is Already Active; Preserve Its State And Use The Operator Door');
  }
}

/** Which retired games one setup run switches off: every Classic game always,
 * a replaced target with the template it replaced, and all of them on the
 * retirement-only run. */
export function selectRetirements(setupTargets) {
  const retireOnly = !setupTargets?.length;
  return RETIRED_PILOT_TARGETS.filter(
    (r) =>
      retireOnly ||
      r.templateName === 'classic' ||
      setupTargets.some((t) => t.templateName === r.templateName)
  );
}
/** Switch off one retired target, or prove it is already off. Never forces a
 * seat: the owner's switch (fn_cash_game_switch_off, OPORD 18.4) stops new
 * seating and opening; everyone seated keeps playing and leaves normally, and
 * the controller closes each table once it is empty. One stable request id per
 * retired target, so a rerun replays rather than acting twice. */
export async function retirePilotTarget({ admin, player, must, clubId, games, retired }) {
  const matches = games.filter((g) => g.name === retired.gameName);
  if (matches.length > 1) throw new Error('Retired Pilot Target Readback Is Ambiguous');
  if (!matches.length) return null;
  const game = matches[0];
  if (game.club_id !== clubId) throw new Error('Retired Pilot Target Scope Is Invalid');
  if (game.enabled !== true)
    return { gameName: retired.gameName, clusterId: game.id, outcome: 'already_switched_off' };
  assertRetiredPilotGame(game, clubId, retired);
  const answer = must(
    await player.rpc('fn_cash_game_switch_off', {
      p_game_id: game.id,
      p_request_id: retired.switchOffRequestId,
      p_reason: retired.switchOffReason,
    }),
    'Retired Pilot Target Switch Off'
  );
  if (answer?.ok !== true || answer.game_id !== game.id)
    throw new Error(`Retired Pilot Target Switch Off Refused: ${answer?.reason || 'Unknown'}`);
  const after = must(
    await admin.from('cash_games').select('*').eq('id', game.id).maybeSingle(),
    'Retired Pilot Target Readback'
  );
  if (after?.id !== game.id || after.enabled !== false)
    throw new Error('Retired Pilot Target Switch Off Readback Mismatch');
  return {
    gameName: retired.gameName,
    clusterId: game.id,
    requestId: retired.switchOffRequestId,
    eventId: answer.event_id ?? null,
    seatedAtSwitchOff: answer.seated_at_switch_off ?? null,
    outcome:
      answer.replayed === true || answer.already === true ? 'already_switched_off' : 'switched_off',
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
    // Owner cadence, 2026-10-17 (#7263, migration 20261017105834): Action
    // bombs every twenty minutes, Madness every ten.
    s.bombs.trigger === (action ? 'timed_20m' : 'timed_10m') &&
    s.bombs.ante_bb === (action ? 2 : 3) &&
    s.bombs.boards === 2
  );
}

export function assertPilotGame(game, clubId, target = null) {
  const expected = assertLightningPilotTarget(target ?? PILOT_TARGETS[0]);
  if (
    !game?.id ||
    game.club_id !== clubId ||
    game.union_id ||
    game.name !== expected.gameName ||
    game.handedness !== LIGHTNING_PILOT_TABLE_SIZE ||
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
 * so the other one can still be prepared; unknown names select nothing.
 * `retire` alone selects no target: that run only switches off the retired
 * games (selectRetirements), so it works while both targets are live. */
export function selectSetupTargets(value) {
  if (
    String(value ?? '')
      .trim()
      .toLowerCase() === 'retire'
  )
    return [];
  const wanted = new Set(
    String(value ?? 'action,madness')
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean)
  );
  const selected = PILOT_TARGETS.filter((t) => wanted.has(t.templateName));
  if (!selected.length || selected.length !== wanted.size)
    throw new Error('Pilot Setup Targets Must Name Action, Madness Or Both, Or Retire');
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
    // A replaced target is switched off, and read back off, before its
    // replacement may claim the same stake slot.
    const retirements = [];
    for (const retired of selectRetirements(setupTargets)) {
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
    if (retirements.some((r) => r.outcome === 'switched_off'))
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
