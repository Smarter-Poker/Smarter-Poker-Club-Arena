/**
 * A SEAT THAT CLOSES A STREET IS SHOWN ITS TURN ON THE NEXT ONE - THE PAGE'S
 * RULE, AGAINST THE ENGINE'S OWN WIRE.
 *
 * Dan, 2026-10-04, after a human-versus-human match: "MY HUMAN OPPONENT [WAS]
 * CONSTANTLY BEING TIMED OUT OR DISCONNECTED." The opponent was the big blind
 * heads-up; each time he called to close a street he was first to act on the
 * next, and TablePage's hero-acted fence withheld the turn the engine handed
 * him.
 *
 * tests/unit/heroActedFence.test.ts proves the rule on frames written out by
 * hand. This file feeds it the recording itself: tests/live-turn/wire/ holds,
 * frame for frame, what the real ServerTableEngine, HandController and
 * TableStateHub sent one subscriber for such a hand, and the engine's own
 * suite refuses to pass once the engine stops sending that
 * (server/src/engine/aSeatThatClosesAStreetIsHandedTheNext.test.ts). So if
 * the engine changes its frames, the recording changes, and this test proves
 * the page against the new ones or fails.
 *
 * Every state goes through the real `mapEngineSnapshot` and the real fence
 * functions, in the order TablePage calls them. The previous rule is kept
 * beside the new one as a witness: on this wire it leaves the seat with no
 * action bar when its turn comes, twice.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import jsonPatch from 'fast-json-patch';
import { mapEngineSnapshot } from '../../src/utils/mapEngineSnapshot';
import {
  HERO_ACTED_FENCE_MS,
  HERO_ACTED_FENCE_RELEASE_MARGIN_MS,
  armHeroActedFence,
  judgeSnapshotAgainstFence,
  judgeTurnChangeAgainstFence,
  releaseExpiredFence,
  shouldHandBackTurn,
  type HeroActedFence,
} from '../../src/lib/heroActedFence';

interface Entry {
  at: number;
  kind: string;
  frame?: Record<string, any>;
  action?: string;
  context?: string;
}
interface Recording {
  t0: number;
  table: string;
  hero: string;
  villain: string;
  out: Entry[];
}

const WIRE = join(__dirname, '../live-turn/wire/same-seat-street-boundary.jsonl');
/** JSON Lines: the header, then one recorded frame per line. */
const [head, ...out] = readFileSync(WIRE, 'utf8')
  .split('\n')
  .filter((line) => line.trim() !== '')
  .map((line) => JSON.parse(line));
const recording = { ...head, out } as Recording;

/** What TablePage holds of the turn. */
interface Page {
  currentPlayerSeat: number;
  heroSeat: number;
  handNumber: number;
  actionContext: string | undefined;
  clock: number | undefined;
  heroFolded: boolean;
}

interface Turn {
  /** The hero's action that this turn was answered with. */
  action: string;
  /** ms into the recording when the hero acted. */
  actedAt: number;
  /** Was the action bar on screen when the recording's hero acted? */
  barShown: boolean;
  /** The decision the page would have sent, and the one the engine wanted. */
  pageContext: string | undefined;
  engineContext: string | undefined;
  /** ms into the recording when the bar came up for this turn; null if never. */
  shownAt: number | null;
}

interface Rule {
  arm(page: Page, now: number): void;
  /** Returns the seat the page shows for an authoritative state. */
  onState(
    frame: {
      hand: number;
      actorSeat: number;
      decision?: string;
      clock?: number;
      actorFolded: boolean;
    },
    now: number
  ): number;
  /** Returns true when the turn_change is applied. */
  onTurnChange(
    evt: { hand: number; seat: number; heroSeat: number; decision?: string },
    now: number
  ): boolean;
  /** A timer the page set when the hero acted; returns a seat to hand back. */
  onTimer(page: Page, now: number): number | null;
}

