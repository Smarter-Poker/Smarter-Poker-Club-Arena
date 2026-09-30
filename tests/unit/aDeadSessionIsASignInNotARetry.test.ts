/**
 * A DEAD SESSION IS A SIGN-IN, NOT A RETRY (Diamond Phase 11, line 7).
 *
 * A session revoked elsewhere keeps a token that verifies, so only the doors
 * that ask fn_caller_session_is_live() refuse it, by name. These pin, against
 * the exact refusals production gives (read from the live definitions on
 * 2026-09-30), that the money screens:
 *   - recognise those refusals and nothing else (a lost answer is still a
 *     retry, a business refusal is still a refusal);
 *   - keep the one saved request, so the retry after signing in is the same
 *     request and can never be a second buy-in;
 *   - hand the page to lib/sessionRevoked, which decides whether to sign out.
 * The Send Diamonds form is pinned in tests/components/DiamondWalletTransfer.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { sliceBetween } from '../helpers/sourceWindow';

const probe = vi.hoisted(() => vi.fn(async () => 'revoked'));
vi.mock('../../src/lib/sessionRevoked', () => ({ handleEngineAuthRejection: probe }));
vi.mock('../../src/lib/supabase', () => ({ supabase: {} }));

import { askToSignInAgain, isDeadSessionRefusal } from '../../src/lib/deadSessionRefusal';
import {
  executeCashBuyIn,
  type CashBuyInAttempt,
  type CashBuyInRpc,
} from '../../src/services/CashBuyInRecovery';
import { refusalWords } from '../../src/services/DiamondStaffDeskService';
import { DIAMOND_ARENA_CLUB_ID } from '../../src/lib/constants';

/** What each door answers a dead session, verbatim from production. */
const BUY_IN = {
  code: '28000',
  message: 'SESSION_REVOKED: this session is signed out - sign in again',
};
const RECEIPT = { code: '28000', message: 'SESSION_REVOKED: sign in again to check your buy-in' };
const STAFF = { code: '28000', message: 'diamond_staff_session_required' };
const TRANSFER = { code: '42501', message: 'authentication_required' };

describe('a dead session is recognised by the name its door gives, and nothing else is', () => {
  it.each([BUY_IN, RECEIPT, STAFF, TRANSFER])('$message', (refusal) => {
    expect(isDeadSessionRefusal(refusal)).toBe(true);
  });

  it.each([
    [
      'a friend refusal at the transfer door',
      { code: '42501', message: 'accepted_friend_required' },
    ],
    [
      'another user at the buy-in door',
      { code: '42501', message: 'Cannot buy in for another user' },
    ],
    ['the closed arena', { code: 'P0001', message: 'diamond_cash_not_open' }],
    [
      'a statement timeout',
      { code: '57014', message: 'canceling statement due to statement timeout' },
    ],
    ['a lost network answer', new TypeError('Failed to fetch')],
    ['the confirmation deadline', new Error('Buy-In Confirmation Timed Out')],
    ['nothing', null],
    ['a bare string', 'SESSION_REVOKED'],
  ])('%s is not a dead session', (_label, error) => {
    expect(isDeadSessionRefusal(error)).toBe(false);
  });
});

describe('a buy-in refused for a dead session keeps its one request', () => {
  const attempt: CashBuyInAttempt = {
    version: 1,
    createdAt: 1,
    payload: {
      p_user_id: '10000000-0000-4000-8000-000000000001',
      p_table_id: '20000000-0000-4000-8000-000000000002',
      p_seat_number: 3,
      p_amount: 100,
      p_auto_rebuy: false,
      p_club_id: DIAMOND_ARENA_CLUB_ID,
      p_idempotency_key: '30000000-0000-4000-8000-000000000003',
    },
  };

  it('is an unknown outcome: one send, one receipt read, nothing retired, no loop', async () => {
    const calls: string[] = [];
    const revoked: CashBuyInRpc = async (name) => {
      calls.push(name);
      return { data: null, error: name === 'atomic_table_buyin' ? BUY_IN : RECEIPT };
    };
    const outcome = await executeCashBuyIn(attempt, false, revoked);
    expect(outcome.kind).toBe('unknown');
    expect(isDeadSessionRefusal((outcome as { error: unknown }).error)).toBe(true);
    expect(calls).toEqual(['atomic_table_buyin', 'fn_ca_cash_buyin_receipt']);
  });

  it('after signing in, the reviewed retry is the same request under the same key', async () => {
    const sent: Array<Record<string, unknown>> = [];
    const live: CashBuyInRpc = async (name, payload) => {
      if (name === 'fn_ca_cash_buyin_receipt')
        return { data: { status: 'unconfirmed' }, error: null };
      sent.push(payload);
      return { data: null, error: null };
    };
    expect(await executeCashBuyIn(attempt, true, live)).toEqual({
      kind: 'confirmed',
      fromReceipt: true,
    });
    expect(sent).toEqual([attempt.payload]);
  });

  it('the table says "sign in", keeps the request, and still says "retry" for a lost answer', () => {
    const table = readFileSync(resolve(__dirname, '../../src/pages/TablePage.tsx'), 'utf8');
    const branch = sliceBetween(table, "if (outcome.kind === 'unknown') {", 'return false;');
    expect(branch).toContain('isDeadSessionRefusal(outcome.error)');
    expect(branch).toContain("askToSignInAgain('money:cash_buyin')");
    expect(branch).toContain('Your Session Has Ended. Sign In Again To Finish This Buy-In.');
    expect(branch).toContain('Buy-In Not Yet Confirmed. Retrying Uses The Same Request.');
    expect(branch).not.toMatch(/cashBuyInJournal\.complete|setCashBuyInRecovery\(null\)/);
  });
});

describe('the page is handed to the one place that decides a sign-out', () => {
  it('asks lib/sessionRevoked, naming where the refusal came from', async () => {
    askToSignInAgain('money:test');
    await vi.waitFor(() => expect(probe).toHaveBeenCalledWith('money:test'));
  });

  it('the Staff Desk reads its doors’ dead-session refusal as "sign in again"', () => {
    expect(refusalWords('diamond_staff_session_required')).toBe(
      'Your Session Has Ended. Sign In Again.'
    );
  });
});
