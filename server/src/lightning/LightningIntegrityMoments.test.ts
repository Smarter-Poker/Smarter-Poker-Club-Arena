import { describe, expect, it } from 'vitest';
import { LightningIntegrityWindow } from './LightningIntegrity.js';

describe('Lightning correlation keeps the evidence needed to pool windows', () => {
  it('reports measured paired hands and additive second moments, including short windows', () => {
    const w = new LightningIntegrityWindow();
    for (let i = 1; i <= 2; i++) {
      w.handDealt(`h${i}`, ['a', 'b']);
      w.decision(`h${i}`, 'a', i * 1000);
      w.decision(`h${i}`, 'b', i * 2000);
      w.handEnded(`h${i}`);
    }
    const p = w.signals().pairs[0] as any;
    expect(p.latency_corr).toBeNull();
    expect([p.corr_n, p.corr_sx, p.corr_sy, p.corr_sxx, p.corr_syy, p.corr_sxy]).toEqual([
      2, 3, 6, 5, 20, 10,
    ]);
  });
  it('counts a hand spanning the window boundary once when it finishes', () => {
    const w = new LightningIntegrityWindow();
    w.handDealt('spanning', ['a', 'b']);
    w.decision('spanning', 'a', 1000);
    w.reset();
    w.decision('spanning', 'b', 2000);
    w.handEnded('spanning');
    const p = w.signals().pairs[0] as any;
    expect(p?.corr_n).toBe(1);
    w.reset();
    w.handEnded('spanning');
    expect(w.signals().pairs).toEqual([]);
  });
});