/** The rule TablePage runs today, called the way TablePage calls it. */
function currentRule(): Rule {
  let fence: HeroActedFence | null = null;
  let timerAt: number | null = null;
  return {
    arm(page, now) {
      fence = armHeroActedFence({
        hand: page.handNumber,
        seat: page.heroSeat,
        decision: page.actionContext,
        clockAtAct: page.clock,
        now,
      });
      timerAt = now + HERO_ACTED_FENCE_MS + HERO_ACTED_FENCE_RELEASE_MARGIN_MS;
    },
    onState(frame, now) {
      const verdict = judgeSnapshotAgainstFence(fence, frame, now);
      fence = verdict.fence;
      return verdict.currentPlayerSeat;
    },
    onTurnChange(evt, now) {
      const verdict = judgeTurnChangeAgainstFence(fence, evt, now);
      fence = verdict.fence;
      return verdict.accept;
    },
    onTimer(page, now) {
      if (timerAt === null || now < timerAt) return null;
      timerAt = null;
      const released = releaseExpiredFence(fence, now);
      fence = released.fence;
      return shouldHandBackTurn(released, {
        currentPlayerSeat: page.currentPlayerSeat,
        heroSeat: page.heroSeat,
        hand: page.handNumber,
        heroFolded: page.heroFolded,
      })
        ? page.heroSeat
        : null;
    },
  };
}

/**
 * The rule as it stood until 2026-10-04: by seat and by time, in the snapshot
 * merge and (since 2026-09-09) in the TURN_CHANGE handler. Kept as a witness.
 */
function previousRule(): Rule {
  let fence: { hand: number; seat: number; until: number } | null = null;
  return {
    arm(page, now) {
      fence = { hand: page.handNumber, seat: page.heroSeat, until: now + 1500 };
    },
    onState(frame, now) {
      if (!fence) return frame.actorSeat;
      if (fence.hand !== frame.hand || now >= fence.until) {
        fence = null;
        return frame.actorSeat;
      }
      if (frame.actorSeat === fence.seat) return 0;
      fence = null;
      return frame.actorSeat;
    },
    onTurnChange(evt, now) {
      return !(
        fence &&
        fence.seat === evt.seat &&
        fence.hand === evt.hand &&
        now < fence.until &&
        evt.seat === evt.heroSeat
      );
    },
    onTimer() {
      return null;
    },
  };
}

/** Play the recording to a page that runs `rule`; report each of the hero's turns. */
function play(rule: Rule): { turns: Turn[]; barWhileNotHerosTurn: string[] } {
  const page: Page = {
    currentPlayerSeat: 0,
    heroSeat: 0,
    handNumber: 0,
    actionContext: undefined,
    clock: undefined,
    heroFolded: false,
  };
  const turns: Turn[] = [];
  const barWhileNotHerosTurn: string[] = [];
  let state: Record<string, any> | null = null;
  /** The engine's own view: is it armed and waiting on the hero right now? */
  let engineWaitsOnHero = false;
  let pendingShownAt: number | null = null;

  const noteBar = (at: number, why: string) => {
    if (page.heroSeat > 0 && page.currentPlayerSeat === page.heroSeat) {
      if (!engineWaitsOnHero) barWhileNotHerosTurn.push(`${at}ms ${why}`);
      else if (pendingShownAt === null) pendingShownAt = at;
    }
  };

  for (const entry of recording.out) {
    const now = recording.t0 + entry.at;
    const handBack = rule.onTimer(page, now);
    if (handBack !== null) {
      page.currentPlayerSeat = handBack;
      noteBar(entry.at, 'release timer');
    }

    if (entry.kind === 'HERO_ACTS') {
      turns.push({
        action: String(entry.action),
        actedAt: entry.at,
        barShown: page.heroSeat > 0 && page.currentPlayerSeat === page.heroSeat,
        pageContext: page.actionContext,
        engineContext: entry.context,
        shownAt: pendingShownAt,
      });
      // applyOptimisticHeroAction: the bar goes and the fence is armed.
      rule.arm(page, now);
      page.currentPlayerSeat = 0;
      engineWaitsOnHero = false;
      pendingShownAt = null;
      continue;
    }
    const frame = entry.frame;
    if (entry.kind !== 'WIRE' || !frame) continue;

    if (frame.type === 'SNAPSHOT' || frame.type === 'DELTA') {
      const before = state;
      state =
        frame.type === 'SNAPSHOT'
          ? structuredClone(frame.state)
          : jsonPatch.applyPatch(structuredClone(state), frame.patch).newDocument;
      // The engine has armed a turn for the hero when it names him on a turn
      // clock it had not published before.
      if (
        state?.current_player === recording.hero &&
        state?.turn_start_time_ms &&
        state.turn_start_time_ms !== before?.turn_start_time_ms
      ) {
        engineWaitsOnHero = true;
      }
      if (state?.current_player !== recording.hero) engineWaitsOnHero = false;

      const mapped = mapEngineSnapshot(state as never, recording.hero, 6);
      const heroIndex = mapped.players.findIndex((p) => p && p.id === recording.hero);
      page.heroSeat = heroIndex + 1;
      page.heroFolded = mapped.players[heroIndex]?.status === 'folded';
      const hand = mapped.handNumber > 0 ? mapped.handNumber : page.handNumber;
      page.currentPlayerSeat = rule.onState(
        {
          hand,
          actorSeat: mapped.currentPlayerSeat,
          decision: mapped.actionContext,
          clock: mapped.actionTimerStartTime,
          actorFolded: mapped.players[mapped.currentPlayerSeat - 1]?.status === 'folded',
        },
        now
      );
      page.handNumber = hand;
      page.actionContext = mapped.actionContext;
      page.clock = mapped.actionTimerStartTime;
      noteBar(entry.at, `${frame.type} seq ${frame.seq}`);
    } else if (frame.type === 'EVENT' && frame.payload?.type === 'turn_change') {
      const seat = Number(frame.payload.seat);
      const decision = frame.payload.action_context as string | undefined;
      if (
        rule.onTurnChange({ hand: page.handNumber, seat, heroSeat: page.heroSeat, decision }, now)
      ) {
        page.currentPlayerSeat = seat;
        page.actionContext = decision;
      }
      noteBar(entry.at, 'turn_change');
    }
  }
  return { turns, barWhileNotHerosTurn };
}

