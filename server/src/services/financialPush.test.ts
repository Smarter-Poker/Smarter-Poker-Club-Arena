/**
 * FINANCIAL_UPDATE HAS A PRODUCER (final sweep 2, 2026-09-08). The wallet page
 * and the cashier listened for this message since 2026-05-18; nothing ever
 * sent it. These pin the producer: reads the balance the mutation left and
 * pushes it to the player's sockets, and never throws into the money path.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const sendToUser = vi.fn();
const rows: Record<string, unknown> = {};
vi.mock('../hub/ChannelHub.js', () => ({
  channelHub: { sendToUser: (...a: unknown[]) => sendToUser(...a) },
}));
vi.mock('./errorReporter.js', () => ({ reportError: vi.fn() }));
vi.mock('./supabase/client.js', () => ({
  supabase: {
    from: (table: string) => {
      const b: Record<string, unknown> = {};
      for (const m of ['select', 'eq']) b[m] = () => b;
      b.maybeSingle = async () => ({ data: rows[table] ?? null, error: null });
      return b;
    },
  },
}));

import { pushFinancialUpdate, pushFinancialUpdateNow } from './financialPush.js';
import { reportError } from './errorReporter.js';

beforeEach(() => {
  sendToUser.mockReset();
  for (const k of Object.keys(rows)) delete rows[k];
});

describe('pushFinancialUpdateNow', () => {
  it('resolves the club from the table, reads the balance, and pushes it', async () => {
    rows.tables = { club_id: 'club-1' };
    rows.club_members = { chip_balance: '1234.50' };
    const sent = await pushFinancialUpdateNow('u1', {
      tableId: 't1',
      ledgerEntry: { direction: 'in', amount: 40, kind: 'cashout' },
    });
    expect(sent).toBe(true);
    expect(sendToUser).toHaveBeenCalledWith('u1', {
      type: 'FINANCIAL_UPDATE',
      userId: 'u1',
      walletType: 'PLAYER',
      available: 1234.5,
      total: 1234.5,
      ledgerEntry: { direction: 'in', amount: 40, kind: 'cashout' },
    });
  });

  it('pushes nothing it cannot read - no club, no member row, no number', async () => {
    expect(await pushFinancialUpdateNow('u1', { tableId: 't1' })).toBe(false);
    rows.tables = { club_id: 'club-1' };
    expect(await pushFinancialUpdateNow('u1', { tableId: 't1' })).toBe(false);
    rows.club_members = { chip_balance: 'NaN' };
    expect(await pushFinancialUpdateNow('u1', { clubId: 'club-1' })).toBe(false);
    expect(sendToUser).not.toHaveBeenCalled();
  });

  it('the fire-and-forget wrapper reports and never throws', async () => {
    rows.tables = { club_id: 'club-1' };
    rows.club_members = { chip_balance: 5 };
    sendToUser.mockImplementation(() => {
      throw new Error('socket gone');
    });
    expect(() => pushFinancialUpdate('u1', { tableId: 't1' })).not.toThrow();
    await new Promise((r) => setTimeout(r, 0));
    expect(reportError).toHaveBeenCalledWith(expect.any(Error), 'financialPush.push_failed', {
      userId: 'u1',
      tableId: 't1',
    });
  });
});
