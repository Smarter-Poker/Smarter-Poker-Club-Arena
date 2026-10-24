/**
 * LAW: DOUBLE DIAMONDS IS RETIRED FROM THE DIAMOND SPINS BONUS GAMES.
 *
 * Dan, 2026-10-16, verbatim: "REMOVE THE DOUBLE DIAMONDS FUNCTIONALITY FOR THE
 * BONUS GAMES ON THE DIAMOND SPINS. ITS CONFUSING TO SOME PLAYERS."
 *
 * A won bonus game (Plinko, Crash, Donkey Cross, Diamond Mines) plays exactly
 * the diamonds the wheel funded. There is no Double Your Diamonds screen and
 * no Double Down box, nothing a player saved can ask for the add-on again, and
 * the server refuses a new start that does (migration 20261017040017), so a
 * tab still holding an older bundle cannot start one either. A round an older
 * page already opened WITH the add-on still replays its own receipt: that
 * read path is deliberately kept, and the refusal sits after it.
 *
 * If you are bringing the add-on back, that is Dan's call to reverse, not a
 * regression to "fix" - change this law in the same commit and say so.
 * docs/changelog/2026-10-17-double-diamonds-is-retired.md.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { renderHook } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import BonusSetup from '../src/components/games/BonusSetup';
import { awardBudget } from '../src/services/WheelBonusEntryService';
import { useBonusBudget } from '../src/hooks/useBonusBudget';
import type { BonusBudget } from '../src/utils/bonusGameBudget';

const ROOT = join(__dirname, '..');
const read = (path: string) => readFileSync(join(ROOT, path), 'utf8');

afterEach(() => {
  cleanup();
  sessionStorage.clear();
});

const AWARD = {
  id: '00000000-0000-4000-8000-000000000077',
  entryDiamonds: 100,
  boostMultiplier: 2 as const,
};
const funded: BonusBudget = { base: 200, doubled: false, denomination: null, award: AWARD };

describe('Double Diamonds is retired', () => {
  it('the offer component is gone, and no game page imports an offer step', () => {
    expect(existsSync(join(ROOT, 'src/components/games/DoubleDownOffer.tsx'))).toBe(false);
    for (const page of [
      'src/pages/DiamondPlinkoPage.tsx',
      'src/pages/DiamondCrashPage.tsx',
      'src/pages/DiamondChoicePage.tsx',
      'src/pages/DiamondTestPage.tsx',
      'src/components/games/BonusSetup.tsx',
    ]) {
      const source = read(page);
      expect(source, page).not.toMatch(/DoubleDownOffer|bonusEntryStep|onOfferAnswered/);
      expect(source, page).not.toMatch(/'Answer The Offer First'|'Add The Diamonds'/);
    }
  });

  it.each(['plinko', 'crash', 'crossing', 'mines'] as const)(
    'a won %s award opens on its setup with no Double Down control',
    (game) => {
      render(
        <MemoryRouter>
          <BonusSetup
            budget={funded}
            game={game}
            diamonds={10_000}
            disabled={false}
            clubId="shark-club"
            leave={() => undefined}
            onChange={() => undefined}
          />
        </MemoryRouter>
      );
      expect(screen.getByLabelText('Your Bonus Setup')).toHaveAttribute('data-bonus-step', 'setup');
      expect(screen.queryByRole('dialog')).toBeNull();
      expect(screen.queryByRole('checkbox')).toBeNull();
      expect(screen.queryByText(/Double Down|Double Your Diamonds|Diamonds Added/i)).toBeNull();
    }
  );

  it('the award-less setup has no Double Down box either', () => {
    render(
      <MemoryRouter>
        <BonusSetup
          budget={{ base: 100, doubled: false, denomination: null }}
          game="crash"
          diamonds={10_000}
          disabled={false}
          clubId="shark-club"
          leave={() => undefined}
          onChange={() => undefined}
        />
      </MemoryRouter>
    );
    expect(screen.queryByRole('checkbox')).toBeNull();
    expect(screen.queryByText(/Double Down/i)).toBeNull();
  });

  it('an award is quoted without the add-on even when a saved preference took it', () => {
    const budget = awardBudget(
      {
        id: AWARD.id,
        base_diamonds: 200,
        entry_diamonds: 100,
        boost_multiplier: 2,
      } as never,
      { ...funded, doubled: true }
    );
    expect(budget.doubled).toBe(false);
    expect(budget.base).toBe(200);
  });

  it('a selection an older page saved with the add-on is read back without it', () => {
    sessionStorage.setItem(
      'diamond-spins-budget::club:crash',
      JSON.stringify({ base: 300, doubled: true, denomination: null })
    );
    const { result } = renderHook(() => useBonusBudget('club', 'crash'));
    expect(result.current[0].doubled).toBe(false);
    expect(result.current[0].base).toBe(300);
  });

  it('every page asks the server for its award without the add-on', () => {
    expect(read('src/hooks/useEarnedBonus.ts')).toMatch(
      /WheelBonusEntryService\.state\(club, game, false,/
    );
  });

  it('the server refuses a new doubled start, after the replay of an older one', () => {
    // Find the newest declaration directly. Reading every historical migration
    // for each function exceeded the case budget under shared SSD contention.
    const migrations = readdirSync(join(ROOT, 'supabase/migrations')).sort().reverse();
    const latest = (fn: string) =>
      migrations.find((file) =>
        read(`supabase/migrations/${file}`).includes(`FUNCTION public.${fn}(`)
      );
    for (const fn of ['fn_wheel_bonus_start', 'fn_diamond_bonus_start']) {
      const file = latest(fn);
      expect(file, fn).toBeDefined();
      const sql = read(`supabase/migrations/${file}`);
      const body = sql.slice(sql.indexOf(`FUNCTION public.${fn}(`));
      const end = body.indexOf('$function$;');
      const fnBody = body.slice(0, end);
      const replay = fnBody.indexOf("'replayed',true");
      const refusal = fnBody.indexOf(
        "IF p_double THEN RETURN jsonb_build_object('ok',false,'error','Double Diamonds Is No Longer Offered."
      );
      const firstWrite = fnBody.search(
        /INSERT INTO public\.diamond_bonus_entries|UPDATE public\.wheel_bonus_awards/
      );
      expect(replay, `${fn} replays an older round`).toBeGreaterThan(0);
      expect(refusal, `${fn} refuses the add-on`).toBeGreaterThan(replay);
      expect(refusal, `${fn} refuses before any write`).toBeLessThan(firstWrite);
    }
  });
});
