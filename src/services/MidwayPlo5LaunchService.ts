import { supabase } from '../lib/supabase';
import { resolveClubUUID } from '../utils/clubIdResolver';
import { isCashGameHorseArrivalsReady } from './GameServerAPI';
import {
  MIDWAY_PLO5_CLUB_ID,
  MIDWAY_PLO5_GAME_ID,
  MIDWAY_PLO5_LINEUP,
  MIDWAY_PLO5_REQUEST_ID,
  MIDWAY_PLO5_STARTS_AT,
} from '../config/midwayPlo5Launch';

const uuid = (value: unknown): value is string =>
  typeof value === 'string' &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
const object = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
const marker = (value: unknown) => {
  const candidate = object(object(value)?.horse_arrivals);
  return candidate?.version === 1 && uuid(candidate.policy_id) ? candidate : null;
};

/** A failed/unknown acknowledgement never switches to the ordinary creator or a new request. */
export async function launchMidwayPlo5(
  clubId: string,
  assertOwner: () => void
): Promise<{ gameId: string; tableId: string; replayed: boolean }> {
  assertOwner();
  if (Date.now() < Date.parse(MIDWAY_PLO5_STARTS_AT)) {
    throw new Error('The Approved Start Time Has Not Arrived');
  }
  const resolvedClubId = await resolveClubUUID(clubId);
  assertOwner();
  if (resolvedClubId !== MIDWAY_PLO5_CLUB_ID) {
    throw new Error('This Launch Is Only Available In Midway Union');
  }
  const engineReady = await isCashGameHorseArrivalsReady();
  assertOwner();
  if (!engineReady) throw new Error('The Selected Lineup Is Not Ready To Launch Yet');
  const { data, error } = await supabase.rpc('fn_cash_game_attach_horse_arrivals', {
    p_request_id: MIDWAY_PLO5_REQUEST_ID,
    p_game_id: MIDWAY_PLO5_GAME_ID,
    p_starts_at: MIDWAY_PLO5_STARTS_AT,
    p_ranked_horse_ids: MIDWAY_PLO5_LINEUP.map((player) => player.id),
  });
  assertOwner();
  if (error) throw error;
  const receipt = object(data);
  if (receipt?.ok !== true || receipt.game_id !== MIDWAY_PLO5_GAME_ID) {
    throw new Error('The Lineup Was Not Confirmed. Retry Uses The Same Request');
  }
  const gameId = receipt.game_id;

  // The attachment response intentionally has no table_id. Read authoritative game
  // and anchor rows for BOTH responses; an RPC acknowledgement alone is not a
  // persisted launch, and no unrestricted anchor can stand in for this policy.
  const { data: gameData, error: gameError } = await supabase
    .from('cash_games')
    .select(
      'id,name,club_id,template_name,variant,sb,bb,handedness,must_move,enabled,closed_at,ruleset_snapshot'
    )
    .eq('id', gameId)
    .maybeSingle();
  assertOwner();
  if (gameError) throw gameError;
  const game = object(gameData);
  const gameMarker = marker(game?.ruleset_snapshot);
  const receiptMarker = object(receipt.horse_arrivals);
  if (
    !game ||
    game.id !== gameId ||
    game.name !== "CHET'S GAME" ||
    game.club_id !== MIDWAY_PLO5_CLUB_ID ||
    game.template_name !== 'classic' ||
    game.variant !== 'plo5' ||
    Number(game.sb) !== 2 ||
    Number(game.bb) !== 5 ||
    game.handedness !== 6 ||
    game.must_move !== true ||
    game.enabled !== true ||
    game.closed_at !== null ||
    !gameMarker ||
    (receiptMarker && receiptMarker.policy_id !== gameMarker.policy_id)
  ) {
    throw new Error('The Existing Game Could Not Be Verified. Retry Uses The Same Request');
  }
  const { data: tables, error: tableError } = await supabase
    .from('tables')
    .select('id,cluster_id,status,is_deleted,settings')
    .eq('cluster_id', gameId)
    .eq('is_deleted', false)
    .in('status', ['waiting', 'running']);
  assertOwner();
  if (tableError) throw tableError;
  const rows = (Array.isArray(tables) ? tables : []) as Array<Record<string, unknown>>;
  const candidates = rows.filter(
    (table) =>
      uuid(table.id) &&
      table.cluster_id === gameId &&
      table.is_deleted === false &&
      typeof table.status === 'string' &&
      ['waiting', 'running'].includes(table.status) &&
      marker(table.settings)?.policy_id === gameMarker.policy_id
  );
  const table = uuid(receipt.table_id)
    ? candidates.find((candidate) => candidate.id === receipt.table_id)
    : candidates[0];
  if (!table || !uuid(table.id)) {
    throw new Error('The Approved Game Has No Verified Active Table. Retry Uses The Same Request');
  }
  return { gameId, tableId: table.id, replayed: receipt.replayed === true };
}
