/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  HAND REPLAY BY ID — /share/hand/:handId
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * The door a hand's own Copy Link opens (Phase 1) and the address a player
 * bookmarks. It renders the ONE replayer, off the one reconstruction, exactly
 * as the table's Previous Hand modal and the Hand Archive do.
 *
 * PHASE 4 2026-09-05 — WHAT THIS PAGE USED TO BE. It was the platform's
 * SECOND replayer and it did not share a line with the first: its own
 * `HandData` shape, mapped by hand out of the service record; its own action
 * timeline; a board revealed by STEP NUMBER (`currentStep < 4` meant preflop,
 * `< 6` the flop) rather than by street, so a hand whose preflop ran more than
 * four actions dealt its flop in the middle of the betting and a hand with
 * fewer never dealt one at all; a 1500ms fixed tick that ignored the player's
 * Animation Speed; and a 3D felt behind it (`HandReplay3D`, gsap) that only
 * this page opened. None of it knew about run-it-twice boards, dead money,
 * hi-lo halves, rake, the discard street, or the four ways the old timeline
 * lied that `utils/replayFrames.ts` documents.
 *
 * A second replayer is not a second feature. It is a second set of bugs on
 * the same hand, and the reason a defect fixed on one surface kept being
 * reported on another. There is one now.
 *
 * RLS STILL APPLIES HERE, and it should: this route READS `hand_history`, and
 * that table's SELECT policy is the hand's own participants. A link to this
 * address is for the people who played the hand. The link a player SHARES with
 * anyone else is `/replay?h=<payload>` (ShareHand), which carries the hand
 * inside it and needs no read at all.
 */

import { useEffect } from 'react';
import { useParams } from 'react-router-dom';
import HandReplay from '../../components/replay/HandReplay';
import './HandReplayerPage.css';

export default function HandReplayerPage() {
  const { handId } = useParams<{ handId: string }>();

  useEffect(() => {
    document.title = 'Hand Replay | Club Arena';
  }, []);

  return (
    <div className="hand-replayer-page">
      <HandReplay handId={handId} />
    </div>
  );
}
