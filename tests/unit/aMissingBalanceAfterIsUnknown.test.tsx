/**
 * A diamond ledger row with no recorded balance-after renders as unknown, not
 * as 0 (CLAUDE.md 10.86). Three production rows carry no balance_after, and
 * the VIP page's `Number(entry.balance_after ?? 0)` printed "Diamond Balance 0"
 * under each of them: a figure nobody wrote down, shown as a fact.
 */
import React from 'react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { VIPActivityHistory } from '../../src/components/vip/VIPActivityHistory';
import { readBalanceAfter } from '../../src/utils/readBalanceAfter';

afterEach(cleanup);

describe('a missing balance-after is unknown, not 0', () => {
  it('reads a missing or unreadable value as null and a real one as itself', () => {
    expect(readBalanceAfter(null)).toBeNull();
    expect(readBalanceAfter(undefined)).toBeNull();
    expect(readBalanceAfter('')).toBeNull();
    expect(readBalanceAfter('not a number')).toBeNull();
    expect(readBalanceAfter(0)).toBe(0);
    expect(readBalanceAfter('1200')).toBe(1200);
    expect(readBalanceAfter(9822)).toBe(9822);
  });

  it('renders Not Recorded for a row with no balance-after, and the real figure otherwise', () => {
    const { container } = render(
      <VIPActivityHistory
        activities={[
          {
            id: 'a',
            date: new Date('2026-10-07T10:00:00Z'),
            action: 'earned',
            description: 'Welcome Bonus',
            diamonds: 500,
            balanceAfter: null,
          },
          {
            id: 'b',
            date: new Date('2026-10-07T11:00:00Z'),
            action: 'spent',
            description: 'Diamond Arena Buy-In',
            diamonds: 300,
            balanceAfter: 1200,
          },
        ]}
      />
    );
    const values = Array.from(container.querySelectorAll('.balance-value')).map((n) =>
      (n.textContent || '').trim()
    );
    expect(values).toContain('Not Recorded');
    expect(values).toContain((1200).toLocaleString());
    expect(values).not.toContain('0');
  });

  it('the VIP page never coerces balance_after to 0', () => {
    const page = readFileSync(join(__dirname, '../../src/pages/VIPPage.tsx'), 'utf8');
    expect(page).not.toMatch(/balance_after\s*\?\?\s*0/);
    expect(page).toContain('readBalanceAfter(entry.balance_after)');
  });
});
