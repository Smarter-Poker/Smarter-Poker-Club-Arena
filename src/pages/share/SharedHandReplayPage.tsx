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
 *
 * PHASE 9.1 2026-09-30 - CLIP MODE, AND 2026-10-07 - THE CLIP IS THE ARENA'S
 * OWN REPLAYER. The hand clip renderer (World Hub,
 * `/api/cron/render-hand-clips`) opens this route as `/replay?clip=1` in a
 * headless browser with the hand injected as `window.__SP_CLIP__` before any
 * script runs (contract C1), because this route needs no sign-in and no
 * database read. When both are present, and only then, the page builds the
 * `ReplaySource` HandReplay builds for a hand it fetched by id
 * (`clipSourceFrom`: the archive's reconstruction straight from the record,
 * the table's name, the hand number, the variant, the reveal record, the
 * hero as the viewer) and renders the replayer inside the same 900px column
 * the arena's by-id page (/share/hand/:id) holds it in, and NOTHING ELSE:
 * no "Shared From" footer, because the arena's replayer has none. The only
 * addition is the camera contract (`HandReplay`'s `clip` prop:
 * `data-clip-state`, `data-clip-step`, `window.__spClip`, the fitted rate,
 * no sound). Until 2026-10-07 the clip was a stripped felt of its own, with
 * seat numbers for names and no header; the first fix made it this share
 * page, which rebuilds the hand from the link's wire (whose last frame
 * leaves the winner's stack short by the pot) under a footer the arena
 * never shows; by owner decision (Dan,
 * 2026-10-07) the reference is the hand replayer inside Club Arena, pixel
 * for pixel. The renderer sets a 4:5 portrait viewport, 1080x1350; the
 * clip-only page frame centres that unchanged replayer vertically so the
 * camera does not leave its whole lower third empty. Still no `h=` needed,
 * still no database read. A `clip=1` link WITHOUT the injected payload is an
 * ordinary link and still needs `h=`; a malformed payload is not a clip either.
 */

import { useMemo } from 'react';
import { useSearchParams, Link } from 'react-router-dom';
import { decodeHandFromUrl, type ShareableHand } from '../../components/table/ShareHand';
import HandReplay, { type ReplaySource } from '../../components/replay/HandReplay';
import { replayFromShareable, shareUserId } from '../../lib/shareHandModel';
import { clipSourceFrom, readClipPayload, type ClipPayload } from '../../lib/clipMode';
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

/**
 * The clip's source: what the arena's replayer renders for this hand, built
 * from the payload; null when the payload cannot be built into a hand.
 */
function clipSourceOf(payload: ClipPayload): ReplaySource | null {
  try {
    const source = clipSourceFrom(payload);
    /* A payload that reads but holds no players is not a hand. Better an
       honest "not readable" than a felt with nobody at it. */
    return source.model.players.length ? source : null;
  } catch (e) {
    reportError(e, 'SharedHandReplayPage.Failed_to_build_clip');
    return null;
  }
}

export default function SharedHandReplayPage() {
  const [params] = useSearchParams();
  const encoded = params.get('h');
  const clipRequested = params.get('clip') === '1';

  /* Read once per mount: the renderer injects the payload before any script
     runs, so it is either there on the first render or never. */
  const clipPayload = useMemo(
    () => (clipRequested && typeof window !== 'undefined' ? readClipPayload(window) : null),
    [clipRequested]
  );
  /* Memoised like `source`: HandReplay rewinds whenever either changes. */
  const clipWindow = useMemo(
    () => (clipPayload ? { minMs: clipPayload.minMs, maxMs: clipPayload.maxMs } : null),
    [clipPayload]
  );

  /* THE LINK'S HAND, for a visitor. A clip never decodes one: its hand is the
     payload, and it never needs `h=`. */
  const hand: ShareableHand | null = useMemo(
    () => (clipPayload || !encoded ? null : decodeHandFromUrl(encoded)),
    [encoded, clipPayload]
  );
  /* ONE SOURCE, whichever door it came through: the arena's own, from the
     payload, when this is a clip; the link's otherwise. A clip whose payload
     cannot be built into a hand reads as not readable, exactly as a broken
     link does. */
  const source = useMemo(
    () => (clipPayload ? clipSourceOf(clipPayload) : hand ? sourceFrom(hand) : null),
    [clipPayload, hand]
  );

  if (!source) {
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

  /* THE CLIP IS THE ARENA'S REPLAYER (owner decision, Dan, 2026-10-07): the
     replayer in the column the arena's by-id page holds it in
     (`.shared-replay` and `.hand-replayer-page` are the same frame), and
     nothing else. No footer: the arena's replayer has none. The camera
     contract (`clip`) is the only addition. */
  if (clipPayload) {
    return (
      <div className="shared-replay shared-replay--clip">
        <HandReplay source={source} clip={clipWindow} />
      </div>
    );
  }

  const hero = hand?.players.find((p) => p.isHero);

  return (
    <div className="shared-replay">
      <HandReplay source={source} />
      <footer className="shared-replay__footer">
        {hero ? `Shared From ${hero.name}'s Hand History · ` : ''}Smarter Poker
      </footer>
    </div>
  );
}
