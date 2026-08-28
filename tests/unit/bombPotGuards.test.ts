/**
 * BOMB POT GUARDS (2026-08-28) — source pins for the multi-board rules that
 * live at integration seams no harness drives end to end. Same pattern as
 * showdownSystem.test.ts: the pin names the exact line so the next refactor
 * that drops a guard fails here instead of in production.
 *
 * Spec references: Dan's Bomb Pot Rules + Architecture Specification §19
 * (Rabbit Hunt disabled on multi-board bomb pots; RIT suppressed) and §15
 * (the table must disclose bomb rules from the columns the engine plays by).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { sliceMethod, sliceEnclosingBlock } from '../helpers/sourceWindow';

const read = (p: string) => readFileSync(resolve(__dirname, '../../', p), 'utf8');

describe('a multi-board bomb pot is never offered a rabbit hunt (spec §19)', () => {
  const SETTLEMENT = read('server/src/engine/ServerTableEngineSettlement.ts');

  it('the offer gate excludes multi-board hands like it excludes RIT', () => {
    expect(SETTLEMENT).toMatch(/multiBoardBomb\s*=\s*this\.handController\?\.isDoubleBoardActive/);
    expect(SETTLEMENT).toMatch(/!ranItTwice && !multiBoardBomb/);
  });

  it('the client draws no board-1 rabbit cards on boards 2 and 3', () => {
    const PAGE = read('src/pages/TablePage.tsx');
    // Board 2 and board 3 both mount CommunityCards with an EMPTY rabbit list.
    const board2 = PAGE.slice(PAGE.indexOf('className="community-area__board2"'));
    expect(board2).toMatch(/rabbitCards=\{\[\]\}/);
    const board3 = PAGE.slice(PAGE.indexOf('community-area__board3'));
    expect(board3).toMatch(/rabbitCards=\{\[\]\}/);
  });
});

describe('RIT and insurance stay suppressed on any multi-board hand (spec §14/§19)', () => {
  it('isDoubleBoardActive answers for two AND three boards', () => {
    const HC = read('server/src/engine/HandController.ts');
    const fn = HC.slice(HC.indexOf('public isDoubleBoardActive'));
    expect(fn).toMatch(/return this\.multiBoardActive;/);
  });
});

describe('the LIVE hand variant is the one seam (spec §10.1)', () => {
  const BASE = read('server/src/engine/ServerTableEngineBase.ts');
  const ENGINE = read('server/src/engine/ServerTableEngine.ts');
  const TURNS = read('server/src/engine/ServerTableEngineTurns.ts');
  const SETTLEMENT = read('server/src/engine/ServerTableEngineSettlement.ts');
  const DEALING = read('server/src/engine/ServerTableEngineDealing.ts');

  it('Base exposes activeHandVariant reading the live HandController', () => {
    expect(BASE).toMatch(
      /activeHandVariant\(\): string \{\s*return this\.handController\?\.getGameVariant\?\.\(\) \?\? this\.dealtGameVariant\(\);/
    );
  });

  it('the snapshot betting structure reads the HAND variant', () => {
    const fn = sliceMethod(ENGINE, 'private bettingStructureFields');
    expect(fn).toMatch(/this\.activeHandVariant\(\)/);
    expect(fn).not.toMatch(/tableInfo\?\.game_variant/);
  });

  it('the legal-action pot-limit clamp reads the HAND variant', () => {
    const window = sliceEnclosingBlock(TURNS, 'const structure = bettingStructureFor(variant)');
    expect(window).toMatch(/this\.activeHandVariant\(\)/);
  });

  it('horses evaluate the HAND variant', () => {
    expect(TURNS).toMatch(/gameVariant: \(this\.activeHandVariant\(\) \|\| 'nlh'\)/);
  });

  it('hand history records the variant the hand was DEALT as', () => {
    expect(SETTLEMENT).toMatch(
      /gameVariant: this\.currentHandVariant \|\| this\.tableInfo\.game_variant \|\| 'nlh'/
    );
  });

  it('an override that cannot cover the seats yields to the table variant', () => {
    // 9-handed PLO6 needs 54 hole cards from 52. The override must yield,
    // never the deal.
    expect(DEALING).toMatch(/holeNeed <= deckSizeFor\(resolved\)/);
  });
});

describe('BOMB POT MAX (2026-08-28) — the round-4 seams', () => {
  const DEALING = read('server/src/engine/ServerTableEngineDealing.ts');
  const RUNOUT = read('server/src/engine/ServerTableEngineRunout.ts');
  const SETTLEMENT = read('server/src/engine/ServerTableEngineSettlement.ts');
  const HORSE = read('server/src/engine/HorseLogic.ts');
  const TURNS = read('server/src/engine/ServerTableEngineTurns.ts');

  it('the manual trigger fails CLOSED when the flag cannot be cleared', () => {
    // A bomb that fires twice is worse than one that arrives a hand late.
    expect(DEALING.indexOf('bomb_pot_manual_pending: false')).toBeGreaterThan(-1);
    // The clear and its error branch are siblings in the same handler, so the
    // bound is that block - not however many bytes the update happens to take.
    const window = sliceEnclosingBlock(DEALING, 'bomb_pot_manual_pending: false', 0, 2);
    expect(window).toMatch(/if \(clearErr\)/);
    expect(window).toMatch(/deferring/);
  });

  it('the separate bomb button rewinds the regular rotation on bomb hands', () => {
    expect(DEALING).toMatch(/bomb_pot_button_policy \?\? 'regular'\) === 'separate'/);
    expect(DEALING).toMatch(/this\.lastButtonSeat = prevButtonSeat > 0 \? prevButtonSeat/);
  });

  it('scheduler state persists and is restored before the first hand', () => {
    expect(DEALING).toMatch(/this\.bombPotScheduler\.restoreState\(persistedState\)/);
    expect(DEALING).toMatch(/bomb_pot_sched_state: snapObj/);
  });

  it('multi-board all-in equity is COMPUTED per board, not suppressed', () => {
    expect(RUNOUT).toMatch(/if \(allInPlayers\.length >= 2\) \{/);
    expect(RUNOUT).not.toMatch(/allInPlayers\.length >= 2 && !doubleBoardHand/);
    expect(RUNOUT).toMatch(/perBoard\.reduce/);
    // RIT and insurance stay suppressed on multi-board hands.
    expect(RUNOUT).toMatch(/insuranceEngine\.isEnabled\(this\.tableId\) && !doubleBoardHand/);
  });

  it('horses average per-board equity on multi-board hands', () => {
    expect(HORSE).toMatch(/gs\.communityCards2/);
    expect(HORSE).toMatch(/equity = sum \/ boards\.length/);
    expect(TURNS).toMatch(/communityCards2: fullState\?\.communityCards2 \?\? \[\]/);
  });

  it('the award-unit ledger writes only settled multi-board bomb hands, idempotently', () => {
    const idx = SETTLEMENT.indexOf("from('bomb_pot_award_units')");
    expect(idx).toBeGreaterThan(-1);
    const window = SETTLEMENT.slice(Math.max(0, idx - 1200), idx + 600);
    expect(window).toMatch(/board_count \?\? 1\) >= 2/);
    expect(window).toMatch(/onConflict: 'hand_history_id,pot_index,board,side,user_id'/);
    expect(window).toMatch(/ignoreDuplicates: true/);
  });
});

describe('the table page reads bomb rules from the COLUMNS (spec §15.2)', () => {
  const PAGE = read('src/pages/TablePage.tsx');

  it('the bootstrap select fetches the canonical bomb columns', () => {
    expect(PAGE).toMatch(
      /straddle_enabled, bomb_pot_enabled, bomb_pot_frequency, bomb_pot_ante_multiplier, bomb_pot_double_board, bomb_pot_board_count, bomb_pot_trigger_mode, bomb_pot_interval_seconds/
    );
  });

  it('bombPotRules prefers the row columns over the settings blob', () => {
    // All live tables carry settings = {}; reading the blob alone is the bug
    // that kept the Game Rules bomb section dark on every table.
    expect(PAGE).toMatch(
      /table\.bomb_pot_enabled === true \|\| settings\.bomb_pot_enabled === true/
    );
  });

  it('the timed felt clock counts down to the engine due timestamp', () => {
    expect(PAGE).toMatch(/bomb_pot_next_at|bombPotNextAt/);
    expect(PAGE).toMatch(/bombClockLabel/);
  });
});
