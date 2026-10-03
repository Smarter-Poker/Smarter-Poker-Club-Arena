import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const read = (path: string) => readFileSync(resolve(__dirname, '..', path), 'utf8');

describe('Stats presentation truth', () => {
  it('labels hand-derived session results as cumulative P/L, never authoritative bankroll', () => {
    const source = read('src/components/stats/BankrollTracker.tsx');
    expect(source).toContain('Cumulative Session P/L');
    expect(source).not.toContain('>Bankroll Tracker<');
    expect(source).not.toContain('Bankroll Progression');
    expect(source).not.toContain('name="Bankroll"');
  });

  it('describes the field cohort without claiming it is every player in one club', () => {
    const source = read('src/components/stats/BenchmarkPanel.tsx');
    expect(source).toContain('Every Qualifying Player In The Field');
    expect(source).not.toContain('Every Player In The Club');
  });

  it('uses compact chips, one-decimal BB rates, and only approved console inks in Rake', () => {
    const source = read('src/pages/stats/RakeTab.tsx');
    expect(source).toContain('compactChips(rakeStats.rake_paid)');
    expect(source).toContain('compactChips(rakeStats.rake_per_100)');
    expect(source).toContain('compactChips(rakeStats.avg_rake_per_raked_hand)');
    expect(source).toContain('rakeStats.rake_in_bb.toFixed(1)');
    for (const retired of ['#f59e0b', '#00d4ff', '#8b5cf6', '#22c55e', '#06b6d4', '#4169E1']) {
      expect(source).not.toContain(retired);
    }
    for (const ink of ['#ffd700', '#45adff', '#e4e7ec', '#c8ffd2']) {
      expect(source).toContain(ink);
    }
  });
});
