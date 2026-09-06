/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  SHARED HAND REPLAY — /replay?h=<encoded>
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * VISIBLE FIX 2026-08-15: every shared-hand link was a 404.
 *
 * ShareHand builds links as `/hub/club-arena/replay?h=<base64>` — copy link,
 * Twitter, Facebook, Telegram, WhatsApp, native share and the iframe embed all
 * used it — but no `/replay` route existed, so every one of them fell through
 * to the SPA catch-all 404. The only real route, `/share/hand/:handId`, reads
 * `hand_history` directly, whose RLS restricts SELECT to hand participants —
 * so even a corrected link showed "Hand Not Found" to the person it was
 * shared with, which is everyone.
 *
 * Decoding the payload that already travels inside the link fixes both at
 * once: the route exists, and the viewer needs no database read at all, so a
 * recipient who never played the hand (or is logged out) can watch it.
 *
 * PHASE 4 2026-09-05 — AND NOW THEY WATCH IT ON THE SAME REPLAYER. This page
 * used to render its own flat list of streets: seat numbers, verbs and
 * amounts down the page, with no felt, no motion, no run-it-twice board, no
 * rake and no way to step through anything. It rebuilds the sharer's model
 * from the link (`replayFromShareable` -> `buildReplay`, the one
 * reconstruction) and hands it to `HandReplay`, which is the component the
 * table, the archive and the modal all open. There is one replayer now.
 *
 * NOTHING HERE READS THE DATABASE. The model is built from the payload, which
 * is what makes the link work for a recipient who is not signed in.
 */

import { useMemo } from 'react';
import { useSearchParams, Link } from 'react-router-dom';
import { decodeHandFromUrl, type ShareableHand } from '../../components/table/ShareHand';
import HandReplay, { type ReplaySource } from '../../components/replay/HandReplay';
import { replayFromShareable, shareUserId } from '../../lib/shareHandModel';
import { reportError } from '../../utils/errorReporter';
import './SharedHandReplayPage.css';

function sourceFrom(hand: ShareableHand): ReplaySource | null {
  try {
    const model = replayFromShareable(hand);
    /* A payload that decodes but holds no players is not a hand. Better an
       honest "not readable" than a felt with nobody at it. */
    if (!model.players.length) return null;
    const hero = hand.players.find((p) => p.isHero);
    const reveals: Record<string, { mucked?: boolean }> = {};
    for (const p of hand.players) {
      if (p.mucked) reveals[shareUserId(p.seat)] = { mucked: true };
    }
    return {
      model,
      tableName: hand.tableName || null,
      handNumber: hand.handNumber ?? null,
      gameType: hand.variant,
      /* The SHARER's seat, not the reader's. The reader may be anybody. */
      viewerId: hero ? shareUserId(hero.seat) : null,
      reveals,
      /* All-in equity and EV are the sharer's own private facts and do not
         travel in a link. Absent, rather than reconstructed from the board. */
      viewerFacts: null,
    };
  } catch (e) {
    reportError(e, 'SharedHandReplayPage.Failed_to_build_model');
    return null;
  }
}

export default function SharedHandReplayPage() {
  const [params] = useSearchParams();
  const encoded = params.get('h');

  const hand: ShareableHand | null = useMemo(
    () => (encoded ? decodeHandFromUrl(encoded) : null),
    [encoded]
  );
  const source = useMemo(() => (hand ? sourceFrom(hand) : null), [hand]);

  if (!hand || !source) {
    return (
      <div className="shared-replay shared-replay--empty">
        <h1 className="shared-replay__title">This Replay Link Is Not Readable</h1>
        <p className="shared-replay__body">
          The Link May Have Been Truncated When It Was Copied. Ask For It Again, Or Open The Hand
          From Your Own Hand History.
        </p>
        <Link className="shared-replay__link" to="/">
          Go To The Lobby
        </Link>
      </div>
    );
  }

  const hero = hand.players.find((p) => p.isHero);

  return (
    <div className="shared-replay">
      <HandReplay source={source} />
      <footer className="shared-replay__footer">
        {hero ? `Shared From ${hero.name}'s Hand History · ` : ''}Smarter Poker
      </footer>
    </div>
  );
}
