/**
 * ═══ A TURN HANDED BACK IS A TURN (2026-10-04) ═══════════════════════════════
 *
 * The player who closes a street and is first to act on the next one must be
 * shown that turn. Until this file existed they were not: the page withheld
 * every frame naming the seat that had just acted for 1500ms, the engine arms
 * the next street 500ms after dealing it, and nothing else is published until
 * the clock runs out. Production, week of 2026-09-28: 27 such human turns,
 * 85% past fourteen seconds, 67% force-resolved by the engine.
 *
 * THE FRAMES ARE THE ENGINE'S OWN. `SAME_SEAT_STREET_BOUNDARY` was captured
 * from the real ServerTableEngine + HandController (main at 1eb08f0c) with a
 * recording hub: seat 2, heads-up, calls the flop bet and is first to act on
 * the turn. Times are ms since the hand started; the call is sent at +2624.
 *
 * The first describe block keeps the PREVIOUS rule as a witness and shows what
 * it did to those frames. The rest pin the rule that replaced it.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { sliceBlockAfter } from '../helpers/sourceWindow';
import {
  HERO_ACTED_FENCE_MS,
  HERO_ACTED_FENCE_RELEASE_MARGIN_MS,
  armHeroActedFence,
  judgeSnapshotAgainstFence,
  judgeTurnChangeAgainstFence,
  releaseExpiredFence,
  shouldHandBackTurn,
  type HeroActedFence,
} from '@/lib/heroActedFence';

const HAND = 23670786;
const HERO_SEAT = 2;
const VILLAIN_SEAT = 6;
/** Wall clock at the instant the hero taps Call. */
const TAP = 1_800_000_000_000;
/** Engine clock at hand start. A different epoch on purpose: nothing may mix the two. */
const ENGINE_T0 = 1_799_999_400_000;

interface Frame {
  /** ms after the hero's tap that the frame reaches the page. */
  at: number;
  kind: 'snapshot' | 'turn_change';
  seat: number;
  decision: string | null;
  /** turn_start_time_ms, engine clock. */
  clock: number | null;
  /** The frame shows the named seat as folded. */
  folded?: boolean;
}

/** The decision seat 2 was looking at when it called. */
const ANSWERED = 'inc-1:flop:4:2:10';
const CLOCK_AT_ACT = ENGINE_T0 + 2423;

/** One round trip. The engine frames below are offset from the tap by this. */
const LATENCY = 60;

/**
 * Seat 2 calls on the flop, closing the street, and is first to act on the
 * turn. Captured engine order: the action broadcast, the street broadcast,
 * then (500ms later) the armed turn and its turn_change.
 */
const SAME_SEAT_STREET_BOUNDARY: Frame[] = [
  {
    at: LATENCY + 1,
    kind: 'snapshot',
    seat: 2,
    decision: 'inc-1:flop:5:2:10',
    clock: CLOCK_AT_ACT,
  },
  { at: LATENCY + 2, kind: 'snapshot', seat: 2, decision: 'inc-1:turn:5:2:0', clock: CLOCK_AT_ACT },
  {
    at: LATENCY + 502,
    kind: 'snapshot',
    seat: 2,
    decision: 'inc-1:turn:5:2:0',
    clock: ENGINE_T0 + 3126,
  },
  { at: LATENCY + 502, kind: 'turn_change', seat: 2, decision: 'inc-1:turn:5:2:0', clock: null },
];

/** Seat 2 checks mid-street and the engine moves the turn to seat 6. */
const TURN_MOVES_TO_ANOTHER_SEAT: Frame[] = [
  { at: LATENCY + 1, kind: 'snapshot', seat: 2, decision: 'inc-1:flop:3:2:0', clock: CLOCK_AT_ACT },
  {
    at: LATENCY + 3,
    kind: 'snapshot',
    seat: 6,
    decision: 'inc-1:flop:3:6:0',
    clock: ENGINE_T0 + 2222,
  },
  { at: LATENCY + 3, kind: 'turn_change', seat: 6, decision: 'inc-1:flop:3:6:0', clock: null },
];

