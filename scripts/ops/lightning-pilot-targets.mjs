/** Read-only binding to the exact maintained private Action/Madness targets.
 * UUIDs come from normal creation; a UUID alone never authorizes a pilot action.
 */
import {
  LIGHTNING_PILOT_TABLE_SIZE,
  PILOT_TARGETS,
  assertPilotClub,
  pilotTemplateMatches,
} from './prepare-lightning-private-pilot.mjs';
export const PILOT_CLUB_ID = 'e14bc9f7-736d-425f-8f2c-e78305ebac1d';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const data = (r) => {
  if (r?.error || !r?.data) throw new Error('Pilot Target Read Unavailable');
  return r.data;
};
export function assertCurrentPilotTarget(game, clubId = PILOT_CLUB_ID, { active = true } = {}) {
  const target = PILOT_TARGETS.find((t) => t.gameName === game?.name);
  if (
    !target ||
    clubId !== PILOT_CLUB_ID ||
    !UUID.test(game?.id) ||
    game.club_id !== clubId ||
    game.union_id ||
    game.handedness !== LIGHTNING_PILOT_TABLE_SIZE ||
    game.handedness !== target.handedness ||
    Number(game.sb) !== target.sb ||
    Number(game.bb) !== target.bb ||
    game.variant !== 'nlh' ||
    !pilotTemplateMatches(game, target) ||
    game.must_move !== true ||
    game.ruleset_snapshot?.options?.is_private !== true ||
    (active &&
      (game.enabled !== true ||
        !!game.closed_at ||
        game.cluster_mode !== 'lightning' ||
        game.lightning_enabled !== true))
  )
    throw new Error('Exact Private Pilot Target Required');
  return target;
}
export async function resolvePilotTarget(admin, clusterId, { active = true } = {}) {
  if (!UUID.test(clusterId)) throw new Error('Explicit Target UUID Required');
  const club = data(await admin.from('clubs').select('*').eq('id', PILOT_CLUB_ID).maybeSingle());
  assertPilotClub(club);
  if (club.id !== PILOT_CLUB_ID) throw new Error('Pilot Club Identity');
  const game = data(await admin.from('cash_games').select('*').eq('id', clusterId).maybeSingle());
  if (game.id !== clusterId) throw new Error('Pilot Target Identity');
  const target = assertCurrentPilotTarget(game, PILOT_CLUB_ID, { active });
  // Names are the maintained creation binding. Ambiguous duplicates are unknown.
  const unique = data(
    await admin
      .from('cash_games')
      .select('id')
      .eq('club_id', PILOT_CLUB_ID)
      .eq('name', target.gameName)
      .maybeSingle()
  );
  if (unique.id !== clusterId) throw new Error('Pilot Target Name Ambiguous');
  return { game, target };
}

/** Every current maintained target, found by its unique creation name and then
 * bound exactly as above. A replaced target keeps its row but leaves this list,
 * so a caller never has to carry a UUID that a later owner decision retired. */
export async function resolveCurrentPilotTargets(admin, { active = true } = {}) {
  const out = [];
  for (const target of PILOT_TARGETS) {
    const row = data(
      await admin
        .from('cash_games')
        .select('id')
        .eq('club_id', PILOT_CLUB_ID)
        .eq('name', target.gameName)
        .maybeSingle()
    );
    out.push(await resolvePilotTarget(admin, row.id, { active }));
  }
  return out;
}
