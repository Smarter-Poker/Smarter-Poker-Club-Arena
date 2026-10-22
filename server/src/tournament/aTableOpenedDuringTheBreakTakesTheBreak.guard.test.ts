import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * A TABLE OPENED DURING THE :55 BREAK TAKES THE BREAK (Dan 2026-10-21:
 * "EVERY MTT TOURNAMENT NEEDS TO HAVE THE SYNCHRONIZED BREAK AT THE :55 OF
 * EVERY HOUR. ALL TOURNAMENTS TAKE A 5 MIN BREAK EVERY HOUR.").
 *
 * pauseForBreak() holds the dealers registered at :55. A dealer created after
 * that instant only takes the break if prepareManagedTableEngineForPlay() arms
 * it before it starts. The dynamic-expansion path (late registration and
 * rebalancing opening a capacity table) skipped that step, so 11 tables
 * opened inside the break window across 2026-10-20/22 dealt straight through
 * it (Nightly 10K table 2c4ebadf: opened 00:55:27, six hands before 01:00).
 *
 * Law: in both manager files, every dealer that is started by a path that
 * creates it is prepared for play between its creation and its start.
 */
const here = dirname(fileURLToPath(import.meta.url));
const files = ['TournamentManager.ts', 'TournamentManagerBase.ts'].map((name) => ({
  name,
  source: readFileSync(join(here, name), 'utf8'),
}));

function createThenStartWindows(source: string): string[] {
  const windows: string[] = [];
  let from = 0;
  for (;;) {
    const create = source.indexOf('this.createManagedTableEngine(', from);
    if (create === -1) break;
    from = create + 1;
    const nextCreate = source.indexOf('this.createManagedTableEngine(', create + 1);
    const start = source.indexOf('this.startManagedTableEngine(', create);
    // A creation site that does not start its own dealer (table construction
    // for start(), adoption) is launched by a later loop; only windows where
    // this same block starts the dealer are this law's business.
    if (start === -1 || (nextCreate !== -1 && nextCreate < start)) continue;
    const window = source.slice(create, start);
    if (window.length > 2_500) continue;
    windows.push(window);
  }
  return windows;
}

describe('a table opened during the :55 break takes the break', () => {
  it('the dynamic-expansion dealer is prepared for play before it is admitted and started', () => {
    const manager = files[0].source;
    const site = manager.indexOf("'Tournament.dynamic_expansion_table_engine_error'");
    expect(site).toBeGreaterThan(-1);
    const block = manager.slice(manager.lastIndexOf('this.createManagedTableEngine(', site), site);
    const prepare = block.indexOf('this.prepareManagedTableEngineForPlay(engine)');
    const admit = block.indexOf('this.admitManagedTableEngine(tableId, engine)');
    expect(prepare).toBeGreaterThan(-1);
    expect(admit).toBeGreaterThan(prepare);
  });

  it('every create-then-start dealer path in the manager prepares the dealer first', () => {
    let checked = 0;
    for (const { name, source } of files) {
      for (const window of createThenStartWindows(source)) {
        checked++;
        expect(window, `${name}: a dealer is started without the break hold`).toContain(
          'this.prepareManagedTableEngineForPlay('
        );
      }
    }
    expect(checked).toBeGreaterThanOrEqual(3);
  });

  it('the preparation still arms the synchronized break as an absolute, explicit-resume hold', () => {
    const base = files[1].source;
    const at = base.indexOf(
      'protected prepareManagedTableEngineForPlay(engine: ServerTableEngine)'
    );
    expect(at).toBeGreaterThan(-1);
    const body = base.slice(at, base.indexOf('\n  }\n', at));
    const onBreak = body.indexOf('if (this.onBreak)');
    expect(onBreak).toBeGreaterThan(-1);
    expect(body.slice(onBreak)).toMatch(/beforeNextHand: true,\s*untilResumed: true/);
  });
});
