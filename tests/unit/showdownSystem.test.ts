/**
 * SHOWDOWN SYSTEM 2026-08-25 — the client half of Dan's showdown spec,
 * pinned the way this repo pins engine↔client contracts: by reading the
 * source at both ends (see winningCardHighlight.test.ts, the file whose five
 * skipped specs this work un-skipped).
 *
 * What must stay true:
 *   - the engine's showdown event carries the reveal SEQUENCE and muck
 *     ruling (reveal_order, mucked) and pot_win carries hand_description +
 *     hole_card_indices per winner;
 *   - a mucked hand is withheld from every public reveal surface;
 *   - the client's hand-complete reset holds for the sequenced holdMs it
 *     already computes, not a hard-coded 3000;
 *   - the seat can render a MUCKED label and the board a secondary hand
 *     description, and both have CSS behind them.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { HAND_COMPLETION } from '../../src/config/handCompletionSpec';
import { sliceEnclosingBlock, sliceBlockAfter } from '../helpers/sourceWindow';

const strip = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
const read = (p: string) => readFileSync(resolve(__dirname, '../../', p), 'utf8');

const EVENTS = strip(read('server/src/engine/ServerTableEngineHandEvents.ts'));
const ENGINE = strip(read('server/src/engine/ServerTableEngine.ts'));
const TABLE_PAGE = strip(read('src/pages/TablePage.tsx'));
const SEAT = strip(read('src/components/table/SeatSlot.tsx'));
const SEAT_CSS = read('src/components/table/SeatSlot.css');
const BOARD = strip(read('src/components/table/CommunityCards.tsx'));
const BOARD_CSS = read('src/components/table/CommunityCards.css');

describe('the engine PUBLISHES the showdown sequence and muck ruling', () => {
  it('the showdown event carries reveal_order and mucked per result', () => {
    const sd = sliceEnclosingBlock(EVENTS, "type: 'showdown',");
    expect(sd).toMatch(/reveal_order:/);
    expect(sd).toMatch(/mucked/);
  });

  it('pot_win winners carry hand_description and hole_card_indices', () => {
    const potWin = sliceEnclosingBlock(EVENTS, "type: 'pot_win'");
    expect(potWin).toMatch(/hand_description:/);
    expect(potWin).toMatch(/hole_card_indices:/);
  });

  it('a mucked hand is excluded from showdown_cards_revealed', () => {
    // The reveals list is filtered by the muck ruling before the emit.
    // 2026-09-09: 3 -> 4 levels. The emit gained a `try { ... } catch` (a throw
    // out of hub.emitEvent used to abandon the pot-shipping block that follows
    // it), which puts one more brace between the payload and the `const
    // reveals = ...` filter this asserts on. Same property, one level further
    // out; nothing about the muck ruling changed.
    const emit = sliceEnclosingBlock(EVENTS, "type: 'showdown_cards_revealed'", 0, 4);
    expect(emit).toMatch(/isMuckedAtShowdown/);
  });

  it('the snapshot reveal gate and the resync gate both respect the muck', () => {
    // broadcastCurrentState's showCards calc + getTableState's reveal branch.
    const gates = ENGINE.match(/isMuckedAtShowdown/g) || [];
    expect(gates.length).toBeGreaterThanOrEqual(3);
    expect(ENGINE).toMatch(/is_mucked:/);
  });

  it('pot_distributed reads the real eligiblePlayers field', () => {
    const emit = sliceEnclosingBlock(EVENTS, "type: 'pot_distributed'", 0, 3);
    expect(emit).toMatch(/p\.eligiblePlayers/);
  });
});

describe('the client RENDERS the sequence, the muck, and the description', () => {
  it('the hand-complete reset holds for the computed holdMs, never a bare 3000', () => {
    /* 2026-08-26: this used to assert the literal `}, holdMs);` — the exact
       punctuation of one call site. The reset became EXTENDABLE (the callback
       is captured in a ref so POT_WIN can re-arm it once the award sequence's
       true length is known), so the shape changed while the property being
       guarded did not. Assert the property: the timer is armed with the
       COMPUTED hold, not a hardcoded number. */
    expect(TABLE_PAGE).toMatch(/window\.setTimeout\([\s\S]{0,120}?holdMs\s*\)/);
    /* Scoped to the RESET's own timer. An earlier draft of this line matched
       any `}, 3000);` in the file and caught the BBJ celebration's unrelated
       3s delay — a test that fails on correct code teaches people to delete
       tests. What must never come back is the reset itself being armed with a
       literal. */
    expect(TABLE_PAGE, 'the hand-complete reset is armed with a literal again').not.toMatch(
      /handCompleteTimerRef\.current = window\.setTimeout\([\s\S]{0,160}?,\s*\d{3,}\s*\)/
    );
  });

  /**
   * Dan 2026-08-26: "the board never displayed the winning hand, or played the
   * push pot and total animation to the winner. This needs to happen 100% of
   * the time after every single hand."
   *
   * The hold was scheduled once from HAND_COMPLETE, which the engine emits
   * ~3s BEFORE pot_win — so the code that tried to stretch it read the
   * PREVIOUS hand's animation-end stamp and did nothing. On a slow animation
   * setting the winner label and the pot push were wiped mid-flight.
   */
  it('POT_WIN can extend the reset, and only ever later', () => {
    expect(TABLE_PAGE, 'the reset callback must be re-armable').toMatch(/handCompleteResetFnRef/);
    expect(TABLE_PAGE, 'the due time must be tracked to compare against').toMatch(
      /handCompleteResetAtRef/
    );
    // The guard that makes it one-directional.
    expect(TABLE_PAGE, 'the extension must refuse to pull the reset earlier').toMatch(
      /wantResetAt > handCompleteResetAtRef\.current/
    );
  });

  it('a fold-around win still names a winner and pushes a real pot', () => {
    /* An uncontested win has no showdown, so the engine ships hand_name
       undefined by construction and every `{winningHandName && ...}` consumer
       rendered nothing — silence on the commonest hand in poker. */
    expect(TABLE_PAGE, 'no fallback label for an uncontested win').toMatch(/'Wins The Pot'/);
    /* And the pot pill had no non-zero total to carry on that hand, because
       mainPot === streetBets all the way through it. */
    expect(TABLE_PAGE, 'the push carries no awarded amount').toMatch(/awardedPot=\{/);
  });

  it('the pot push is not restricted to a single winner', () => {
    /* A chop used to get no push at all ("no one seat to push to"); it now
       pushes to the midpoint of the winning seats. */
    expect(TABLE_PAGE, 'the single-winner gate on the pot push is back').not.toMatch(
      /if \(winnerIds\.length === 1\) \{/
    );
  });

  it('the seat accepts the MUCKED ruling and the reveal stagger', () => {
    expect(SEAT).toMatch(/isMuckedShowdown/);
    expect(SEAT).toMatch(/showdownRevealDelayMs/);
    expect(SEAT).toMatch(/seat__mucked-label/);
    expect(SEAT_CSS).toMatch(/\.seat__mucked-label/);
  });

  it('the seat lights exactly the winning hole cards when the engine names them', () => {
    expect(SEAT).toMatch(/winningHoleCardIndexes/);
    expect(TABLE_PAGE).toMatch(/hole_card_indices/);
  });

  it('the board renders the secondary hand description', () => {
    expect(BOARD).toMatch(/winningHandDescription/);
    expect(BOARD).toMatch(/community-cards__hand-description/);
    expect(BOARD_CSS).toMatch(/\.community-cards__hand-description/);
  });

  it('the reveal stagger is a shared spec constant, small enough to fit the read window', () => {
    expect(HAND_COMPLETION.SHOWDOWN_REVEAL_STAGGER_MS).toBeGreaterThan(0);
    // Even a 9-way showdown's last flip must land inside the read window.
    expect(8 * HAND_COMPLETION.SHOWDOWN_REVEAL_STAGGER_MS).toBeLessThanOrEqual(
      HAND_COMPLETION.SHOWDOWN_READ_MAX_MS
    );
  });

  it('the TablePage consumes the showdown event sequence', () => {
    expect(TABLE_PAGE).toMatch(/reveal_order/);
    expect(TABLE_PAGE).toMatch(/setMuckedLabelSeats/);
    expect(TABLE_PAGE).toMatch(/SHOWDOWN_REVEAL_STAGGER_MS/);
  });
});

