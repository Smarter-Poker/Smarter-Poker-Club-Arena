import { describe, it, expect } from 'vitest';
import { TableRouter } from './TableRouter.js';

/** Deterministic pseudo-table-ids (UUID-like) for reproducible distribution tests. */
function makeTableIds(n: number): string[] {
  const ids: string[] = [];
  for (let i = 0; i < n; i++) {
    // stable, varied keys
    ids.push(`table-${i}-${(i * 2654435761) % 1e9}`);
  }
  return ids;
}

describe('TableRouter - basics', () => {
  it('returns null when there are no workers', () => {
    const r = new TableRouter();
    expect(r.route('table-1')).toBeNull();
    expect(r.size).toBe(0);
  });

  it('routes every table to a registered worker', () => {
    const r = new TableRouter(['w1', 'w2', 'w3']);
    for (const t of makeTableIds(500)) {
      expect(['w1', 'w2', 'w3']).toContain(r.route(t));
    }
  });

  it('is deterministic across instances', () => {
    const a = new TableRouter(['w1', 'w2', 'w3', 'w4']);
    const b = new TableRouter(['w4', 'w2', 'w1', 'w3']); // different insert order
    for (const t of makeTableIds(1000)) {
      expect(a.route(t)).toBe(b.route(t));
    }
  });

  it('add/remove/has/workerIds behave', () => {
    const r = new TableRouter(['w1']);
    r.addWorker('w2');
    r.addWorker({ id: 'w3', weight: 2 });
    expect(r.hasWorker('w2')).toBe(true);
    expect(r.workerIds()).toEqual(['w1', 'w2', 'w3']);
    expect(r.removeWorker('w2')).toBe(true);
    expect(r.removeWorker('nope')).toBe(false);
    expect(r.workerIds()).toEqual(['w1', 'w3']);
  });

  it('rejects non-positive weights', () => {
    const r = new TableRouter();
    expect(() => r.addWorker({ id: 'x', weight: 0 })).toThrow();
    expect(() => r.addWorker({ id: 'y', weight: -1 })).toThrow();
  });
});

describe('TableRouter - distribution', () => {
  it('spreads tables roughly evenly across equal-weight workers', () => {
    const workers = ['w1', 'w2', 'w3', 'w4'];
    const r = new TableRouter(workers);
    const tables = makeTableIds(20_000);
    const counts = new Map<string, number>(workers.map((w) => [w, 0]));
    for (const t of tables) counts.set(r.route(t)!, counts.get(r.route(t)!)! + 1);

    const ideal = tables.length / workers.length;
    for (const w of workers) {
      const c = counts.get(w)!;
      // within 10% of ideal — HRW is well-balanced at this sample size
      expect(Math.abs(c - ideal) / ideal).toBeLessThan(0.1);
    }
  });

  it('honors weights (weight 3 gets ~3x weight 1)', () => {
    const r = new TableRouter([
      { id: 'big', weight: 3 },
      { id: 'small', weight: 1 },
    ]);
    const tables = makeTableIds(20_000);
    let big = 0;
    let small = 0;
    for (const t of tables)
      if (r.route(t) === 'big') big++;
      else small++;
    const ratio = big / small;
    expect(ratio).toBeGreaterThan(2.5);
    expect(ratio).toBeLessThan(3.5);
  });
});

describe('TableRouter - minimal reassignment (stability)', () => {
  const tables = makeTableIds(20_000);

  it('adding a worker only moves keys ONTO the new worker (~1/(N+1))', () => {
    const before = new TableRouter(['w1', 'w2', 'w3', 'w4']);
    const after = new TableRouter(['w1', 'w2', 'w3', 'w4', 'w5']);

    let moved = 0;
    for (const t of tables) {
      const from = before.route(t);
      const to = after.route(t);
      if (from !== to) {
        moved++;
        // Rendezvous guarantee: a key only ever moves to the NEW worker.
        expect(to).toBe('w5');
      }
    }
    const frac = moved / tables.length;
    // Expected ~1/5 = 0.2; assert it's in a tight, correct band.
    expect(frac).toBeGreaterThan(0.15);
    expect(frac).toBeLessThan(0.25);
  });

  it('removing a worker only moves keys that lived on it (never reshuffles others)', () => {
    const before = new TableRouter(['w1', 'w2', 'w3', 'w4']);
    const after = new TableRouter(['w1', 'w2', 'w4']); // removed w3

    let movedFromW3 = 0;
    for (const t of tables) {
      const from = before.route(t);
      const to = after.route(t);
      if (from === 'w3') {
        // its keys must move to a survivor
        expect(['w1', 'w2', 'w4']).toContain(to);
        movedFromW3++;
      } else {
        // keys NOT on the removed worker must not move at all
        expect(to).toBe(from);
      }
    }
    expect(movedFromW3).toBeGreaterThan(0);
  });

  it('planReassignment reports the same moves', () => {
    const before = new TableRouter(['w1', 'w2', 'w3']);
    const after = new TableRouter(['w1', 'w2', 'w3', 'w4']);
    const moves = before.planReassignment(tables, after);
    for (const m of moves) {
      expect(m.to).toBe('w4');
      expect(m.from).not.toBe('w4');
    }
    // cross-check against manual diff
    let manual = 0;
    for (const t of tables) if (before.route(t) !== after.route(t)) manual++;
    expect(moves.length).toBe(manual);
  });
});
