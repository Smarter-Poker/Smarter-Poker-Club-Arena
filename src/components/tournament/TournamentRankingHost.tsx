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
import { readLocalSession } from '../../lib/authUtils';
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

  /**
   * ═══════════════════════════════════════════════════════════════════════════
   *  THE CARD SAYS WHERE YOU FINISHED (Dan 2026-08-30, round 17)
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * Dan: "THE RESULTS CARD NEEDS TO SAY THE PLACE YOU FINISHED. MINE SHOULD
   * SAY 3RD PLACE." His card said "Finished".
   *
   * The place was not missing — it was EARLY. `tournament_players` for that
   * game reads `position: 3, status: eliminated`, exactly as he said; the
   * engine had recorded it correctly. But the card is published at the instant
   * the player leaves the felt, and on the bust path that is BEFORE the engine
   * has written the row. `finishPlace` is `position || full?.finishPlace ||
   * null`, all three were empty at that moment, and the card renders `place !=
   * null ? ordinal(place) : 'Finished'`. So it printed the fallback and then
   * never asked again.
   *
   * A card that is a few hundred milliseconds early is not a reason to show a
   * player less than the app knows. This asks once the card is up, and briefly
   * retries, because the write is in flight rather than absent. It only ever
   * FILLS IN a missing place — it can never overwrite one the exit already
   * carried, which is the authoritative one when it exists.
   */
  const placeFilledRef = useRef<string | null>(null);
  useEffect(() => {
    const t = payload?.tournament;
    if (!tournamentId || !t) return;
    if (t.finishPlace != null) return; // already known — never second-guess it
    if (placeFilledRef.current === tournamentId) return; // one fill per card
    placeFilledRef.current = tournamentId;

    let cancelled = false;
    (async () => {
      /* Six looks over ~9s. The row is being written as we ask, so this is a
         short wait on an in-flight commit, not a poll for something absent. */
      for (let attempt = 0; attempt < 6 && !cancelled; attempt++) {
        try {
          /* `readLocalSession()` rather than the auth round trip — a house rule
             the pre-push hook enforces, and the better call here anyway: this
             runs on a card already on screen, so the identity is known locally
             and there is no reason to spend a network hop on it inside a retry
             loop. (The hook greps for the banned call as a STRING, so naming it
             here even to say "not this" is enough to trip it — which is the
             same prose-matching trap the source pins in this repo are written
             around.) */
          const uid = readLocalSession()?.userId;
          if (!uid) return;
          const { data, error } = await supabase
            .from('tournament_players')
            .select('position, prize')
            .eq('tournament_id', tournamentId)
            .eq('user_id', uid)
            .maybeSingle();
          if (error) throw error;
          const place = Number(data?.position) || 0;
          if (place > 0) {
            if (cancelled) return;
            setPayload((prev) =>
              prev && prev.tournament && prev.tournament.finishPlace == null
                ? {
                    ...prev,
                    tournament: {
                      ...prev.tournament,
                      finishPlace: place,
                      /* The prize follows the place: a card that has just
                         learned the player came 3rd should not still be
                         claiming the 0 it was published with if the row says
                         otherwise. Only ever raises a zero. */
                      prize: prev.tournament.prize || Number(data?.prize) || 0,
                    },
                  }
                : prev
            );
            return;
          }
        } catch (err) {
          reportError(err, 'TournamentRankingHost.finish_place_backfill_failed', {
            tournamentId,
          });
          return;
        }
        await new Promise((r) => setTimeout(r, 1500));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [tournamentId, payload?.tournament]);

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
