/**
 * THE BOMB POT HAND INTERVAL IS A WHOLE NUMBER FROM 1 TO 200, AND SAYS WHAT IT MEANS
 * (Create A Club phase 2, 2026-09-20)
 *
 * The field's only check was `Math.max(1, Number(v) || 1)`. It did not round
 * and had no ceiling, and fn_update_table_bomb_settings reads the value with
 * `(p_settings ->> 'bomb_pot_frequency')::int`, a cast that RAISES on "2.5".
 * It also had no plain sentence: "Bomb Pot Hand Interval ... Hands" does not
 * tell a host whether 10 means the 10th hand or ten hands between bombs.
 *
 * The sentence is pinned to what the engine does. BombPotScheduler counts
 * every dealt hand, makes a bomb due when the count REACHES the frequency and
 * resets the count when the bomb is dealt, so N is "every Nth hand".
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

const mocks = vi.hoisted(() => ({
  rpc: vi.fn(),
  row: {} as Record<string, unknown>,
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() },
}));

vi.mock('../src/lib/supabase', () => ({
  supabase: {
    rpc: (...a: unknown[]) => mocks.rpc(...a),
    from: () => ({
      select: () => ({
        eq: () => ({ maybeSingle: async () => ({ data: mocks.row, error: null }) }),
      }),
    }),
  },
}));
vi.mock('../src/components/common/Toast', () => ({ useToast: () => mocks.toast }));
vi.mock('../src/utils/errorReporter', () => ({ reportError: vi.fn() }));

import TableBombSettingsPage from '../src/pages/club/TableBombSettingsPage';

const baseRow = {
  name: 'NLH 1/2 Main',
  bomb_pot_enabled: true,
  bomb_pot_trigger_mode: 'every_n_hands',
  bomb_pot_frequency: 10,
  bomb_pot_interval_seconds: 900,
  bomb_pot_board_count: 2,
  bomb_pot_min_players: 3,
  bomb_pot_ante_multiplier: 2,
  bomb_pot_ante_fixed: 0,
  bomb_pot_variant: null,
  bomb_pot_button_policy: 'regular',
  bomb_pot_announce_seconds: 0,
};

const mount = async () => {
  render(
    <MemoryRouter initialEntries={['/clubs/c1/tables/t1/bomb-settings']}>
      <Routes>
        <Route
          path="/clubs/:clubId/tables/:tableId/bomb-settings"
          element={<TableBombSettingsPage />}
        />
        <Route path="/clubs/:clubId" element={<p>Club Home</p>} />
      </Routes>
    </MemoryRouter>
  );
  return (await screen.findByLabelText(/Bomb Pot Hand Interval/)) as HTMLInputElement;
};

const sentence = () => screen.getByTestId('bomb-interval-sentence').textContent;
const refusal = () => screen.queryByTestId('bomb-interval-refusal')?.textContent ?? null;
const sentFrequency = () =>
  (mocks.rpc.mock.calls.at(-1)?.[1] as { p_settings: { bomb_pot_frequency: unknown } }).p_settings
    .bomb_pot_frequency;

beforeEach(() => {
  mocks.rpc.mockReset();
  mocks.rpc.mockResolvedValue({ data: { ok: true, changed: true }, error: null });
  mocks.row = { ...baseRow };
  mocks.toast.error.mockReset();
  mocks.toast.success.mockReset();
});
afterEach(cleanup);

describe('the hand interval field', () => {
  it('says in a plain sentence what the stored number means', async () => {
    const input = await mount();
    expect(input.value).toBe('10');
    expect(sentence()).toBe('Every 10th Hand Is A Bomb Pot');
    expect(refusal()).toBeNull();
    // The words are tied to the field for a screen reader.
    const hint = document.getElementById(input.getAttribute('aria-describedby') ?? '');
    expect(hint?.textContent).toContain('Every 10th Hand Is A Bomb Pot');
  });

  it.each([
    ['0', 1, 'Every Hand Is A Bomb Pot', 'The Fewest Is 1 Hand, So This Is Set To 1'],
    ['2.5', 3, 'Every 3rd Hand Is A Bomb Pot', 'Hands Are Whole Numbers, So This Is Set To 3'],
    [
      '99999',
      200,
      'Every 200th Hand Is A Bomb Pot',
      'The Most Is 200 Hands, So This Is Set To 200',
    ],
    ['-4', 1, 'Every Hand Is A Bomb Pot', 'The Fewest Is 1 Hand, So This Is Set To 1'],
  ])(
    'typing %s yields %i: the sentence, the refusal, the box on blur and the RPC all agree',
    async (typed, expected, words, why) => {
      const input = await mount();
      fireEvent.change(input, { target: { value: typed } });
      // Live, before blur: the sentence already states the number in force.
      expect(sentence()).toBe(words);
      expect(refusal()).toBe(why);
      expect(input.getAttribute('aria-invalid')).toBe('true');
      // Refused in the kit's red while the box holds a number the table will
      // not use.
      expect(screen.getByTestId('bomb-interval-refusal').className).toContain('sc-ink--red');
      // The half-typed text is left alone while the host is still in the box.
      expect(input.value).toBe(typed);

      fireEvent.blur(input);
      expect(input.value).toBe(String(expected));
      // The correction stays, so the snap is explained rather than silent...
      expect(refusal()).toBe(why);
      // ...but the box now holds the number in force, so it is no longer
      // marked invalid and the note drops from red to muted ink.
      expect(input.getAttribute('aria-invalid')).toBeNull();
      expect(screen.getByTestId('bomb-interval-refusal').className).toContain('sc-ink--muted');
      expect(sentence()).toBe(words);

      fireEvent.click(screen.getByRole('button', { name: 'Save Settings' }));
      await waitFor(() => expect(mocks.rpc).toHaveBeenCalled());
      expect(mocks.rpc.mock.calls.at(-1)?.[0]).toBe('fn_update_table_bomb_settings');
      expect(sentFrequency()).toBe(expected);
      expect(Number.isInteger(sentFrequency())).toBe(true);
    }
  );

  it('saves a whole number even when the host never leaves the box', async () => {
    const input = await mount();
    fireEvent.change(input, { target: { value: '2.5' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save Settings' }));
    await waitFor(() => expect(mocks.rpc).toHaveBeenCalled());
    expect(sentFrequency()).toBe(3);
  });

  it('an ordinal is grammatical: 1st 2nd 3rd 4th 11th 12th 13th 21st 22nd 101st 111th', async () => {
    const input = await mount();
    const cases: Array<[string, string]> = [
      ['2', 'Every 2nd Hand Is A Bomb Pot'],
      ['3', 'Every 3rd Hand Is A Bomb Pot'],
      ['4', 'Every 4th Hand Is A Bomb Pot'],
      ['11', 'Every 11th Hand Is A Bomb Pot'],
      ['12', 'Every 12th Hand Is A Bomb Pot'],
      ['13', 'Every 13th Hand Is A Bomb Pot'],
      ['21', 'Every 21st Hand Is A Bomb Pot'],
      ['22', 'Every 22nd Hand Is A Bomb Pot'],
      ['101', 'Every 101st Hand Is A Bomb Pot'],
      ['111', 'Every 111th Hand Is A Bomb Pot'],
    ];
    for (const [typed, words] of cases) {
      fireEvent.change(input, { target: { value: typed } });
      expect(sentence()).toBe(words);
      expect(refusal()).toBeNull();
      expect(input.getAttribute('aria-invalid')).toBeNull();
    }
  });

  it('an empty or unreadable box changes nothing, and never means a bomb on every hand', async () => {
    const input = await mount();
    for (const typed of ['', 'abc', '   ']) {
      fireEvent.change(input, { target: { value: typed } });
      expect(refusal()).toBe('Enter A Whole Number From 1 To 200');
      // The table keeps the last whole number.
      expect(sentence()).toBe('Every 10th Hand Is A Bomb Pot');
    }
    fireEvent.blur(input);
    expect(input.value).toBe('10');
    expect(refusal()).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Save Settings' }));
    await waitFor(() => expect(mocks.rpc).toHaveBeenCalled());
    expect(sentFrequency()).toBe(10);
  });

  it('a row stored above the ceiling is shown as what this page will save, with the reason', async () => {
    mocks.row = { ...baseRow, bomb_pot_frequency: 500 };
    const input = await mount();
    expect(input.value).toBe('200');
    expect(sentence()).toBe('Every 200th Hand Is A Bomb Pot');
    expect(refusal()).toBe('The Most Is 200 Hands, So This Is Set To 200');
  });
});

describe('the sentence is true of the engine (read-only pin)', () => {
  const SCHED = readFileSync(
    resolve(process.cwd(), 'server/src/engine/BombPotScheduler.ts'),
    'utf8'
  );
  it('a bomb becomes due on the hand where the count REACHES the frequency, then the count resets', () => {
    expect(SCHED).toMatch(
      /this\.handsSinceBomb\+\+;\s*if \(this\.handsSinceBomb >= s\.frequency\) \{\s*this\.pending = true;/
    );
    expect(SCHED).toMatch(/this\.pending = false;[\s\S]{0,120}this\.handsSinceBomb = 0;/);
  });

  it('the RPC still reads the value through an integer cast, which is why the page must round', () => {
    // The newest definition is the live one: migrations apply in version
    // order, and the version is the digits before the first underscore.
    const DIR = resolve(process.cwd(), 'supabase/migrations');
    const defining = readdirSync(DIR)
      .filter((f) => f.endsWith('.sql'))
      .filter((f) =>
        /CREATE OR REPLACE FUNCTION public\.fn_update_table_bomb_settings\(/.test(
          readFileSync(resolve(DIR, f), 'utf8')
        )
      )
      .sort((a, b) => Number(a.split('_')[0]) - Number(b.split('_')[0]));
    expect(defining.length).toBeGreaterThan(0);
    const SQL = readFileSync(resolve(DIR, defining[defining.length - 1]), 'utf8');
    expect(SQL).toMatch(/\(p_settings ->> 'bomb_pot_frequency'\)::int/);
  });
});
