/**
 * A BOMB POT GETS A 25 SECOND CLOCK (Dan 2026-10-17)
 *
 * "DURING BOMB POTS ONLY, EXTEND THE USERS DECISION CLOCK TO 25 SECONDS INSTEAD
 * OF 15 SECONDS. (MAKE SURE YOU CHANGE AND SLOW DOWN THE COUNTDOWN CLOCK
 * DISAPPEARING LINE AROUND THE PLAYERS NAME TO TAKE 25 SECONDS TO DISAPPEAR
 * INSTEAD OF 15 DURING ANY AND ALL BOMB POTS."
 *
 * The ring is drawn from the published deadline (deadline minus start), so the
 * engine arming a 25 second turn IS the slower ring. What has to hold is that
 * every place that arms a turn asks one method, and that method answers 25 on
 * any bomb hand and the table's own clock on every other hand.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ServerTableEngineBase } from './ServerTableEngineBase.js';
import { HandController } from './HandController.js';

type ClockThis = {
  tableInfo: { action_time_seconds?: number } | null;
  currentHandBombPot: unknown;
  handController: { isBombPotHand?: () => boolean } | null;
};

const clock = (self: ClockThis): number =>
  (
    ServerTableEngineBase.prototype as unknown as { actionClockSeconds(this: ClockThis): number }
  ).actionClockSeconds.call(self);

describe('the decision clock', () => {
  it('is the table clock on an ordinary hand', () => {
    expect(
      clock({ tableInfo: { action_time_seconds: 15 }, currentHandBombPot: null, handController: null })
    ).toBe(15);
    expect(clock({ tableInfo: null, currentHandBombPot: null, handController: null })).toBe(15);
  });

  it('is 25 seconds on a bomb pot, from the hand that was dealt as one', () => {
    expect(
      clock({
        tableInfo: { action_time_seconds: 15 },
        currentHandBombPot: null,
        handController: { isBombPotHand: () => true },
      })
    ).toBe(ServerTableEngineBase.BOMB_POT_ACTION_SECONDS);
    expect(ServerTableEngineBase.BOMB_POT_ACTION_SECONDS).toBe(25);
  });

  it('is 25 seconds on a bomb pot from the frozen hand facts alone', () => {
    expect(
      clock({
        tableInfo: { action_time_seconds: 15 },
        currentHandBombPot: { trigger_reason: 'every_n_hands', ante_amount: 4, board_count: 2 },
        handController: { isBombPotHand: () => false },
      })
    ).toBe(25);
  });

  it('never shortens a table that is configured longer than a bomb pot', () => {
    expect(
      clock({
        tableInfo: { action_time_seconds: 30 },
        currentHandBombPot: null,
        handController: { isBombPotHand: () => true },
      })
    ).toBe(30);
  });

  it('a hand controller knows whether its own hand is a bomb pot', () => {
    const isBomb = (config: unknown) =>
      (HandController.prototype as unknown as { isBombPotHand(this: unknown): boolean })
        .isBombPotHand.call({ config });
    expect(isBomb({ bombPot: { anteMultiplier: 2 } })).toBe(true);
    expect(isBomb({ bombPot: undefined })).toBe(false);
  });
});

describe('every turn-arming site asks the one clock', () => {
  /* Comments quote the old expression to explain history; code must not. */
  const code = (file: string) =>
    readFileSync(resolve(__dirname, file), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^:])\/\/.*$/gm, '$1');

  it.each([
    'ServerTableEngineTurns.ts',
    'ServerTableEngineHandEvents.ts',
    'ServerTableEngineRunout.ts',
    'ServerTableEngineDealing.ts',
  ])('%s never reads tableInfo.action_time_seconds for a turn', (file) => {
    expect(code(file)).not.toMatch(/tableInfo\??\.action_time_seconds/);
  });

  it('the TURN_CHANGE handler stamps the deadline from it', () => {
    expect(code('ServerTableEngineHandEvents.ts')).toMatch(
      /const baseActionTime = this\.actionClockSeconds\(\);/
    );
  });
});