/** Seat 2 closes the street but seat 6 opens the next one. */
const STREET_CLOSES_AND_ANOTHER_SEAT_OPENS: Frame[] = [
  {
    at: LATENCY + 1,
    kind: 'snapshot',
    seat: 2,
    decision: 'inc-1:flop:5:2:10',
    clock: CLOCK_AT_ACT,
  },
  // The engine has dealt the turn and not yet moved its actor: still seat 2.
  { at: LATENCY + 2, kind: 'snapshot', seat: 2, decision: 'inc-1:turn:5:2:0', clock: CLOCK_AT_ACT },
  {
    at: LATENCY + 502,
    kind: 'snapshot',
    seat: 6,
    decision: 'inc-1:turn:5:6:0',
    clock: ENGINE_T0 + 3126,
  },
  { at: LATENCY + 502, kind: 'turn_change', seat: 6, decision: 'inc-1:turn:5:6:0', clock: null },
];

/** Seat 2 calls the river: the hand goes to showdown still naming seat 2. */
const LAST_ACTION_OF_THE_HAND: Frame[] = [
  {
    at: LATENCY + 1,
    kind: 'snapshot',
    seat: 2,
    decision: 'inc-1:river:9:2:80',
    clock: CLOCK_AT_ACT,
  },
  // Showdown: no betting decision, so no action_context, and the engine's
  // actor field still holds the last seat to act.
  { at: LATENCY + 2, kind: 'snapshot', seat: 2, decision: null, clock: CLOCK_AT_ACT },
  { at: LATENCY + 1402, kind: 'snapshot', seat: 2, decision: null, clock: CLOCK_AT_ACT },
];

/**
 * Seat 2 folds heads-up and the hand is over. Captured engine order: the
 * action broadcast and the pot broadcast, both still naming seat 2 and both
 * carrying a betting context, because nothing moves the engine's actor or its
 * stage when a fold ends the hand. The decision seat 2 answered was
 * `preflop:1:2:15`.
 */
const FOLD_ANSWERED = 'inc-1:preflop:1:2:15';
const FOLD_ENDS_THE_HAND: Frame[] = [
  {
    at: LATENCY + 2,
    kind: 'snapshot',
    seat: 2,
    decision: 'inc-1:preflop:2:2:15',
    clock: CLOCK_AT_ACT,
    folded: true,
  },
  {
    at: LATENCY + 5,
    kind: 'snapshot',
    seat: 2,
    decision: 'inc-1:preflop:2:2:15',
    clock: CLOCK_AT_ACT,
    folded: true,
  },
];

/* ── THE PREVIOUS RULE, KEPT AS A WITNESS ─────────────────────────────────────
   These two functions are the fence exactly as TablePage applied it until
   2026-10-04: the snapshot merge and the TURN_CHANGE handler. They exist so
   this file can show what that rule did to the engine's real frames. */
interface OldFence {
  hand: number;
  seat: number;
  until: number;
}
function oldSnapshotRule(fence: OldFence | null, frame: Frame, hand: number, now: number) {
  let seat = frame.seat;
  let next = fence;
  if (fence) {
    if (fence.hand !== hand || now >= fence.until) next = null;
    else if (frame.seat === fence.seat) seat = 0;
    else next = null;
  }
  return { seat, fence: next };
}
function oldTurnChangeAccepts(
  fence: OldFence | null,
  frame: Frame,
  heroSeat: number,
  hand: number,
  now: number
) {
  return !(
    fence &&
    fence.seat === frame.seat &&
    fence.hand === hand &&
    now < fence.until &&
    frame.seat === heroSeat
  );
}
function playOldRule(frames: Frame[]): number {
  let fence: OldFence | null = { hand: HAND, seat: HERO_SEAT, until: TAP + 1500 };
  let shown = 0; // the optimistic update zeroed it at the tap
  for (const f of frames) {
    const now = TAP + f.at;
    if (f.kind === 'snapshot') {
      const v = oldSnapshotRule(fence, f, HAND, now);
      fence = v.fence;
      shown = v.seat;
    } else if (oldTurnChangeAccepts(fence, f, HERO_SEAT, HAND, now)) {
      shown = f.seat;
    }
  }
  return shown;
}