/**
 * SHOWDOWN follow-ups 2026-08-25 — the three items Dan approved after the
 * compliance audit: sequenced multi-pot awards (spec 16/19), stack-update
 * timing (spec 21), and the prompt-free AUTO-MUCK setting (spec 37).
 */
describe('follow-up: pots are AWARDED as a sequence (spec 16/19)', () => {
  it("the engine names each winner's pot in pot_win", () => {
    const potWin = sliceEnclosingBlock(EVENTS, "type: 'pot_win'");
    expect(potWin).toMatch(/pot_index:/);
  });

  it('the client staggers award groups by the shared spec constant', () => {
    expect(TABLE_PAGE).toMatch(/POT_AWARD_STAGGER_MS/);
    expect(TABLE_PAGE).toMatch(/potAwardStaggerTimersRef/);
    expect(HAND_COMPLETION.POT_AWARD_STAGGER_MS).toBeGreaterThan(0);
  });

  it('a late side-pot award can never fire into the next hand', () => {
    // The stagger timers are cancelled in the HAND_STARTED reset and on unmount.
    const cancels =
      TABLE_PAGE.match(
        /for \(const t of potAwardStaggerTimersRef\.current\) clearTimeout\(t\);/g
      ) || [];
    expect(cancels.length).toBeGreaterThanOrEqual(2);
  });
});

