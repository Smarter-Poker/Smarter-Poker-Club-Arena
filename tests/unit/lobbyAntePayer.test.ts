import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { cashEntry, cashRuleMedallions } from '../../src/components/lobby/lobbyEntries';

const rule = (row: Record<string, unknown>) =>
  cashRuleMedallions({ ante_enabled: true, ante: 5, ...row }).find((item) => item.key === 'ante');

describe('the lobby tells players who actually pays the ante', () => {
  it('names the single big-blind payer', () => {
    expect(rule({ big_blind_ante_enabled: true })).toMatchObject({
      label: 'BIG BLIND ANTE',
      detail: '5',
      tip: 'The player in the big blind antes 5 a hand',
    });
  });

  it.each([false, null])('keeps the per-player rule for a canonical %s mode', (mode) => {
    expect(rule({ big_blind_ante_enabled: mode })?.tip).toBe('Every player antes 5 a hand');
  });

  it('does not invent a payer while a cached or narrow row lacks the mode', () => {
    expect(rule({})?.tip).toBe('An ante of 5 is in play');
  });

  it('does not use legacy settings to override a canonical per-player ante', () => {
    expect(
      rule({ big_blind_ante_enabled: false, settings: { big_blind_ante_enabled: true } })?.tip
    ).toBe('Every player antes 5 a hand');
  });

  it('does not infer a big-blind payer from legacy settings when the column is missing', () => {
    expect(rule({ settings: { big_blind_ante_enabled: true } })?.tip).toBe(
      'An ante of 5 is in play'
    );
  });

  it('keeps the ante master switch authoritative over the mode and old settings', () => {
    expect(
      rule({
        ante_enabled: false,
        big_blind_ante_enabled: true,
        settings: { ante_enabled: true },
      })
    ).toBeUndefined();
  });

  it('names the big-blind payer without inventing an unavailable amount', () => {
    expect(rule({ ante: 0, big_blind_ante_enabled: true })).toMatchObject({
      label: 'BIG BLIND ANTE',
      detail: undefined,
      tip: 'The player in the big blind pays the ante',
    });
  });

  it('carries the real column through the full game entry used by the details panel', () => {
    const row = {
      id: 'main',
      name: 'NLH 2/5 Madness',
      game_variant: 'nlh',
      small_blind: 2,
      big_blind: 5,
      min_buy_in: 500,
      max_buy_in: 1000,
      current_players: 2,
      max_players: 6,
      status: 'running',
      lifecycle: 'live',
      cluster_id: 'game',
      cluster_template: 'madness',
      ante_enabled: true,
      ante: 5,
      big_blind_ante_enabled: true,
    };
    expect(cashEntry(row).rules.find((item) => item.key === 'ante')?.tip).toBe(
      'The player in the big blind antes 5 a hand'
    );
  });

  it('selects the actual ante-mode column in the club page table read', () => {
    const page = readFileSync('src/pages/ClubHomePage.tsx', 'utf8');
    // This is the table query itself, not the row type or a comment naming the column.
    const match = /\.from\('tables'\)\s*\.select\(\s*'([^']*bomb_pot_ante_multiplier[^']*)'/.exec(
      page
    );
    expect(match, 'the authoritative table select must remain identifiable').not.toBeNull();
    expect(match![1].split(',').map((column) => column.trim())).toContain('big_blind_ante_enabled');
  });
});