/** Play frames through the rule the page uses now. Returns what the page shows. */
function play(
  frames: Frame[],
  opts: { decision?: string | null; clockAtAct?: number | null; hand?: number } = {}
) {
  let fence: HeroActedFence | null = armHeroActedFence({
    hand: HAND,
    seat: HERO_SEAT,
    decision: opts.decision === undefined ? ANSWERED : opts.decision,
    clockAtAct: opts.clockAtAct === undefined ? CLOCK_AT_ACT : opts.clockAtAct,
    now: TAP,
  });
  let shown = 0;
  const shownAfterEach: number[] = [];
  for (const f of frames) {
    const now = TAP + f.at;
    if (f.kind === 'snapshot') {
      const v = judgeSnapshotAgainstFence(
        fence,
        {
          hand: opts.hand ?? HAND,
          actorSeat: f.seat,
          decision: f.decision,
          clock: f.clock,
          actorFolded: f.folded,
        },
        now
      );
      fence = v.fence;
      shown = v.currentPlayerSeat;
    } else {
      const v = judgeTurnChangeAgainstFence(
        fence,
        { hand: opts.hand ?? HAND, seat: f.seat, heroSeat: HERO_SEAT, decision: f.decision },
        now
      );
      fence = v.fence;
      if (v.accept) shown = f.seat;
    }
    shownAfterEach.push(shown);
  }
  return { shown, fence, shownAfterEach };
}

/**
 * What the release timer does when it fires, as TablePage applies it: ask the
 * rule whether a turn is still withheld, then ask whether this page may take it.
 */
function fireReleaseTimer(
  state: { shown: number; fence: HeroActedFence | null },
  page: { heroFolded?: boolean; hand?: number; heroSeat?: number } = {}
) {
  const now = TAP + HERO_ACTED_FENCE_MS + HERO_ACTED_FENCE_RELEASE_MARGIN_MS;
  const v = releaseExpiredFence(state.fence, now);
  const handBack = shouldHandBackTurn(v, {
    currentPlayerSeat: state.shown,
    heroSeat: page.heroSeat ?? HERO_SEAT,
    hand: page.hand ?? HAND,
    heroFolded: page.heroFolded ?? false,
  });
  return { shown: handBack ? HERO_SEAT : state.shown, fence: v.fence };
}

describe('the defect: the previous rule against the engine frames', () => {
  it('left the seat that closed the street with no turn at all', () => {
    // Every frame of the new turn lands inside the 1500ms window and names the
    // seat that just acted, so every one was withheld. The engine publishes
    // nothing further until the clock expires.
    expect(playOldRule(SAME_SEAT_STREET_BOUNDARY)).toBe(0);
  });

  it('was right about the cases it was built for', () => {
    expect(playOldRule(TURN_MOVES_TO_ANOTHER_SEAT)).toBe(VILLAIN_SEAT);
    expect(playOldRule(STREET_CLOSES_AND_ANOTHER_SEAT_OPENS)).toBe(VILLAIN_SEAT);
  });
});

