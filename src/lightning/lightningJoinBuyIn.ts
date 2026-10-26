/**
 * JOIN LIGHTNING IS ONE BUY-IN, NOT A SEAT CHOICE (Dan 2026-10-24).
 *
 * "LIGHTNING NEEDS TO OPERATE JUST LIKE A TOURNAMENT, YOU DON'T SELECT YOUR
 * SEAT, YOU 'JOIN LIGHTNING GAMES' SELECT HOW MUCH YOU WANT TO BUY IN FOR, AND
 * THEN YOU AUTO ASSIGN THEM TO A SEAT AND TABLE."
 *
 * So the Join Lightning page asks one question - the amount - and this module
 * does the rest with the platform's existing doors, in order:
 *
 *   1. fn_cash_game_join holds a chair for the caller (opening a new table
 *      when every chair is taken) and names it (seat_number);
 *   2. the cash buy-in journal reserves the request and atomic_table_buyin
 *      buys that chair, exactly as a table's own buy-in sheet does (same
 *      idempotency key, same receipt recovery, nothing retried blindly);
 *   3. the database moves the new seat into the Lightning pool at commit, and
 *      the caller's pool session is read back so the page can open its room.
 *
 * A proven seat collision (the chair was taken between the hold and the
 * purchase) moved no chips, so the join is asked once more for a fresh chair.
 * Anything uncertain is never retried here: the saved request is left for the
 * table's own recovery and the page sends the player there.
 */
import { supabase } from '../lib/supabase';
import { cashBuyInRange, cashBuyInRefusalText, cashBuyInSeatConflictText } from '../lib/cashBuyIn';
import {
  joinCashGame,
  joinGameRefusalText,
  type CashGameJoinResult,
} from '../services/cashGameLobby';
import {
  cashBuyInJournal,
  executeCashBuyIn,
  sameCashBuyInIntent,
  type CashBuyInIntent,
} from '../services/CashBuyInRecovery';
import { readTableFundingBalance } from '../services/TableFundingService';
import { reportError } from '../utils/errorReporter';
import {
  clearLightningEntryIntent,
  fetchMyLightningSession,
  hasLightningRoom,
  setLightningEntryIntent,
} from './lightningSession';

/** What the amount question needs: the game's range, the floor and the wallet. */
export interface LightningBuyInContext {
  /** A live table of the game, read for its price and its paying wallet only. */
  tableId: string;
  minBuyIn: number;
  maxBuyIn: number;
  bigBlind: number;
  balance: number | null;
}

export type LightningBuyInResult =
  | { kind: 'seated'; tableId: string; poolSessionId: string | null }
  | { kind: 'rejected'; message: string }
  | { kind: 'unconfirmed'; tableId: string; message: string };

export interface LightningBuyInDeps {
  rejoin?: (clusterId: string) => Promise<{ tableId: string; poolSessionId: string } | null>;
  join: (clusterId: string) => Promise<CashGameJoinResult>;
  reserve: typeof cashBuyInJournal.reserve;
  complete: typeof cashBuyInJournal.complete;
  execute: typeof executeCashBuyIn;
  markIntent: (tableId: string, clusterId: string) => void;
  clearIntent: (tableId: string) => void;
  readPoolSession: (clusterId: string) => Promise<string | null>;
}

export async function rejoinLightningSeat(
  clusterId: string
): Promise<{ tableId: string; poolSessionId: string } | null> {
  const { data, error } = await supabase.rpc('fn_lightning_rejoin_seated', {
    p_cluster_id: clusterId,
  });
  if (error) throw error;
  if (data === null) return null;
  if (!data?.table_id || !data?.pool_session_id) throw new Error('Lightning Rejoin Not Confirmed');
  return { tableId: data.table_id, poolSessionId: data.pool_session_id };
}

const defaultDeps: LightningBuyInDeps = {
  rejoin: rejoinLightningSeat,
  join: joinCashGame,
  reserve: (intent) => cashBuyInJournal.reserve(intent),
  complete: (attempt) => cashBuyInJournal.complete(attempt),
  execute: executeCashBuyIn,
  markIntent: setLightningEntryIntent,
  clearIntent: clearLightningEntryIntent,
  readPoolSession: async (clusterId) => {
    const session = await fetchMyLightningSession(clusterId);
    return hasLightningRoom(session) ? session.poolSessionId : null;
  },
};

