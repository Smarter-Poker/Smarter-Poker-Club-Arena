/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  TOURNAMENT RANKING HOST — app-root owner of the bust card (2026-08-20)
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Sits beside SessionSummaryHost outside <Routes> and splits the same feed:
 *
 *   payload.tournament present  ->  this host renders the RANKING card
 *   payload.tournament absent   ->  SessionSummaryHost renders Session Complete
 *
 * One publisher, two cards, and the split is on the DATA rather than a flag, so
 * a tournament can never fall through to the cash summary and report a chip
 * profit for a seat where chips have no cash value.
 *
 * It lives at the app root for the reason the whole pendingSessionSummary
 * module exists: the player is mid-navigation when the result arrives, and
 * "the lobby" they land on is HomePage, ClubHomePage or ClubLobby depending on
 * where they came from. A route-level mount is torn down under them; this is
 * not.
 *
 * ── PLAY AGAIN IS A SEAT, NOT A LIST (2026-08-29, round 12) ────────────────
 *
 * The card's Play Again used to navigate to the tournaments list and leave
 * the player to find their own next game. For a seat-first game that is a
 * worse answer than the platform can give: the recycler keeps exactly one
 * open game per spin stake x variant and two per Heads-Up stake x variant
 * (measured in production this round, all 48 combinations covered), so the
 * next same-stake game ALWAYS exists. This host now finds it - same club,
 * same buy-in, same game type, same seat-first class as the game that just
 * ended, the scoping rule PR #1702 established - resolves its live table
 * through the same occupancy election the engine uses, and lands the player
 * on the felt to pick a seat. Nothing is charged by navigation; the seat is
 * only bought at the table's own confirm sheet.
 *
 * Every read is error-bound (the ratchet), and every miss - old payload
 * without the id, unreadable origin row, no sibling, no live table - falls
 * back to the card's own list navigation. A degraded answer, never a dead
 * end.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  clearSessionSummary,
  peekSessionSummary,
  subscribeSessionSummary,
  type SessionSummaryPayload,
} from '../../services/pendingSessionSummary';
import { supabase } from '../../lib/supabase';
import { tableService } from '../../services/TableService';
import { reportError } from '../../utils/errorReporter';
import TournamentRankingCard from './TournamentRankingCard';

export function TournamentRankingHost() {
  const [payload, setPayload] = useState<SessionSummaryPayload | null>(() => peekSessionSummary());
  const navigate = useNavigate();
  /* One tap only: a double-tap on Play Again while the sibling lookup is in
     flight must not start a second lookup or navigate twice. */
  const playAgainBusyRef = useRef(false);

  useEffect(() => subscribeSessionSummary(setPayload), []);

  const close = useCallback(() => clearSessionSummary(), []);

  const tournamentId = payload?.tournament?.tournamentId;

  const playAgain = useCallback(() => {
    /* The card's own fallback (tournaments list) handles the no-id case. */
    const fallback = () => {
      close();
      navigate(payload?.tournament?.isSpin ? '/tournaments?type=spin' : '/tournaments');
    };
    if (!tournamentId) {
      fallback();
      return;
    }
    if (playAgainBusyRef.current) return;
    playAgainBusyRef.current = true;

    void (async () => {
      try {
        const { data: origin, error: originErr } = await supabase
          .from('tournaments')
          .select('club_id, buy_in_amount, game_type, variant, max_players')
          .eq('id', tournamentId)
          .maybeSingle();
        if (originErr) throw originErr;

        /* Seat-first games only: an MTT's "again" genuinely is the list. */
        const seatFirst =
          origin &&
          (String(origin.variant) === 'spin' ||
            (Number(origin.max_players) > 0 && Number(origin.max_players) <= 2));
        if (!origin || !seatFirst) {
          fallback();
          return;
        }

        /* The sibling: same club, same stake, same game, same class - the
           scoping PR #1702 made law after the unscoped hop nearly seated a
           player in a stranger's club. Oldest first, matching the engine's
           own primary-table election bias. */
        let q = supabase
          .from('tournaments')
          .select('id')
          .eq('status', 'REGISTERING')
          .eq('buy_in_amount', origin.buy_in_amount)
          .eq('game_type', origin.game_type)
          .neq('id', tournamentId)
          .order('created_at', { ascending: true })
          .limit(1);
        if (origin.club_id) q = q.eq('club_id', origin.club_id);
        q =
          String(origin.variant) === 'spin'
            ? q.eq('variant', 'spin')
            : q.gt('max_players', 0).lte('max_players', 2);
        const { data: siblings, error: siblingErr } = await q;
        if (siblingErr) throw siblingErr;

        const sibling = siblings?.[0];
        if (!sibling) {
          fallback();
          return;
        }

        const liveTable = await tableService.resolveTournamentLiveTable(String(sibling.id));
        if (!liveTable) {
          fallback();
          return;
        }

        close();
        navigate(`/table/${liveTable}`);
      } catch (err) {
        reportError(err, 'TournamentRankingHost.play_again_sibling_lookup_failed', {
          tournamentId,
        });
        fallback();
      } finally {
        playAgainBusyRef.current = false;
      }
    })();
  }, [tournamentId, payload?.tournament?.isSpin, close, navigate]);

  if (!payload?.tournament) return null;

  return (
    <TournamentRankingCard
      result={payload.tournament}
      tableName={payload.tableName}
      /* The payload has always carried these; the card simply never asked for
         them. See the props on TournamentRankingCard. */
      durationSeconds={payload.duration}
      handsPlayed={payload.handsPlayed}
      endedAt={payload.sessionEnd}
      onDismiss={close}
      onPlayAgain={playAgain}
    />
  );
}

export default TournamentRankingHost;
