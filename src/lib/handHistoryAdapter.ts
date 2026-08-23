/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  HAND HISTORY ADAPTER — service row shape -> panel view model
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Moved out of TablePage.tsx on 2026-08-19 (see tableSeatGeometry for why that
 * file is being emptied). This one is worth pinning: it is the only thing
 * standing between the stored hand and what a player is shown about a hand they
 * already played — the pot, who won, how much, and their own result. A quiet
 * change here misreports money after the fact, and there is nothing on screen
 * to suggest the number came out wrong.
 */
import type { HandRecord as ServiceHandRecord } from '../services/HandHistoryService';
import type { HandRecord as PanelHandRecord } from '../components/table/HandHistoryPanel';
import { toCardCodes } from '../utils/cardCode';

/**
 * Dan 2026-08-15 — HandRecord adapter (build fix).
 *
 * There are two unrelated `HandRecord` types: the snake_case row shape
 * returned by HandHistoryService (the Supabase `hand_history` projection) and
 * the camelCase view-model HandHistoryPanel renders. Commit ee1a310f5 wired
 * the panel to the service and passed one straight into the other, which does
 * not typecheck — main was red. This maps between them explicitly.
 *
 * Two fields genuinely have no source in the row and are marked rather than
 * faked: per-street pot totals (only the final pot is stored) and per-player
 * stack at time of hand. Everything the panel actually displays — players,
 * positions, hole cards, actions by street, winners, hero result — is real.
 */
export function adaptServiceHandToPanel(h: ServiceHandRecord, heroId: string): PanelHandRecord {
  /* 2026-08-23: this used to be a local
   *   `(c: { rank, suit }) => `${c.rank}${c.suit.charAt(0)}``
   * applied to community_cards, which production stores as STRINGS with the
   * suit spelled out — ["Jdiamonds","6diamonds","4clubs",...]. `c.rank` was
   * undefined on every card of every hand, so the panel printed "UNDEFINE"
   * beside a diamond (the "d" of "undefined"). toCardCode knows every shape
   * the store holds, including the objects the hole_cards column really does
   * use, and refuses the literal "undefined" rather than parsing it as a rank.
   */
  const board = toCardCodes(h.community_cards);
  // Board is dealt 3/1/1; slice it back into the streets that revealed it.
  const streetCards: Record<string, string[] | undefined> = {
    preflop: undefined,
    flop: board.slice(0, 3),
    turn: board.slice(3, 4),
    river: board.slice(4, 5),
  };

  const nameFor = (uid: string) =>
    (h.players || []).find((p) => p.user_id === uid)?.username || 'Player';

  const streets = (['preflop', 'flop', 'turn', 'river'] as const)
    .map((name) => ({
      name,
      cards: streetCards[name]?.length ? streetCards[name] : undefined,
      actions: (h.actions || [])
        .filter((a) => a.street === name)
        .map((a) => ({
          playerId: a.player_id,
          playerName: nameFor(a.player_id),
          // Service says 'all-in'; the panel's union says 'allin'.
          action: (a.action === 'all-in' ? 'allin' : a.action) as
            | 'fold'
            | 'check'
            | 'call'
            | 'bet'
            | 'raise'
            | 'allin',
          amount: a.amount,
        })),
      pot: 0, // not stored per street — only the final pot is persisted
    }))
    .filter((s) => s.actions.length > 0 || s.cards);

  const potTotal = (h.main_pot || 0) + (h.side_pots || []).reduce((a, b) => a + (b || 0), 0);

  return {
    id: h.id,
    handNumber: h.hand_number,
    timestamp: Date.parse(h.played_at) || Date.now(),
    gameType: h.game_type,
    blinds: h.stakes,
    players: (h.players || []).map((p) => ({
      id: p.user_id,
      name: p.username,
      seat: p.seat,
      stack: 0, // not stored per hand in hand_history
      position: p.position,
      holeCards: toCardCodes(p.hole_cards).length ? toCardCodes(p.hole_cards) : undefined,
    })),
    streets,
    winners: (h.players || [])
      .filter((p) => p.is_winner)
      .map((p) => ({
        playerId: p.user_id,
        playerName: p.username,
        amount: p.result,
        hand: p.final_hand,
      })),
    heroId,
    heroResult: (h.players || []).find((p) => p.user_id === heroId)?.result ?? 0,
    potTotal,
  };
}
