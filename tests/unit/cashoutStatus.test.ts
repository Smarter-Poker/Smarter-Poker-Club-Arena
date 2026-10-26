import { describe, expect, it } from 'vitest';
import { cashoutStatusLabel, waitingFor } from '../../src/utils/cashoutStatus';

describe('cash-out status in the Transaction History', () => {
  it('names each request status the way a member reads it', () => {
    expect(cashoutStatusLabel('pending')).toBe('Waiting');
    expect(cashoutStatusLabel('approved')).toBe('Accepted');
    expect(cashoutStatusLabel('rejected')).toBe('Cancelled');
    expect(cashoutStatusLabel('expired')).toBe('Expired');
    expect(cashoutStatusLabel(null)).toBeNull();
    expect(cashoutStatusLabel('something_new')).toBeNull();
  });

  it('says how long a request has waited, in whole minutes, hours and days', () => {
    const now = Date.parse('2026-10-25T12:00:00Z');
    expect(waitingFor('2026-10-25T11:59:40Z', now)).toBe('Waiting Under 1m');
    expect(waitingFor('2026-10-25T11:35:00Z', now)).toBe('Waiting 25m');
    expect(waitingFor('2026-10-25T09:55:00Z', now)).toBe('Waiting 2h 5m');
    expect(waitingFor('2026-10-23T09:00:00Z', now)).toBe('Waiting 2d 3h');
    expect(waitingFor(null, now)).toBe('Waiting');
  });
});
