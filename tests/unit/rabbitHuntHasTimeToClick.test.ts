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
  /* 2026-09-07: the rest is the WHOLE gap between completion and the next
     deal (Dan: "THE NEXT HAND 2 SECONDS AFTER THE HAND IS COMPLETED"). It is
     armed at the hand-free broadcast and awaited immediately before dealHand,
     so the settlement barrier, the roster read and the hand-number allocation
     all run under it instead of after it. The Rabbit Hunt window is that
     same rest. tests/the-next-hand-deals-two-seconds-after-completion.law.test.ts
     pins the number across every surface; these pin the shape. */
  it('the rest is its own beat and NOT folded into the animation hold', () => {
    const fold = handCompletionHoldMs({ wentToShowdown: false });
    expect(fold).toBe(
      HAND_COMPLETION.BETS_SWEEP_MS +
        HAND_COMPLETION.POT_PUSH_MS +
        HAND_COMPLETION.MUCK_MS +
        HAND_COMPLETION.POST_PUSH_PAUSE_MS
    );
    expect(fold).not.toBe(
      HAND_COMPLETION.BETS_SWEEP_MS +
        HAND_COMPLETION.POT_PUSH_MS +
        HAND_COMPLETION.MUCK_MS +
        HAND_COMPLETION.POST_PUSH_PAUSE_MS +
        HAND_COMPLETION.NEXT_HAND_REST_MS
    );
    expect(HAND_COMPLETION.RABBIT_HUNT_WINDOW_MS).toBe(HAND_COMPLETION.NEXT_HAND_REST_MS);
  });

  it('the engine arms it AFTER the hand-free broadcast and awaits it right before the deal', () => {
    const hold = DEALING_CODE.indexOf("this.setLoopPhase('post_hand_hold')");
    const broadcast = DEALING_CODE.indexOf('this.broadcastCurrentState();', hold);
    const arm = DEALING_CODE.indexOf('this.armNextHandRest(', broadcast);
    const awaited = DEALING_CODE.indexOf('await this.awaitNextHandRest();');
    const deal = DEALING_CODE.indexOf("this.setLoopPhase('dealing');");
    expect(hold, 'post-hand hold not found').toBeGreaterThan(-1);
    expect(broadcast, 'hand-free broadcast not found').toBeGreaterThan(-1);
    expect(arm, 'the rest is not armed after the broadcast').toBeGreaterThan(broadcast);
    expect(awaited, 'the rest is not awaited in the dealing loop').toBeGreaterThan(-1);
    expect(deal).toBeGreaterThan(awaited);
    // nothing between the await and the deal but whitespace
    expect(
      DEALING_CODE.slice(awaited + 'await this.awaitNextHandRest();'.length, deal).trim()
    ).toBe('');
  });

  it('it happens on EVERY hand, with nothing to branch on', () => {
    const hold = DEALING_CODE.indexOf("this.setLoopPhase('post_hand_hold')");
    const broadcast = DEALING_CODE.indexOf('this.broadcastCurrentState();', hold);
    const arm = DEALING_CODE.indexOf('this.armNextHandRest(', broadcast);
    const between = DEALING_CODE.slice(broadcast, arm);
    expect(between).not.toMatch(/\bif\s*\(/);
    expect(between).not.toMatch(/\?\s*HAND_COMPLETION/);
    expect(between).not.toMatch(/rabbitHuntOffers|cards_available|isRabbitAvailable/);
    // the old separate sleeps are gone: the clear and the window live inside the rest
    expect(DEALING_CODE).not.toMatch(/await this\.sleep\(boardClearMs\(/);
    expect(DEALING_CODE).not.toMatch(/await this\.sleep\(HAND_COMPLETION\.RABBIT_HUNT_WINDOW_MS\)/);
  });

  it('the board clear can never outlive the rest, and the button window clears its floor', () => {
    expect(DEALING_CODE).toMatch(
      /armNextHandRest\(\s*Math\.max\(HAND_COMPLETION\.NEXT_HAND_REST_MS, boardClearMs\(wentToShowdown\)\)/
    );
    const floor = Number(
      read('src/pages/TablePage.tsx').match(/const RABBIT_MIN_VISIBLE_MS = (\d+);/)![1]
    );
    for (const wentToShowdown of [false, true]) {
      expect(HAND_COMPLETION.NEXT_HAND_REST_MS).toBeGreaterThan(boardClearMs(wentToShowdown));
      expect(HAND_COMPLETION.RABBIT_HUNT_WINDOW_MS).toBeGreaterThanOrEqual(floor);
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