/** The signed-in player, or null. */
export async function currentLightningUserId(): Promise<string | null> {
  const { data, error } = await supabase.auth.getSession();
  if (error) throw error;
  return data.session?.user?.id ?? null;
}

/** The price of the game and the caller's wallet, read before the question is asked. */
export async function readLightningBuyInContext(
  clusterId: string,
  userId: string
): Promise<LightningBuyInContext | null> {
  const { data: table, error } = await supabase
    .from('tables')
    .select('id, big_blind, min_buy_in, max_buy_in')
    .eq('cluster_id', clusterId)
    .neq('lifecycle', 'closed')
    .order('created_at', { ascending: true })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  const row = table as {
    id?: string;
    big_blind?: number | null;
    min_buy_in?: number | null;
    max_buy_in?: number | null;
  } | null;
  if (!row?.id) return null;
  const range = cashBuyInRange(row);
  let min = range.min;
  /* The rejoin floor (a player who just cashed out comes back with at least
     what they left with). The buy-in door enforces it; the question says it. */
  try {
    const { data: floor, error: floorError } = await supabase.rpc('fn_cash_effective_buyin', {
      p_table_id: row.id,
    });
    if (floorError) reportError(floorError, 'lightningJoinBuyIn.effective_buyin_read');
    const f = floor as { min?: unknown; floor_applied?: unknown } | null;
    if (f?.floor_applied === true && Number(f.min) > min) min = Number(f.min);
  } catch {
    /* the door is still the authority */
  }
  const { balance } = await readTableFundingBalance(userId, { tableId: row.id });
  return {
    tableId: row.id,
    minBuyIn: min,
    maxBuyIn: Math.max(min, range.max),
    bigBlind: Number(row.big_blind) || 0,
    balance: balance ?? null,
  };
}

const errorText = (error: unknown): string =>
  String(
    typeof error === 'object' && error !== null && 'message' in error
      ? (error as { message?: unknown }).message
      : error
  );

/**
 * Hold a chair, buy it, and land in the pool. The caller confirmed the amount;
 * nothing else is asked of them.
 */