describe('a turn handed back is a turn', () => {
  it('the seat that closes a street and opens the next is shown its turn', () => {
    const { shown, fence, shownAfterEach } = play(SAME_SEAT_STREET_BOUNDARY);
    expect(shown).toBe(HERO_SEAT);
    expect(fence).toBeNull();
    // Withheld while the engine is between turns, handed over on the snapshot
    // that carries the newly stamped clock - not a frame earlier.
    expect(shownAfterEach).toEqual([0, 0, HERO_SEAT, HERO_SEAT]);
  });

  it('the turn_change alone is enough when no earlier frame was seen', () => {
    // A reconnect can make the armed turn the first frame after the tap: no
    // earlier clock to compare with, so the snapshot cannot prove it. The
    // event can.
    const { shown, shownAfterEach, fence } = play(SAME_SEAT_STREET_BOUNDARY.slice(2));
    expect(shownAfterEach).toEqual([0, HERO_SEAT]);
    expect(shown).toBe(HERO_SEAT);
    expect(fence).toBeNull();
  });

  it('the snapshot alone is enough when the turn_change is lost', () => {
    const { shown, fence } = play(SAME_SEAT_STREET_BOUNDARY.slice(0, 3));
    expect(shown).toBe(HERO_SEAT);
    expect(fence).toBeNull();
  });

  it('with only the armed snapshot and no event, the turn arrives when the window closes', () => {
    const withheld = play(SAME_SEAT_STREET_BOUNDARY.slice(2, 3));
    expect(withheld.shown).toBe(0);
    expect(withheld.fence?.pending).toEqual({ clock: ENGINE_T0 + 3126 });
    const released = fireReleaseTimer(withheld);
    expect(released.shown).toBe(HERO_SEAT);
    expect(released.fence).toBeNull();
  });

  it('holds at any latency inside the window', () => {
    for (const latency of [0, 20, 150, 400, 900]) {
      const frames = SAME_SEAT_STREET_BOUNDARY.map((f) => ({ ...f, at: f.at - LATENCY + latency }));
      expect(play(frames).shown, `latency ${latency}ms`).toBe(HERO_SEAT);
    }
  });

  it('never compares the engine clock with the device clock', () => {
    // The two epochs above differ by ten minutes. A rule that mixed them
    // would either accept everything or nothing; the cases around this one
    // only pass because the comparison is engine clock to engine clock.
    expect(Math.abs(TAP - ENGINE_T0)).toBeGreaterThan(5 * 60 * 1000);
    const skewed = SAME_SEAT_STREET_BOUNDARY.map((f) => ({
      ...f,
      clock: f.clock === null ? null : f.clock - 86_400_000,
    }));
    expect(play(skewed, { clockAtAct: CLOCK_AT_ACT - 86_400_000 }).shown).toBe(HERO_SEAT);
  });
});

