/**
 * THE MAINTENANCE BREAK IS NAMED, NOT HIDDEN (2026-10-16).
 *
 * Dan, with a screenshot of Club JAQK's cashier: "I CAN'T SEND CHIPS FROM THE
 * MAIN BANK TO AN AGENT INSIDE OF CLUB JAQK". All three attempts landed inside
 * the :55 maintenance break, where Postgres refuses every chip write with
 * 55006 PLATFORM_FROZEN. fn_cashier_batch_transfer wrapped that as
 * "Transfer Failed" (error_code 55006), the page headed it "Need Outcome
 * Verification", and the toast sanitiser turned any raw freeze text into
 * "Something Went Wrong". Nothing told him to wait for :00.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { cashierBatchAcknowledgement } from '../../src/utils/cashierBatch';
import { safeErrorMessage, shouldSurfaceError } from '../../src/utils/safeErrorMessage';
import { PLATFORM_FROZEN_MESSAGE } from '../../src/utils/platformFrozen';

const RAW =
  'PLATFORM_FROZEN: the platform is on a scheduled maintenance break. UPDATE on club_members was refused; it will succeed when play resumes.';
const USER = '1ed711e3-33bb-40e5-ac06-7d3e67fe3484';

describe('the maintenance break is named, not hidden', () => {
  it('a batch item refused by the freeze says so', () => {
    const ack = cashierBatchAcknowledgement(
      [{ user_id: USER, success: false, error: 'Transfer Failed', error_code: '55006' }],
      USER
    );
    expect(ack.outcome).toBe('Refused');
    expect(ack.message).toBe(PLATFORM_FROZEN_MESSAGE);
  });

  it('any other refused item keeps its own words', () => {
    const ack = cashierBatchAcknowledgement(
      [{ user_id: USER, success: false, error: 'Insufficient Chips', error_code: 'P0001' }],
      USER
    );
    expect(ack.message).toBe('Insufficient Chips');
  });

  it('the shared sanitiser names the break for every raw shape', () => {
    expect(safeErrorMessage(RAW)).toBe(PLATFORM_FROZEN_MESSAGE);
    expect(safeErrorMessage({ code: '55006', message: RAW })).toBe(PLATFORM_FROZEN_MESSAGE);
    expect(safeErrorMessage(new Error(RAW), 'Send Failed')).toBe(PLATFORM_FROZEN_MESSAGE);
    expect(shouldSurfaceError(RAW)).toBe(true);
  });

  it('the friendly line survives a second pass through the toast sanitiser', () => {
    expect(safeErrorMessage(PLATFORM_FROZEN_MESSAGE)).toBe(PLATFORM_FROZEN_MESSAGE);
    expect(shouldSurfaceError(PLATFORM_FROZEN_MESSAGE)).toBe(true);
  });

  it('the cashier holds Confirm and Claim Back while the platform is frozen', () => {
    const page = readFileSync(join(__dirname, '../../src/pages/CashierTradePage.tsx'), 'utf8');
    expect(page).toContain('useMaintenanceBreak()');
    expect(page.match(/!isOnline \|\|\s*breakFrozen \|\|/g)?.length).toBeGreaterThanOrEqual(2);
    // A batch refused by the break toasts the break itself.
    expect(page).toContain('toast?.error?.(PLATFORM_FROZEN_MESSAGE)');
  });
});
