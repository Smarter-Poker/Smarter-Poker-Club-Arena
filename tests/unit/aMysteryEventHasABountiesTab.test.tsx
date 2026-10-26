/**
 * Dan 2026-10-25: "CREATE ANOTHER TAB, FOR 'BOUNTIES' FOR ALL MYSTERY BOUNTY
 * TOURNAMENTS NEXT TO REWARDS, INSTEAD OF PLACING IT AT THE BOTTOM OF REWARDS,
 * WHERE ALL THE BOUNTY PRIZES AND AWARDS ARE LOCATED."
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { normaliseTabId, tabsFor } from '../../src/components/tournament/details/types';

const DIR = resolve(__dirname, '../../src/components/tournament/details');
const read = (f: string) => readFileSync(resolve(DIR, f), 'utf8');

describe('a mystery bounty event has a Bounties tab', () => {
  it('sits immediately after Rewards for a mystery event', () => {
    const ids = tabsFor(true).map((t) => t.id);
    expect(ids.indexOf('bounties')).toBe(ids.indexOf('rewards') + 1);
    expect(tabsFor(true).find((t) => t.id === 'bounties')?.label).toBe('Bounties');
  });

  it('does not exist for any other event', () => {
    expect(tabsFor(false).map((t) => t.id)).not.toContain('bounties');
  });

  it('opens from a link, and the old mystery link lands on it', () => {
    expect(normaliseTabId('bounties')).toBe('bounties');
    expect(normaliseTabId('mystery')).toBe('bounties');
  });

  it('holds the mystery ladder, and Rewards no longer renders it', () => {
    expect(read('BountiesTab.tsx')).toContain('<MysteryBountyPanel');
    expect(read('RewardsTab.tsx')).not.toContain('<MysteryBountyPanel');
  });
});