describe('what the fence is still for', () => {
  it('a snapshot of the decision already answered does not put the bar back', () => {
    const stale: Frame[] = [
      { at: 15, kind: 'snapshot', seat: 2, decision: ANSWERED, clock: CLOCK_AT_ACT },
      { at: 40, kind: 'turn_change', seat: 2, decision: ANSWERED, clock: null },
    ];
    const { shown, fence } = play(stale);
    expect(shown).toBe(0);
    expect(fence?.pending).toBeNull();
    // And it is not delivered when the window closes: the submit path owns a
    // lost action (revert), not this timer.
    expect(fireReleaseTimer({ shown, fence }).shown).toBe(0);
  });

  it('the answered decision on a re-stamped clock is still the answered decision', () => {
    // A time bank landing as the hero taps re-stamps the clock of the SAME
    // decision. A newer clock alone must not read as a new turn.
    const frames: Frame[] = [
      { at: 10, kind: 'snapshot', seat: 2, decision: ANSWERED, clock: CLOCK_AT_ACT },
      { at: 30, kind: 'snapshot', seat: 2, decision: ANSWERED, clock: CLOCK_AT_ACT + 15_000 },
    ];
    expect(play(frames).shown).toBe(0);
  });

  it('the engine between turns is withheld, then the next seat takes over', () => {
    const mid = play(TURN_MOVES_TO_ANOTHER_SEAT);
    expect(mid.shownAfterEach).toEqual([0, VILLAIN_SEAT, VILLAIN_SEAT]);
    expect(mid.fence).toBeNull();

    const street = play(STREET_CLOSES_AND_ANOTHER_SEAT_OPENS);
    expect(street.shownAfterEach).toEqual([0, 0, VILLAIN_SEAT, VILLAIN_SEAT]);
    expect(street.fence).toBeNull();
  });

  it('a clock the page never saw (an automatic time bank) does not open the bar early', () => {
    // The engine re-stamps the clock when it starts a time bank and publishes
    // no snapshot for it, so the first frame after the action can carry a
    // clock newer than the one the page was showing. It is still the engine
    // between turns.
    const bankClock = CLOCK_AT_ACT + 17_000;
    const frames = STREET_CLOSES_AND_ANOTHER_SEAT_OPENS.map((f, i) =>
      i < 2 ? { ...f, clock: bankClock } : { ...f, clock: bankClock + 9_000 }
    );
    const { shownAfterEach } = play(frames);
    expect(shownAfterEach).toEqual([0, 0, VILLAIN_SEAT, VILLAIN_SEAT]);
  });

  it('the last action of a hand never brings the bar back at showdown', () => {
    const state = play(LAST_ACTION_OF_THE_HAND);
    expect(state.shown).toBe(0);
    // The engine's last word was "no betting decision": nothing is pending.
    expect(state.fence?.pending).toBeNull();
    expect(fireReleaseTimer(state).shown).toBe(0);
  });

  it('a fold that ends the hand never brings the bar back', () => {
    // The engine goes on naming the folder with a betting context, so the
    // frames look like an offer of a different decision. The frames themselves
    // show the seat as folded: nothing is pending, and nothing is handed back.
    const state = play(FOLD_ENDS_THE_HAND, { decision: FOLD_ANSWERED });
    expect(state.shownAfterEach).toEqual([0, 0]);
    expect(state.fence?.pending).toBeNull();
    expect(fireReleaseTimer(state, { heroFolded: true }).shown).toBe(0);

    // The same fold made during an automatic time bank, followed by a frame
    // on a later clock still: the frames carry clocks the page never saw, so
    // the clocks alone would read as a newly armed turn. A folded seat is
    // offered nothing, by the snapshot rule or by the release.
    const bankClock = CLOCK_AT_ACT + 17_000;
    const onBankClocks = play(
      [
        ...FOLD_ENDS_THE_HAND.map((f) => ({ ...f, clock: bankClock })),
        { ...FOLD_ENDS_THE_HAND[1], at: LATENCY + 400, clock: bankClock + 300 },
      ],
      { decision: FOLD_ANSWERED }
    );
    expect(onBankClocks.shownAfterEach).toEqual([0, 0, 0]);
    expect(onBankClocks.fence?.pending).toBeNull();
    expect(fireReleaseTimer(onBankClocks, { heroFolded: true }).shown).toBe(0);
  });

  it('the page refuses a folded hero even if a frame did not say so', () => {
    // Belt for the release: the same frames without the folded flag (a frame
    // from before the engine marked the seat) leave a turn pending on the bank
    // clock, and the page, which shows the hero folded, still does not take it.
    const bankClock = CLOCK_AT_ACT + 17_000;
    const state = play(
      FOLD_ENDS_THE_HAND.map((f) => ({ ...f, clock: bankClock, folded: false })),
      { decision: FOLD_ANSWERED }
    );
    expect(state.fence?.pending).toEqual({ clock: bankClock });
    expect(fireReleaseTimer(state, { heroFolded: true }).shown).toBe(0);
  });

  it('a fold the engine refused does not cost the seat its next turn', () => {
    // The engine had already checked the seat through on a timeout and dealt
    // the next street to it when the fold arrived, so the fold was refused.
    // The armed turn is the only frame seen and its event was lost; the page's
    // seat is not folded (the snapshot said so). The turn is delivered.
    const state = play(SAME_SEAT_STREET_BOUNDARY.slice(2, 3));
    expect(state.shown).toBe(0);
    expect(fireReleaseTimer(state, { heroFolded: false }).shown).toBe(HERO_SEAT);
  });

  it('a slow engine still between turns when the window closes is not mistaken for a turn', () => {
    // Only the two in-between frames arrived; both are on the clock the hero
    // acted on. The armed frame, whoever it names, arrives unfenced.
    const state = play(STREET_CLOSES_AND_ANOTHER_SEAT_OPENS.slice(0, 2));
    expect(state.shown).toBe(0);
    const released = fireReleaseTimer(state);
    expect(released.shown).toBe(0);
    expect(released.fence).toBeNull();
  });
});

