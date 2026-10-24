/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  THE POT FOLLOWS THE STACK DISPLAY: BB MEANS BB EVERYWHERE ON THE FELT
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Dan 2026-10-24: "WHEN YOU CHANGE YOUR STACK FROM A TOTAL TO BB IT SHOW THE
 * TOTAL POT AMOUNT IN THE POT AS TOTAL CHIPS INSTEAD OF BB'S. THAT NEEDS TO BE
 * UPDATED."
 *
 * The pot, the seats and the raise panel all read the one setting
 * (`user_table_settings.show_stack_in_bb`). They did NOT read the same big
 * blind. Every seat and the raise panel used `safeBB(tableState.blinds)`, whose
 * own fallback is 2; the pot alone used `safeBB(tableState.blinds, 0)`.
 * PotDisplay only prints BB when its big blind is above zero, so whenever the
 * blinds string was not yet a clean pair - a Lightning room seeds "?/?", an
 * auto-seat or a tab opened without the lobby card has no blinds until the
 * table row lands - the stacks switched to BB and the pot, holding a big blind
 * of 0, kept printing chips.
 *
 * WHAT THIS PINS
 *   1. the pot is handed the SAME big blind the seats are (`seatBigBlind`),
 *      never a private read of the blinds string with its own fallback;
 *   2. in BB mode every pot figure prints in BB - the POT pill, each side pot,
 *      the TOTAL row and the spoken label - and in chips mode none of them do.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { render, cleanup } from '@testing-library/react';
import { PotDisplay } from '../src/components/table/PotDisplay';

const ROOT = resolve(__dirname, '..');
const stripComments = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');

afterEach(cleanup);

describe('the pot reads the same big blind as the stacks', () => {
  const page = stripComments(readFileSync(resolve(ROOT, 'src/pages/TablePage.tsx'), 'utf8'));

  /** The props of the one `<PotDisplay ... />` element on the felt. */
  const potProps = (() => {
    const start = page.indexOf('<PotDisplay');
    expect(start, 'TablePage renders PotDisplay').toBeGreaterThan(-1);
    return page.slice(start, page.indexOf('/>', start));
  })();

  it('PotDisplay is handed seatBigBlind', () => {
    expect(potProps).toMatch(/bigBlind=\{seatBigBlind\}/);
  });

  it('PotDisplay never reads the blinds string with a fallback of its own', () => {
    expect(potProps).not.toMatch(/bigBlind=\{\s*safeBB\(/);
  });

  it('the seats are handed the same seatBigBlind', () => {
    expect(page).toMatch(/const seatBigBlind = useMemo\(\(\) => safeBB\(tableState\.blinds\)/);
    expect(page).toMatch(/<SeatSlot[\s\S]*?bigBlind=\{seatBigBlind\}/);
  });

  it('both read the one stack-display setting', () => {
    expect(potProps).toMatch(/displayMode=\{v8Settings\.show_stack_in_bb \? 'bb' : 'chips'\}/);
    expect(page).toMatch(/showStackInBB=\{v8Settings\.show_stack_in_bb\}/);
  });
});

describe('in BB mode every pot figure is in BB', () => {
  const sidePots = [{ id: 's1', amount: 40, eligiblePlayers: ['a', 'b'] }];

  it('the POT pill, side pot, TOTAL and spoken label all read BB', () => {
    const { container } = render(
      <PotDisplay mainPot={150} streetBets={20} sidePots={sidePots} bigBlind={2} displayMode="bb" />
    );
    const main = container.querySelector('.pot-display__main')!.textContent;
    const total = container.querySelector('.pot-display__total')!.textContent;
    const side = container.querySelector('.pot-display__side-pots')!.textContent;
    const label = container.querySelector('.pot-display')!.getAttribute('aria-label');
    expect(main).toBe('POT65 BB');
    expect(side).toContain('20 BB');
    expect(total).toBe('TOTAL95 BB');
    expect(label).toBe('Pot: 65 BB, 10 BB In Front Of Players Plus 1 Side pot');
  });

  it('in chips mode none of them do', () => {
    const { container } = render(
      <PotDisplay mainPot={150} sidePots={sidePots} bigBlind={2} displayMode="chips" />
    );
    expect(container.textContent).not.toContain('BB');
    expect(container.querySelector('.pot-display')!.getAttribute('aria-label')).not.toContain('BB');
  });
});
