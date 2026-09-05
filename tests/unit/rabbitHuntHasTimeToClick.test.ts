/**
 * THE RABBIT HUNT BUTTON HAD NO TIME, AND THE REASON WAS NOT WHERE ANYONE LOOKED
 *
 * Dan 2026-09-05: "THIS SAME 1.75MS PAUSE SHOULD BE DONE ON ALL HANDS UPON
 * COMPLETION, GIVE USERS A CHANCE TO USE THE RABBIT HUNT. IT CURRENTLY DOESN'T
 * REALLY HAVE ENOUGH TIME TO CLICK AND USE."
 *
 * The offer reaches the client at settlement and two separate guards were
 * already protecting it - a 90-second server offer TTL and a 2-second client
 * minimum-visible floor. Both were watching a clock the player could not see.
 * The button RENDERS behind `!tableState.isHandInProgress`, and the engine did
 * not broadcast a hand-free state until the whole completion hold had elapsed,
 * so the button was live and invisible for 4.5-7.4s and then visible for
 * boardClearMs and nothing else: 500ms on a fold.
 *
 * These tests pin the fix by its SHAPE, not by its number: the rest happens
 * after the hand-free broadcast, it happens on every hand, and no client
 * preference can reach it.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import {
  ALL_IN_SQUEEZE_CEILING_MS,
  HAND_COMPLETION,
  handCompletionHoldMs,
  boardClearMs,
} from '../../src/config/handCompletionSpec';
import {
  DEFAULT_USER_TABLE_SETTINGS,
  TABLE_SETTINGS_META,
} from '../../src/hooks/useUserTableSettings';
import {
  CARD_PRESENTATION_PROFILES,
  FLIP_CEILING_MS,
  flipMs,
} from '../../src/presentation/cardPresentation/profiles';

const read = (p: string) => readFileSync(resolve(__dirname, '../../', p), 'utf8');
const stripComments = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');

const DEALING = read('server/src/engine/ServerTableEngineDealing.ts');
const DEALING_CODE = stripComments(DEALING);

describe('the hand rests before the next one', () => {
  it('the rest is its own beat and NOT folded into the animation hold', () => {
    // handCompletionHoldMs has exactly one job: outlast the animations it is
    // holding for. Every number in it is derived from an animation length.
    // This one is derived from a human being's reaction time, so putting it in
    // there would make the hold's arithmetic stop meaning what its header says.
    const fold = handCompletionHoldMs({ wentToShowdown: false });
    expect(fold).toBe(
      HAND_COMPLETION.BETS_SWEEP_MS +
        HAND_COMPLETION.POT_PUSH_MS +
        HAND_COMPLETION.MUCK_MS +
        HAND_COMPLETION.POST_PUSH_PAUSE_MS
    );
    // Stated the other way round, so the pin fails if anyone ever adds it in:
    // the hold must not have grown by the rest.
    expect(fold).not.toBe(
      HAND_COMPLETION.BETS_SWEEP_MS +
        HAND_COMPLETION.POT_PUSH_MS +
        HAND_COMPLETION.MUCK_MS +
        HAND_COMPLETION.POST_PUSH_PAUSE_MS +
        HAND_COMPLETION.RABBIT_HUNT_WINDOW_MS
    );
    expect(HAND_COMPLETION.RABBIT_HUNT_WINDOW_MS).toBe(1750);
  });

  it('the engine sleeps it AFTER the hand-free broadcast and the board clear', () => {
    // Order is the entire fix. Before the broadcast the client still believes
    // a hand is in progress, so the button cannot render and the time is spent
    // on nobody; and a reveal freezes the client snapshot for three seconds,
    // which is only safe once there is no live hand for the freeze to starve.
    const broadcast = DEALING_CODE.indexOf('this.broadcastCurrentState();');
    const clear = DEALING_CODE.indexOf('boardClearMs(wentToShowdown)');
    const rest = DEALING_CODE.indexOf('HAND_COMPLETION.RABBIT_HUNT_WINDOW_MS');
    expect(broadcast, 'hand-free broadcast not found').toBeGreaterThan(-1);
    expect(clear, 'board clear not found').toBeGreaterThan(-1);
    expect(rest, 'the post-hand rest is not in the dealing loop').toBeGreaterThan(-1);
    expect(broadcast).toBeLessThan(clear);
    expect(clear).toBeLessThan(rest);
  });

  it('it happens on EVERY hand, with nothing to branch on', () => {
    // A rest that only happened when a rabbit hunt was purchasable would tell
    // the whole table, from the rhythm alone, that the deck still had cards in
    // it. Same reasoning as the rebuy pause (CLAUDE.md 10.5): a beat that
    // happens sometimes is a tell. So there must be no condition between the
    // board clear and the sleep.
    const clear = DEALING_CODE.indexOf('boardClearMs(wentToShowdown)');
    const rest = DEALING_CODE.indexOf('HAND_COMPLETION.RABBIT_HUNT_WINDOW_MS');
    const between = DEALING_CODE.slice(clear, rest);
    expect(between).not.toMatch(/\bif\s*\(/);
    expect(between).not.toMatch(/\?\s*HAND_COMPLETION/);
    expect(between).not.toMatch(/rabbitHuntOffers|cards_available|isRabbitAvailable/);
  });

  it('the visible window is now longer than the floor that was meant to protect it', () => {
    // RABBIT_MIN_VISIBLE_MS is 2000 and used to exceed the whole visible
    // window, which is what made it decorative. The button is on screen from
    // the hand-free broadcast, so its life is the board clear plus the rest.
    const floor = Number(
      read('src/pages/TablePage.tsx').match(/const RABBIT_MIN_VISIBLE_MS = (\d+);/)![1]
    );
    for (const wentToShowdown of [false, true]) {
      const visible = boardClearMs(wentToShowdown) + HAND_COMPLETION.RABBIT_HUNT_WINDOW_MS;
      expect(visible, `window on ${wentToShowdown ? 'a showdown' : 'a fold'}`).toBeGreaterThan(
        floor
      );
    }
  });
});

describe('the all-in run-out gap is Dan 2026-09-05', () => {
  it('is 1750ms, and the extra time lands on the HOLD rather than the flip', () => {
    // "GOT TO 1.75MS". The sourced industry value (the only one that exists -
    // PokerStars' all-in pause) is 1500; Dan set ours past it deliberately.
    expect(HAND_COMPLETION.ALL_IN_STREET_REVEAL_MS).toBe(1750);
    const p = CARD_PRESENTATION_PROFILES.allIn;
    // The card profile derives its face-down hold from the server's pacing,
    // so the gap and the animation cannot drift apart. VIP ALL-IN SQUEEZE
    // 2026-09-05: the hold became the PLAYER'S ceiling and is now derived
    // from this gate PLUS the shorter server pause after it (see
    // ALL_IN_SQUEEZE_CEILING_MS); it is still a function of this constant,
    // never a literal beside it.
    expect(p.durationMs).toBe(ALL_IN_SQUEEZE_CEILING_MS);
    expect(p.durationMs).toBeGreaterThan(HAND_COMPLETION.ALL_IN_STREET_REVEAL_MS);
    // The FLIP is unchanged and still inside the 400ms ceiling the card-reveal
    // research established: a longer gap must buy more tension, not a slower
    // turn.
    expect(flipMs(p)).toBeLessThanOrEqual(FLIP_CEILING_MS);
    expect(p.holdMs).toBeGreaterThan(flipMs(p));
  });
});

describe('the player may hide the button, and only the button', () => {
  it('is on by default, so nobody loses an offer they had yesterday', () => {
    expect(DEFAULT_USER_TABLE_SETTINGS.rabbit_hunt_button).toBe(true);
  });

  it('has a row in the settings list, so the switch is actually reachable', () => {
    // This file's own header states the rule: a key with no meta row is a
    // preference the player cannot find.
    const row = TABLE_SETTINGS_META.find((m) => m.key === 'rabbit_hunt_button');
    expect(row, 'no TABLE_SETTINGS_META row').toBeTruthy();
    expect(row!.label.length).toBeGreaterThan(0);
    expect(row!.description.length).toBeGreaterThan(0);
  });

  it('gates the HUD slot', () => {
    const TABLE_PAGE = stripComments(read('src/pages/TablePage.tsx'));
    expect(TABLE_PAGE).toMatch(
      /!tableState\.isHandInProgress && isRabbitAvailable && v8Settings\.rabbit_hunt_button/
    );
  });

  it('CANNOT reach the pause: the engine has never heard of the setting', () => {
    // The rest is served by the engine to the whole table. A per-player
    // preference that changed it would alter everybody else's pace and, by
    // making the pause intermittent, leak that the deck still had cards.
    for (const p of [
      'server/src/engine/ServerTableEngineDealing.ts',
      'server/src/config/handCompletionSpec.ts',
      'src/config/handCompletionSpec.ts',
    ]) {
      expect(read(p), `${p} must not read a client preference`).not.toMatch(/rabbit_hunt_button/);
    }
  });
});