describe('the recording is the hand from the report', () => {
  it('seat 2 is the big blind, calls to close two streets, and opens each next one', () => {
    const acts = recording.out.filter((e) => e.kind === 'HERO_ACTS');
    expect(
      acts.map((e) => `${e.action} ${String(e.context).split(':').slice(1, 3).join(':')}`)
    ).toEqual(['call preflop:1', 'check flop:2', 'call flop:4', 'check turn:5']);
    // The engine's turn_change carries the decision it announces.
    const turnChanges = recording.out.filter(
      (e) =>
        e.kind === 'WIRE' && e.frame?.type === 'EVENT' && e.frame.payload?.type === 'turn_change'
    );
    expect(turnChanges.length).toBeGreaterThanOrEqual(6);
    for (const e of turnChanges) {
      expect(typeof e.frame?.payload?.action_context, 'turn_change carries action_context').toBe(
        'string'
      );
    }
  });
});

describe('the page, played the engine wire', () => {
  it('shows the action bar for every turn the engine gave the seat', () => {
    const { turns } = play(currentRule());
    expect(turns.map((t) => t.action)).toEqual(['call', 'check', 'call', 'check']);
    for (const turn of turns) {
      expect(turn.barShown, `the bar was up for the ${turn.action} at ${turn.actedAt}ms`).toBe(
        true
      );
      // And the page would have answered the decision the engine was waiting on.
      expect(turn.pageContext).toBe(turn.engineContext);
    }
  });

  it('shows it when the engine arms the street, not when a timer runs out', () => {
    const { turns } = play(currentRule());
    // turns[1] follows the preflop call, turns[3] the flop call: the two
    // same-seat street boundaries. The engine arms 500ms after the call.
    for (const [boundary, after] of [
      [turns[0], turns[1]],
      [turns[2], turns[3]],
    ] as const) {
      const waited = (after.shownAt ?? Number.POSITIVE_INFINITY) - boundary.actedAt;
      expect(waited, 'ms from the call to the bar for the next street').toBeGreaterThanOrEqual(400);
      expect(waited).toBeLessThan(HERO_ACTED_FENCE_MS - 500);
    }
  });

  it('never shows it while the engine is between turns or waiting on the other seat', () => {
    expect(play(currentRule()).barWhileNotHerosTurn).toEqual([]);
  });
});

describe('the rule as it stood until 2026-10-04, on the same wire', () => {
  it('leaves the seat with no action bar on both streets it had closed', () => {
    const { turns } = play(previousRule());
    // The preflop turn (after the button raises) and the flop turn after the
    // button bets are ordinary and were always shown.
    expect(turns[0].barShown).toBe(true);
    expect(turns[2].barShown).toBe(true);
    // The flop after his preflop call, and the turn after his flop call: the
    // engine armed both, and the page showed nothing. That is the report.
    expect(turns[1].barShown).toBe(false);
    expect(turns[3].barShown).toBe(false);
  });
});
