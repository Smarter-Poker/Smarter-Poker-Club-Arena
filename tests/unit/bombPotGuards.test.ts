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
