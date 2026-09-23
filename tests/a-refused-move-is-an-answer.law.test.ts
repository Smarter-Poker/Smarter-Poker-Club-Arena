/**
 * A REFUSED MOVE IS AN ANSWER, AND NOTHING ON THE CONSOLE REFRESHES
 * (review 2026-09-22), on Donkey Cross and Diamond Mines.
 *
 * Owner rule: no game may ever require a player to check, refresh or retry
 * anything; it recovers by itself. fn_choice_act refuses a move with
 * {ok:false,error} and changes nothing (during the maintenance break it says
 * so). The page read every refusal as a lost answer: "Confirming Your Move",
 * a read of the unchanged round, and the reason gone, so the break was never
 * shown and the player kept pressing a live tile. The service now throws the
 * server's refusal as ChoiceMoveRefused (a database-raised error too, by the
 * rule the start doors follow), and the page shows it and reads the game
 * again, never marking the move unconfirmed; the end of the break takes the
 * reason down by itself.
 *
 * The console's second plate read "Refresh" whenever no win could be booked,
 * and pressing it re-read the game by hand. It is Book The Win - and the chips
 * that press would book, once there are any to name - live only once a win can
 * be booked. Behaviour: DiamondChoiceMoveAnswers under tests/components and
 * diamondChoiceMoveAnswers under tests/unit.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { moveRefusedByDatabase } from '../src/services/DiamondChoiceService';
import { bonusErrorKind } from '../src/services/DiamondBonusService';

const ROOT = join(__dirname, '..');
/** Source without comments: history may be explained, never counted. */
const code = (p: string) =>
  readFileSync(join(ROOT, p), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\{\s*\/\*[\s\S]*?\*\/\s*\}/g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
const PAGE = 'src/pages/DiamondChoicePage.tsx';
const SERVICE = 'src/services/DiamondChoiceService.ts';

describe('a refused move is an answer', () => {
  it("the move door throws the server's refusal, not a lost answer", () => {
    const service = code(SERVICE);
    const act = service.slice(service.indexOf('async act('));
    expect(act).toMatch(/throw new ChoiceMoveRefused\(refusal\.error\)/);
    expect(act).toMatch(
      /if \(moveRefusedByDatabase\(error\)\) throw new ChoiceMoveRefused\(MOVE_NOT_TAKEN\)/
    );
    // No second door opens a round around the saved-wager path.
    expect(service).not.toMatch(/fn_choice_start/);
  });

  it('reads a database error exactly as the start doors do', () => {
    for (const code of ['P0001', '23505', '42501', '40001', '40P01', '55P03', '57014'])
      expect(moveRefusedByDatabase({ code }), code).toBe(bonusErrorKind({ code }) === 'refused');
    for (const code of ['PGRST000', 'PGRST003', 'PGRST116', 'PGRST202', ''])
      expect(moveRefusedByDatabase({ code }), code).toBe(bonusErrorKind({ code }) === 'refused');
  });

  it('the page shows a refusal and reads the game again, and never marks it unconfirmed', () => {
    const page = code(PAGE);
    const act = page.slice(page.indexOf('const act = async'), page.indexOf('const startRef'));
    const refused = act.slice(
      act.indexOf('if (e instanceof ChoiceMoveRefused)'),
      act.indexOf('} else {', act.indexOf('if (e instanceof ChoiceMoveRefused)'))
    );
    expect(refused).toMatch(/setError\(e\.message\)/);
    expect(refused).toMatch(/load\(uuid\)/);
    expect(refused).not.toMatch(/setUncertain/);
    // The end of the break takes the reason down without a press.
    expect(page).toMatch(/const resumed = wasFrozen\.current && !frozen;/);
  });

  it('the console offers no Refresh: its second plate books the win and nothing else', () => {
    const page = code(PAGE);
    expect(page).not.toMatch(/['"`]Refresh['"`]/);
    expect(page).toMatch(/const cashLabel = bookable === null \? 'Book The Win' : /);
    expect(page).toMatch(/const canBook = open && picks > 0 && !busy && !sceneBusy && !uncertain;/);
    const plate = page.slice(
      page.indexOf('secondary={{'),
      page.indexOf('}}', page.indexOf('secondary={{'))
    );
    expect(plate).toMatch(/label: pendingAction === 'book' \? 'Booking Win' : cashLabel,/);
    expect(plate).toMatch(/if \(!canBook\) return;/);
    expect(plate).toMatch(/void act\('cashout', null\);/);
    expect(plate).not.toMatch(/refresh/);
  });
});