describe('follow-up: the stack rises only when the pot arrives (spec 21)', () => {
  it('winner seats hold stack minus the pending share until release', () => {
    expect(TABLE_PAGE).toMatch(/stackHoldReleased/);
    // SHOWDOWN POLISH 2026-08-25: the hold arithmetic moved to the pure,
    // unit-tested pendingStackHold (lib/showdownPresentation).
    expect(TABLE_PAGE).toMatch(/pendingStackHold\(/);
    expect(TABLE_PAGE).toMatch(/stack: Math\.max\(0, displayPlayer\.stack - held\)/);
  });

  it('the hold is released by the POT_WIN timer and re-armed at HAND_STARTED', () => {
    expect(TABLE_PAGE).toMatch(/setStackHoldReleased\(true\)/);
    expect(TABLE_PAGE).toMatch(/setStackHoldReleased\(false\)/);
    expect(TABLE_PAGE).toMatch(/stackHoldReleaseTimerRef/);
  });
});

describe('follow-up: AUTO-MUCK is a real setting, with no prompt (spec 37)', () => {
  const SETTINGS_HOOK = strip(read('src/hooks/useTableSettings.ts'));
  const PANEL = strip(read('src/components/table/SettingsPanel.tsx'));

  it('auto-muck defaults ON', () => {
    expect(SETTINGS_HOOK).toMatch(/autoMuck:\s*true/);
  });

  it('switching it off answers the engine muck ruling with a voluntary show — never a prompt', () => {
    expect(TABLE_PAGE).toMatch(/userSettingsRef\.current\.autoMuck === false/);
    expect(TABLE_PAGE).toMatch(/GameServerAPI\.showHand\(tableId\)/);
    expect(TABLE_PAGE).toMatch(/autoShowFiredHandRef/);
  });

  it('the toggle is back in the table settings panel and round-trips to the autoMuck key', () => {
    expect(PANEL).toMatch(/Auto-Muck Losing Hands/);
    expect(PANEL).toMatch(/handleToggle\('autoMuckLosers'\)/);
    expect(TABLE_PAGE).toMatch(/updateSetting\('autoMuck', settingsUpdate\.autoMuckLosers\)/);
  });
});

/**
 * SHOWDOWN AUDIT 2026-08-25 — wire pins for the adversarial-review fixes.
 */
describe('audit: the snapshot winners wire actually matches at both ends', () => {
  it('the engine emits user_id on snapshot winners (the key the mapper reads)', () => {
    expect(sliceEnclosingBlock(ENGINE, 'winners:')).toMatch(/user_id:\s*w\.userId/);
  });

  it('the mapper accepts both user_id and legacy userId', () => {
    const MAPPER = strip(read('src/utils/mapEngineSnapshot.ts'));
    expect(MAPPER).toMatch(/w\.user_id \?\? \(w as unknown as \{ userId\?: string \}\)\.userId/);
  });
});

describe('audit: showdown event ordering and muck-label reconciliation', () => {
  it('the showdown event is emitted BEFORE the revealing snapshot', () => {
    const sdCase = EVENTS.slice(EVENTS.indexOf("case 'SHOWDOWN':"));
    const emitAt = sdCase.indexOf("type: 'showdown',");
    const broadcastAt = sdCase.indexOf('this.broadcastCurrentState()');
    expect(emitAt).toBeGreaterThan(-1);
    expect(broadcastAt).toBeGreaterThan(-1);
    expect(emitAt).toBeLessThan(broadcastAt);
  });

  it('the MUCKED label unions the event mask with the snapshot flag and clears on reveal', () => {
    expect(TABLE_PAGE).toMatch(/muckedLabelSeats\[idx\] \|\| player\?\.isMucked === true/);
    expect(TABLE_PAGE).toMatch(
      /!\(player\?\.showCards && \(player\?\.holeCards\?\.length \?\? 0\) > 0\)/
    );
  });

  it('a plays-the-board winner keeps its EMPTY hole_card_indices (no false highlight)', () => {
    expect(TABLE_PAGE).toMatch(/if \(Array\.isArray\(w\.hole_card_indices\)\) \{/);
  });
});

describe('audit: engine muck rules cover the cases the review found', () => {
  const CONTROLLER = strip(read('server/src/engine/HandController.ts'));

  it('an all-in showdown without a runout still exposes every live hand', () => {
    expect(CONTROLLER).toMatch(/liveCanStillBet/);
    expect(CONTROLLER).toMatch(/if \(liveCanStillBet <= 1\) return;/);
  });

  it('four of a kind or better can never be mucked — on any board', () => {
    // TRIPLE-BOARD 2026-08-27: the condition is multi-line now and covers
    // hand3 as well, so the pattern tolerates whitespace between the clauses.
    expect(CONTROLLER).toMatch(
      /r\.hand\.ranking >= 8 \|\|\s*\(r\.hand2 && r\.hand2\.ranking >= 8\) \|\|\s*\(r\.hand3 && r\.hand3\.ranking >= 8\)/
    );
  });

  it("double-board hi-lo tracks board 2's low half", () => {
    expect(CONTROLLER).toMatch(/bestShownLo2/);
    expect(CONTROLLER).toMatch(/lowByUser2/);
    expect(CONTROLLER).toMatch(/evaluateOmahaLowHand\(r\.cards, this\.state\.communityCards2\)/);
  });

  it("triple-board hi-lo tracks board 3's low half too", () => {
    expect(CONTROLLER).toMatch(/bestShownLo3/);
    expect(CONTROLLER).toMatch(/lowByUser3/);
    expect(CONTROLLER).toMatch(/evaluateOmahaLowHand\(r\.cards, this\.state\.communityCards3\)/);
  });
});

/**
 * SHOWDOWN POLISH 2026-08-25 — wire pins for the full enhancement batch:
 * per-pot awards, RIT parity, hi-lo labels, invariant guard, persistence,
 * event ordering, and observability.
 */
describe('polish: per-pot awards ride the wire end to end (spec 16/19/33)', () => {
  const CONTROLLER = strip(read('server/src/engine/HandController.ts'));
  const POKER = strip(read('server/src/engine/PokerEngine.ts'));

  it('the engine collects an UNMERGED per-pot breakdown alongside the merged winners', () => {
    expect(POKER).toMatch(/perPotOut\?: PerPotAward\[\]/);
    expect(CONTROLLER).toMatch(/pendingPerPotAwards/);
    expect(CONTROLLER).toMatch(/perPotAwards: scaledPerPot/);
  });

  it('pot_win carries ordered pot_awards groups and the client sequences from them', () => {
    /* 2026-08-26: the groups are captured BEFORE the settle hold — reading
       them live after the sleep lost them to HAND_COMPLETE's reset, which is
       how pot_win died on every contested showdown. */
    expect(EVENTS).toMatch(/const capturedPotAwards = this\.buildPotAwardGroups\(\);/);
    expect(EVENTS).toMatch(/pot_awards: capturedPotAwards/);
    expect(TABLE_PAGE).toMatch(/buildAwardGroups\(/);
    expect(TABLE_PAGE).toMatch(/boardLabelFromAwards\(/);
  });

  it('the hi-lo LOW WINNER line renders above the board', () => {
    expect(TABLE_PAGE).toMatch(/lowWinnerLabel/);
    expect(BOARD).toMatch(/community-cards__low-winner/);
    expect(BOARD_CSS).toMatch(/\.community-cards__low-winner/);
  });
});

describe('polish: RIT hands get the same showdown presentation', () => {
  const RUNOUT = strip(read('server/src/engine/ServerTableEngineRunout.ts'));

  it('the RIT path emits the showdown event with reveal metadata', () => {
    const at = RUNOUT.indexOf('dealAndResolveRIT');
    expect(at).toBeGreaterThan(-1);
    const body = RUNOUT.slice(at);
    expect(body).toMatch(/type: 'showdown'/);
    expect(body).toMatch(/reveal_order/);
    expect(body).toMatch(/describeHand\(/);
  });
});

describe('polish: the mucked-winner invariant is guarded per hand', () => {
  const SETTLE = strip(read('server/src/engine/ServerTableEngineSettlement.ts'));

  it('a paid-but-hidden winner raises a critical financial alert', () => {
    expect(SETTLE).toMatch(/mucked_winner_invariant/);
    expect(SETTLE).toMatch(/paidButHidden/);
  });

  it('the reveal record is persisted to hand_history.showdown', () => {
    expect(SETTLE).toMatch(/showdownReveal/);
    const HH = strip(read('server/src/services/supabase/handHistory.ts'));
    expect(HH).toMatch(/showdown: params\.showdownReveal/);
  });

  it('muck-rate metrics exist and are incremented at showdown', () => {
    const METRICS = strip(read('server/src/observability/engineInstruments.ts'));
    expect(METRICS).toMatch(/poker_showdown_hands_total/);
    expect(METRICS).toMatch(/poker_mucked_hands_total/);
    expect(EVENTS).toMatch(/showdownHandsTotal\.inc/);
    expect(EVENTS).toMatch(/muckedHandsTotal\.inc/);
  });
});

describe('polish: deterministic event ordering + consumed reveal event', () => {
  it('hub EVENTs carry a per-table seq', () => {
    const HUB = strip(read('server/src/transport/TableStateHub.ts'));
    expect(HUB).toMatch(/eventSeqs/);
    // BBJ build plan phase 1 (2026-09-05): the envelope also carries the
    // engine's clock (`ts`) between seq and payload; the seq pin is unchanged.
    expect(HUB).toMatch(/type: 'EVENT', tableId, seq, ts: Date\.now\(\), payload/);
  });

  it('inbound frames drain through ONE ordered FIFO (the reveal race fix, review revision)', () => {
    // Review revision 2026-08-25: the original requeue design re-inserted a
    // state frame at the BACK of the queue, so an event arriving after it
    // could still leapfrog. Now every frame joins one inbox in arrival order
    // (state frames keep a fast path only when nothing is queued), the drain
    // dispatches at most one EVENT per macrotask, the hub's event seq is
    // consumed for de-duplication, and connect/disconnect clear the queue.
    // Behavior is pinned end-to-end in tests/engine-event-ordering.test.ts;
    // this pins the structure so a refactor cannot quietly drop a leg.
    const ESC = strip(read('src/services/EngineStateClient.ts'));
    expect(ESC).toMatch(/private inbox: ServerMessage\[\]/);
    expect(ESC).toMatch(/drainInbox/);
    expect(ESC).toMatch(/lastEventSeq/);
    expect(ESC).toMatch(/resetInbox/);
    expect(ESC).not.toMatch(/pendingEvents/);
  });

  it('showdown_cards_revealed is consumed as reveal reconciliation', () => {
    expect(TABLE_PAGE).toMatch(/case 'SHOWDOWN_CARDS_REVEALED'/);
    expect(TABLE_PAGE).toMatch(/mucked_players/);
  });
});

describe('polish: rank-aware cue and replay reveal record', () => {
  it('quads-or-better at reveal gets the big-win fanfare, muck-safe', () => {
    const body = sliceBlockAfter(TABLE_PAGE, "case 'SHOWDOWN'");
    expect(body).toMatch(/hand_ranking \?\? 0\) >= 8/);
    expect(body).toMatch(/playBigWin\(\)/);
  });

  it('replays surface the persisted reveal record — order, muck, description', () => {
    const HHS = strip(read('src/services/HandHistoryService.ts'));
    expect(HHS).toMatch(/showdown_reveal/);
    const REPLAY = strip(read('src/components/replay/HandReplay.tsx'));
    expect(REPLAY).toMatch(/showdown_reveal/);
    expect(REPLAY).toMatch(/player-hand-ranking--mucked/);
  });
});