export async function buyIntoLightning(
  args: { clusterId: string; userId: string; amount: number; clubId: string | null },
  deps: LightningBuyInDeps = defaultDeps
): Promise<LightningBuyInResult> {
  try {
    const existing = await deps.rejoin?.(args.clusterId);
    if (existing) return { kind: 'seated', ...existing };
  } catch (error) {
    return { kind: 'rejected', message: joinGameRefusalText(error) };
  }
  for (let tries = 0; tries < 2; tries += 1) {
    let held: CashGameJoinResult;
    try {
      held = await deps.join(args.clusterId);
    } catch (error) {
      return { kind: 'rejected', message: joinGameRefusalText(error) };
    }
    if (!held.table_id) {
      return { kind: 'rejected', message: 'No Seat Is Open Right Now. Try Again In A Moment.' };
    }
    if (held.action === 'seated') {
      /* Already playing this game: their chips are already in the pool. */
      return {
        kind: 'seated',
        tableId: held.table_id,
        poolSessionId: await deps.readPoolSession(args.clusterId).catch(() => null),
      };
    }
    if (held.action !== 'seat') {
      return { kind: 'rejected', message: 'No Seat Is Open Right Now. Try Again In A Moment.' };
    }
    const chair = Number(held.seat_number);
    const intent: CashBuyInIntent = {
      p_user_id: args.userId,
      p_table_id: held.table_id,
      p_seat_number: Number.isSafeInteger(chair) && chair > 0 ? chair : 1,
      p_amount: args.amount,
      p_auto_rebuy: false,
      p_club_id: args.clubId,
    };
    /* The tab follows the chair into its pool room the moment it exists. */
    deps.markIntent(held.table_id, args.clusterId);
    const { attempt, recovered } = await deps.reserve(intent);
    if (recovered && !sameCashBuyInIntent(intent, attempt.payload)) {
      /* An earlier buy-in at this table is still unanswered. It is reviewed
         where it was made, never replaced by a new amount here. Nothing was
         bought by this request, so the tab has no room to follow: the intent
         goes, or the anchor table says "Joining Lightning..." until Cancel
         (Lightning transition phase 2). */
      deps.clearIntent(held.table_id);
      return {
        kind: 'unconfirmed',
        tableId: held.table_id,
        message: 'Review Your Original Buy-In Before Retrying.',
      };
    }
    const outcome = await deps.execute(attempt, recovered);
    if (outcome.kind === 'unknown') {
      /* NOT CONFIRMED IS NOT JOINING (Lightning transition phase 2). The intent
         is what makes the anchor table say "Joining Lightning..." and wait for
         a pool session, and it was left standing here, so a buy-in nobody
         could confirm left the player on that line, with no buy-in in sight,
         until they pressed Cancel. It goes now, and the table shows what is
         true: the saved request, which its own buy-in sheet retries under the
         same key (that retry marks the intent again). Had the purchase in fact
         committed, the seat is funded and the table's existing conversion read
         offers VIEW GAME the moment the pool session exists; the tab never
         moves without the player (CLAUDE.md 10.6). */
      deps.clearIntent(held.table_id);
      return {
        kind: 'unconfirmed',
        tableId: held.table_id,
        message: 'Buy-In Not Yet Confirmed. Retrying Uses The Same Request.',
      };
    }
    await deps.complete(attempt).catch(() => undefined);
    if (outcome.kind === 'rejected') {
      /* No seat was bought: the tab has no room to follow. */
      deps.clearIntent(held.table_id);
      const conflict = cashBuyInSeatConflictText(outcome.error);
      /* The chair went to someone else between the hold and the purchase: no
         chips moved, so the door is asked once more for a fresh chair. */
      if (
        tries === 0 &&
        conflict !== null &&
        /table_seats_table_id_seat_number_key/.test(errorText(outcome.error))
      )
        continue;
      return {
        kind: 'rejected',
        message:
          cashBuyInRefusalText(outcome.error) ??
          (/^SEAT_RESERVED:/.test(errorText(outcome.error))
            ? 'That Seat Was Just Taken. Try Again.'
            : 'The Server Refused This Buy-In.'),
      };
    }
    return {
      kind: 'seated',
      tableId: held.table_id,
      poolSessionId: await deps.readPoolSession(args.clusterId).catch(() => null),
    };
  }
  return { kind: 'rejected', message: 'That Seat Was Just Taken. Try Again.' };
}

/* ─── The amount the player chose last time (per device, per game) ───────────
   A reminder only: it pre-fills the amount question, which the player still
   confirms. The first visit keeps Dan's default (the maximum, capped by the
   wallet). Storage that is blocked or full simply forgets. */
const LAST_BUY_IN_KEY = 'ca.lightning.last-buyin.v1';

function readLastBuyIns(): Record<string, number> {
  try {
    const raw = typeof localStorage === 'undefined' ? null : localStorage.getItem(LAST_BUY_IN_KEY);
    const parsed = raw ? (JSON.parse(raw) as unknown) : null;
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, number>) : {};
  } catch {
    return {};
  }
}

export function rememberLightningBuyIn(clusterId: string, amount: number): void {
  if (!Number.isFinite(amount) || amount <= 0) return;
  try {
    const all = readLastBuyIns();
    all[clusterId] = Math.round(amount * 100) / 100;
    localStorage.setItem(LAST_BUY_IN_KEY, JSON.stringify(all));
  } catch {
    /* forgotten */
  }
}

/** The pre-filled amount: last time's, inside today's range and wallet; else none. */
export function rememberedLightningBuyIn(
  clusterId: string,
  context: Pick<LightningBuyInContext, 'minBuyIn' | 'maxBuyIn' | 'balance'>
): number | undefined {
  const last = Number(readLastBuyIns()[clusterId]);
  if (!Number.isFinite(last) || last <= 0) return undefined;
  const ceiling =
    context.balance !== null ? Math.min(context.maxBuyIn, context.balance) : context.maxBuyIn;
  if (ceiling < context.minBuyIn) return undefined;
  return Math.min(Math.max(last, context.minBuyIn), ceiling);
}