describe('the fence is never sticky', () => {
  it('a new hand ends it', () => {
    const frames: Frame[] = [
      {
        at: 800,
        kind: 'snapshot',
        seat: 2,
        decision: 'inc-2:preflop:0:2:5',
        clock: ENGINE_T0 + 9000,
      },
    ];
    const { shown, fence } = play(frames, { hand: HAND + 1 });
    expect(shown).toBe(HERO_SEAT);
    expect(fence).toBeNull();
  });

  it('it withholds nothing at or after its deadline', () => {
    const frames: Frame[] = [
      {
        at: HERO_ACTED_FENCE_MS,
        kind: 'snapshot',
        seat: 2,
        decision: ANSWERED,
        clock: CLOCK_AT_ACT,
      },
    ];
    const { shown, fence } = play(frames);
    expect(shown).toBe(HERO_SEAT);
    expect(fence).toBeNull();
    const event: Frame[] = [
      { at: HERO_ACTED_FENCE_MS, kind: 'turn_change', seat: 2, decision: ANSWERED, clock: null },
    ];
    expect(play(event).shown).toBe(HERO_SEAT);
  });

  it('a turn_change for another seat is applied and leaves the fence to the snapshot', () => {
    const fence = armHeroActedFence({ hand: HAND, seat: HERO_SEAT, decision: ANSWERED, now: TAP });
    const v = judgeTurnChangeAgainstFence(
      fence,
      { hand: HAND, seat: VILLAIN_SEAT, heroSeat: HERO_SEAT, decision: 'inc-1:flop:5:6:10' },
      TAP + 100
    );
    expect(v.accept).toBe(true);
    expect(v.fence).toBe(fence);
  });

  it('a withheld turn is delivered only to the table that is still waiting for it', () => {
    const withheld = play(SAME_SEAT_STREET_BOUNDARY.slice(2, 3));
    const release = releaseExpiredFence(
      withheld.fence,
      TAP + HERO_ACTED_FENCE_MS + HERO_ACTED_FENCE_RELEASE_MARGIN_MS
    );
    expect(release.handBackSeat).toBe(HERO_SEAT);
    const waiting = { currentPlayerSeat: 0, heroSeat: HERO_SEAT, hand: HAND, heroFolded: false };
    expect(shouldHandBackTurn(release, waiting)).toBe(true);
    // Somebody is already on the clock, the next hand has started, the hero
    // has left the seat, or the hero has folded: leave the table alone.
    expect(shouldHandBackTurn(release, { ...waiting, currentPlayerSeat: VILLAIN_SEAT })).toBe(
      false
    );
    expect(shouldHandBackTurn(release, { ...waiting, currentPlayerSeat: HERO_SEAT })).toBe(false);
    expect(shouldHandBackTurn(release, { ...waiting, hand: HAND + 1 })).toBe(false);
    expect(shouldHandBackTurn(release, { ...waiting, heroSeat: 0 })).toBe(false);
    expect(shouldHandBackTurn(release, { ...waiting, heroFolded: true })).toBe(false);
    // Nothing to deliver is never a delivery.
    expect(shouldHandBackTurn({ handBackSeat: null, hand: null }, waiting)).toBe(false);
  });

  it('the release timer leaves a newer fence alone', () => {
    // The hero acted again before the first timer fired: that action armed its
    // own fence and its own timer.
    const newer = armHeroActedFence({
      hand: HAND,
      seat: HERO_SEAT,
      decision: 'inc-1:turn:5:2:0',
      now: TAP + 1400,
    });
    const v = releaseExpiredFence(newer, TAP + HERO_ACTED_FENCE_MS + 10);
    expect(v.handBackSeat).toBeNull();
    expect(v.fence).toBe(newer);
  });

  it('judging the same frame twice gives the same answer (a state updater may re-run)', () => {
    let fence: HeroActedFence | null = armHeroActedFence({
      hand: HAND,
      seat: HERO_SEAT,
      decision: ANSWERED,
      clockAtAct: CLOCK_AT_ACT,
      now: TAP,
    });
    const shown: number[] = [];
    for (const f of SAME_SEAT_STREET_BOUNDARY.filter((x) => x.kind === 'snapshot')) {
      for (let pass = 0; pass < 2; pass++) {
        const v = judgeSnapshotAgainstFence(
          fence,
          { hand: HAND, actorSeat: f.seat, decision: f.decision, clock: f.clock },
          TAP + f.at
        );
        fence = v.fence;
        shown.push(v.currentPlayerSeat);
      }
    }
    expect(shown).toEqual([0, 0, 0, 0, HERO_SEAT, HERO_SEAT]);
  });
});

