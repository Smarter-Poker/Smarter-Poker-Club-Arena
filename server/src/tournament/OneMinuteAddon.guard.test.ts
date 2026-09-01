import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const manager = readFileSync(
  join(process.cwd(), 'src/tournament/TournamentManagerBase.ts'),
  'utf8'
);

describe('the MTT add-on is one persisted minute', () => {
  it('announces the offer, price, chips, zero fee, and deadline', () => {
    expect(manager).toContain("message: 'The Add-On Period Has Begun'");
    expect(manager).toContain('addOnFee: 0');
    expect(manager).toContain('durationSeconds: 60');
    expect(manager).toContain('endsAt: addonPeriodEndsAt');
  });

  it('persists and rearms the same deadline across a restart', () => {
    expect(manager).toContain('addon_period_started_at');
    expect(manager).toContain('addon_period_ends_at');
    expect(manager).toContain('this.scheduleAddOnPeriodEnd(tournament.addon_period_ends_at)');
  });

  it('finalizes the prize pool from the timer', () => {
    expect(manager).toContain('this.scheduleAddOnPeriodEnd(addonPeriodEndsAt)');
    expect(manager).toContain('this.finalizeAfterAddOn().catch');
  });
});
