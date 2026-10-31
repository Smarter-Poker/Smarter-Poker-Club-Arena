/**
 * Player Management always shows fees generated, never a wallet balance
 * (Dan, 2026-10-14: "IT SHOULD ALWAYS SHOW FEES GENERATED, NOT WALLET
 * BALANCES"). The Simple row's one figure is the player's fees; an agent with
 * a downline also sees the downline's fees. Wallets stay an opt-in Advanced
 * column and are off by default.
 */
import '@testing-library/jest-dom/vitest';
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

vi.mock('../../src/hooks/useProfilePresence', () => ({
  useOnlineNow: (_id: string, loaded: boolean) => loaded,
}));

import { MemberRow } from '../../src/pages/ClubMembersPage';
import { feeFigure } from '../../src/utils/format';
import { mapRosterRow } from '../../src/services/ClubRosterService';
import { defaultRosterWorkspace } from '../../src/lib/rosterWorkspace';

function simpleRow(overrides: Record<string, unknown>) {
  return (
    <MemberRow
      member={mapRosterRow({
        user_id: 'u-1',
        alias: 'King',
        username: 'king',
        player_number: '940017',
        role: 'player',
        can_view_financials: true,
        player_wallet: 274_600,
        agent_wallet: 0,
        total_fees: 12_345.67,
        downline_fees: 0,
        downline_total: 0,
        ...overrides,
      })}
      position={1}
      total={1}
      query=""
      onOpen={vi.fn()}
      selectable={false}
      selected={false}
      onSelect={vi.fn()}
      columns={new Set(defaultRosterWorkspace().columns)}
      winLoss={{ cash: -20, mtt: 5, net: -15, fees: 12_345.67, downline_fees: 2_500 }}
      feeLabel="Fees This Week"
      simpleMode
    />
  );
}

describe('Player Management shows fees generated', () => {
  it('prints the fee figure and never the wallet in Simple mode', () => {
    render(simpleRow({}));
    expect(screen.getByText('Fees This Week')).toBeVisible();
    expect(screen.getByText('12,345.67')).toBeVisible();
    expect(screen.queryByText('Player Wallet')).not.toBeInTheDocument();
    expect(screen.queryByText('274.6K')).not.toBeInTheDocument();
  });

  it('adds downline fees for an agent with a downline', () => {
    render(simpleRow({ role: 'agent', downline_total: 4, downline_fees: 2_500 }));
    expect(screen.getByText('Downline 2,500.00')).toBeVisible();
  });

  it.each([true, false])(
    'uses period fees rather than lifetime fees in Simple=%s',
    (simpleMode) => {
      const row = simpleRow({ total_fees: 987654, downline_total: 4, downline_fees: 999999 });
      render({
        ...row,
        props: {
          ...row.props,
          simpleMode,
          winLoss: { cash: -20, mtt: 5, net: -15, fees: 66.63, downline_fees: 155.09 },
        },
      });
      expect(screen.getByText('66.63')).toBeVisible();
      expect(screen.queryByText('987.6K')).not.toBeInTheDocument();
      expect(screen.queryByText('999.9K')).not.toBeInTheDocument();
    }
  );
  it.each([false, true])(
    'never falls back to lifetime fees while loading or failed (failed=%s)',
    (failed) => {
      const row = simpleRow({ total_fees: 987654 });
      render({ ...row, props: { ...row.props, winLoss: undefined, winLossUnavailable: failed } });
      expect(screen.queryByText('987.6K')).not.toBeInTheDocument();
      expect(screen.getAllByText(failed ? 'Unavailable' : '...').length).toBeGreaterThan(0);
    }
  );

  it('does not floor small fees to zero', () => {
    expect(feeFigure(0.5)).toBe('0.50');
    expect(feeFigure(999.25)).toBe('999.25');
    expect(feeFigure(1_200)).toBe('1,200.00');
    expect(feeFigure(3.5)).toBe('3.50');
    expect(feeFigure(31_400.25)).toBe('31,400.25');
    expect(feeFigure(null)).toBe('Restricted');
  });

  it('keeps wallets out of the default Advanced columns', () => {
    expect(defaultRosterWorkspace().columns).not.toContain('wallets');
    expect(defaultRosterWorkspace().columns[0]).toBe('fees');
  });

  it('reads fees from the fee ledgers, not hand statistics', () => {
    const sql = readFileSync(
      resolve(
        process.cwd(),
        'supabase/migrations/20261015092518_player_management_fees_come_from_the_fee_ledgers.sql'
      ),
      'utf8'
    );
    expect(sql).toContain('public.ca_club_member_fee_totals(p_club_id) lf');
    expect(sql).toContain('public.ca_club_rake_daily_user');
    expect(sql).toContain('AFTER INSERT ON public.accounting_tournament_fee_sources');
  });

  it('counts fees from the fixed week of 2026-10-12 onward, with no weekly reset', () => {
    const sql = readFileSync(
      resolve(
        process.cwd(),
        'supabase/migrations/20261015132358_player_management_fees_accumulate_from_the_week_of_october_t.sql'
      ),
      'utf8'
    );
    expect(sql).toContain("SELECT DATE '2026-10-12';");
    expect(sql).toContain('greatest(coalesce(p_from, public.fn_ca_fee_counting_start()),');
    expect(sql).toContain('d.day >= b.from_day');
    expect(sql).toContain('t.day >= b.from_day');
    const body = sql.slice(
      sql.indexOf('CREATE OR REPLACE FUNCTION public.ca_club_member_fee_totals')
    );
    expect(body.slice(0, body.indexOf('$function$;'))).not.toContain('fn_ca_fee_week_start');
    expect(sql).not.toMatch(/\b(DELETE|TRUNCATE|UPDATE)\b/);
  });

  it("counts fees from this week's Monday reset only, without touching the ledgers", () => {
    const sql = readFileSync(
      resolve(
        process.cwd(),
        'supabase/migrations/20261015121331_player_management_fees_count_from_this_weeks_reset.sql'
      ),
      'utf8'
    );
    expect(sql).toContain('public.fn_union_week_start(p_at)');
    expect(sql).toContain('d.day >= b.from_day');
    expect(sql).toContain('t.day >= b.from_day');
    expect(sql).not.toMatch(/\b(DELETE|TRUNCATE|UPDATE)\b/);
  });
});