describe('an engine that publishes no decision context', () => {
  it('a turn_change that cannot say which decision it is waits for the window, and is then delivered', () => {
    const frames: Frame[] = [
      { at: 560, kind: 'snapshot', seat: 2, decision: null, clock: null },
      { at: 561, kind: 'turn_change', seat: 2, decision: null, clock: null },
    ];
    const state = play(frames, { decision: null, clockAtAct: null });
    expect(state.shown).toBe(0);
    expect(fireReleaseTimer(state).shown).toBe(HERO_SEAT);
  });
});

describe('TablePage applies this rule and no other', () => {
  const PAGE = readFileSync(resolve(__dirname, '../../src/pages/TablePage.tsx'), 'utf8');

  it('the snapshot merge asks the rule for the actor', () => {
    expect(PAGE).toMatch(/judgeSnapshotAgainstFence\(\s*heroActedFenceRef\.current,/);
    expect(PAGE).toMatch(/decision: mapped\.actionContext,/);
    expect(PAGE).toMatch(/clock: mapped\.actionTimerStartTime,/);
    expect(PAGE).toMatch(
      /actorFolded: mapped\.players\[mapped\.currentPlayerSeat - 1\]\?\.status === 'folded',/
    );
    expect(PAGE).toMatch(/currentPlayerSeat: nextCurrentSeat,/);
  });

  it('the TURN_CHANGE handler asks the rule before it writes the seat', () => {
    const body = sliceBlockAfter(PAGE, "case 'TURN_CHANGE': {");
    expect(body).toMatch(/judgeTurnChangeAgainstFence\(\s*heroActedFenceRef\.current,/);
    expect(body).toMatch(/if \(!verdict\.accept\) return prev;/);
  });

  it('the fence records the decision and the clock the hero acted on', () => {
    expect(PAGE).toMatch(/armHeroActedFence\(\{/);
    expect(PAGE).toMatch(/decision: prev\.actionContext,/);
    expect(PAGE).toMatch(/clockAtAct: prev\.actionTimerStartTime,/);
  });

  it('a withheld turn is delivered when the window closes', () => {
    expect(PAGE).toMatch(/releaseExpiredFence\(heroActedFenceRef\.current, Date\.now\(\)\)/);
    expect(PAGE).toMatch(/HERO_ACTED_FENCE_MS \+ HERO_ACTED_FENCE_RELEASE_MARGIN_MS/);
    // ...and only onto a table still waiting for it, never to a folded hero.
    expect(PAGE).toMatch(/shouldHandBackTurn\(released, \{/);
    expect(PAGE).toMatch(/heroFolded: prev\.players\[prev\.heroSeat - 1\]\?\.status === 'folded',/);
  });

  it('the page keeps no second copy of the rule', () => {
    // The inline comparisons this replaced. A second copy is how the snapshot
    // and the event came to disagree in the first place.
    expect(PAGE).not.toMatch(/mapped\.currentPlayerSeat === fence\.seat/);
    expect(PAGE).not.toMatch(/Date\.now\(\) < f\.until/);
  });
});
