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
 * The same split sat one seat over: the bet chips in front of each player,
 * the Call / Bet / Raise label and the winner's +N all printed chips while the
 * stack beside them read BB.
 *
 * WHAT THIS PINS
 *   1. the pot is handed the SAME big blind the seats are (`seatBigBlind`),
 *      never a private read of the blinds string with its own fallback;
 *   2. in BB mode every pot figure prints in BB - the POT pill, each side pot,
 *      the TOTAL row and the spoken label - and in chips mode none of them do;
 *   3. in BB mode every figure a seat prints - stack, bet chips, action label,
 *      won amount - reads BB, and in chips mode none of them do.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { render, cleanup } from '@testing-library/react';
import { PotDisplay } from '../src/components/table/PotDisplay';
import SeatSlot, { type SeatPlayer } from '../src/components/table/SeatSlot';

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

describe('in BB mode every figure a seat prints is in BB', () => {
  const villain = (over: Partial<SeatPlayer> = {}): SeatPlayer => ({
    id: 'u-villain',
    name: 'villain',
    avatar: '',
    stack: 200,
    status: 'active',
    isHero: false,
    showCards: false,
    ...over,
  });

  const seat = (inBB: boolean) =>
    render(
      <SeatSlot
        seatNumber={2}
        player={villain()}
        position={null}
        isActive={false}
        lastAction="raise"
        lastBetAmount={12}
        bigBlind={2}
        showStackInBB={inBB}
      />
    );

  const winner = (inBB: boolean) =>
    render(
      <SeatSlot
        seatNumber={2}
        player={villain({ stack: 230 })}
        position={null}
        isActive={false}
        lastAction={null}
        isWinner
        netWinAmount={30}
        bigBlind={2}
        showStackInBB={inBB}
      />
    );

  it('stack, bet chips and the action label read BB', () => {
    const { container } = seat(true);
    expect(container.querySelector('.seat__stack')!.textContent).toContain('BB');
    expect(container.querySelector('.seat__action')!.textContent).toBe('Raise 6.0 BB');
    expect(container.querySelector('.seat__bet-chips .cp-amount')!.textContent).toBe('6.0 BB');
  });

  it("the winner's +N reads BB", () => {
    const { container } = winner(true);
    expect(container.querySelector('.seat__net-win')!.textContent).toBe('+15.0 BB');
  });

  it('in chips mode none of them do', () => {
    const { container } = seat(false);
    expect(container.querySelector('.seat__action')!.textContent).toBe('Raise 12');
    expect(container.querySelector('.seat__bet-chips .cp-amount')!.textContent).toBe('12');
    expect(container.textContent).not.toContain('BB');
    cleanup();
    expect(winner(false).container.querySelector('.seat__net-win')!.textContent).toBe('+30');
  });
});
