import { writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { supabaseServerHeaders } from '../ci/supabase-auth-headers.mjs';

export const PILOT = Object.freeze({
  ownerId: '2d1cd6c3-5700-4af9-a271-d4863fdab20d',
  ownerEmail: 'daniel@smarter.poker',
  requestId: '84ad2b53-990b-4fae-91cf-e7fd5509d105',
  name: 'Lightning Internal Pilot',
  gameName: 'Lightning Pilot NLH 6',
});

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

export function assertPilotGame(game, clubId) {
  if (
    !game?.id ||
    game.club_id !== clubId ||
    game.union_id ||
    game.name !== PILOT.gameName ||
    game.handedness !== 6 ||
    game.variant !== 'nlh' ||
    game.must_move !== true ||
    game.ruleset_snapshot?.options?.is_private !== true
  )
    throw new Error('Pilot Game Identity Or Isolation Configuration Mismatch');
  if (game.lightning_enabled !== false || game.cluster_mode !== 'must_move') {
    throw new Error('Pilot Is Already Active; Preserve Its State And Use The Operator Door');
  }
}

export function selectPilotGame(games, clubId) {
  if (!Array.isArray(games) || games.some((game) => game.club_id !== clubId)) {
    throw new Error('Pilot Game Readback Scope Is Invalid');
  }
  // Club creation provisions default games. They remain ordinary games and
  // must never be adopted, reconfigured or deleted by pilot preparation.
  const matches = games.filter((game) => game.name === PILOT.gameName);
  if (matches.length > 1) throw new Error('Pilot Game Readback Is Ambiguous');
  if (!matches.length) return null;
  assertPilotGame(matches[0], clubId);
  return matches[0];
}

export function pilotServiceFetch(key, fetchImpl = fetch) {
  return (input, init = {}) =>
    fetchImpl(input, {
      ...init,
      headers: supabaseServerHeaders(key, Object.fromEntries(new Headers(init.headers))),
    });
}

export async function preparePilot(env = process.env) {
  const { createClient } = await import('@supabase/supabase-js');
  if (
    env.SP_EMAIL?.toLowerCase() !== PILOT.ownerEmail ||
    !env.SP_PASS ||
    !env.SUPABASE_URL ||
    !env.SUPABASE_SERVICE_ROLE_KEY
  ) {
    throw new Error('Configured Verified Service Credentials Are Required');
  }
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
    const members = must(
      await admin.from('club_members').select('user_id,status,role').eq('club_id', club.id),
      'Pilot Roster'
    );
    if (
      members.length !== 1 ||
      members[0].user_id !== PILOT.ownerId ||
      members[0].status !== 'active' ||
      members[0].role !== 'owner'
    ) {
      throw new Error('Existing Pilot Participants Require Explicit Recovery; No State Changed');
    }
    let games = must(
      await admin.from('cash_games').select('*').eq('club_id', club.id),
      'Pilot Games'
    );
    let game = selectPilotGame(games, club.id);
    if (!game) {
      // One execution, no retry. Unknown acknowledgement is recovered by the
      // unique club/template/variant/stakes identity on the next explicit run.
      const created = must(
        await player.rpc('fn_cash_game_create', {
          p_club_id: club.id,
          p_template: 'classic',
          p_variant: 'nlh',
          p_sb: 0.01,
          p_bb: 0.02,
          p_handedness: 6,
          p_overrides: { options: { is_private: true }, lightning_enabled: false },
          p_name: PILOT.gameName,
          p_must_move: true,
        }),
        'Pilot Game Creation'
      );
      if (created?.ok !== true) throw new Error('Pilot Game Creation Did Not Confirm Success');
      games = must(
        await admin.from('cash_games').select('*').eq('club_id', club.id),
        'Pilot Game Readback'
      );
    }
    game = selectPilotGame(games, club.id);
    if (!game) throw new Error('Pilot Game Readback Is Missing');
    const result = must(
      await player.rpc('fn_lightning_operator_control', {
        p_cluster_id: game.id,
        p_action: 'set_shadow_window',
        p_reason:
          'Prepare one-minute private-pilot A/A windows; leave the worker and Lightning off',
        p_args: { request_id: 'aaf6c3a2-b098-4d65-8e47-647a6834900b', shadow_window_ms: 60000 },
      }),
      'Pilot Calibration Window'
    );
    if (result?.ok !== true) throw new Error(`Pilot Window Refused: ${result?.code || 'Unknown'}`);
    const config = must(
      await admin.rpc('fn_lightning_config', { p_cluster_id: game.id }),
      'Pilot Config Readback'
    );
    if (
      config.ok !== true ||
      config.worker_mode !== 'off' ||
      config.shadow_window_ms !== 60000 ||
      config.matcher_version !== 'm1'
    ) {
      throw new Error('Pilot Configuration Readback Mismatch');
    }
    const receipt = {
      clubId: club.id,
      clusterId: game.id,
      ownerId: PILOT.ownerId,
      creationRequestId: PILOT.requestId,
      windowRequestId: result.request_id,
      windowEventId: result.event_id,
      shadowWindowMs: config.shadow_window_ms,
      lightningEnabled: false,
      workerMode: config.worker_mode,
      participants: 'owner_only',
      outsiderAccessProof: 'pending',
      functionalHandProof: 'pending',
      publicLaunch: 'NO_GO',
      observedAt: new Date().toISOString(),
    };
    if (env.PILOT_RECEIPT_PATH)
      writeFileSync(env.PILOT_RECEIPT_PATH, JSON.stringify(receipt, null, 2));
    console.log(JSON.stringify(receipt, null, 2));
    return receipt;
  } finally {
    // Only the service session made here. Never revoke other sessions.
    await player.auth.signOut({ scope: 'local' });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  preparePilot().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
