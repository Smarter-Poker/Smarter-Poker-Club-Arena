/**
 * LAW: THE FROZEN-TABLE PAGE WAITS FOR THE REAPER (2026-10-15)
 *
 * PokerTablesFrozen is a critical owner page. Its description says that if
 * it fires, the engine's own recovery did not. The arithmetic has to make
 * that true:
 *
 *   - a table enters poker_stalled_tables at 120s without progress
 *     (GameServer: `t.msSinceProgress > 120_000`);
 *   - the zombie reaper condemns and rebuilds it at 180s
 *     (GameServer: `zombieProgressAge(engine) > 180_000`);
 *   - the alert fires at 120s + its `for:`.
 *
 * With `for: 1m` it fired at 180s, the reaper's own moment. On 2026-10-15
 * six episodes paged between 04:29 and 06:38 UTC, each 10 to 24 seconds AFTER
 * its tournament_table_zombie rebuild, each resolved within 30 seconds; the
 * measured rebuild to first dealt hand was 26 to 36 seconds.
 *
 * So the page must fire no earlier than the reaper plus a full minute of
 * rebuild and scrape margin, and no later than five minutes, so a table the
 * chain did not recover still pages promptly.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

const ROOT = join(__dirname, '..');
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');

function durationSeconds(text: string): number {
  const m = /^(\d+)(s|m|h)$/.exec(text.trim());
  if (!m) throw new Error('unparsed duration ' + text);
  return Number(m[1]) * (m[2] === 'h' ? 3600 : m[2] === 'm' ? 60 : 1);
}

describe('the frozen-table page waits for the reaper', () => {
  const rules = read('infra/monitoring/engine-freeze-rules.yml');
  const gameServer = read('server/src/GameServer.ts');

  const block = /- alert: PokerTablesFrozen\n\s+expr: poker_stalled_tables > 0\n\s+for: (\S+)/.exec(
    rules
  );
  const stall = /t\.msSinceProgress > (\d+)_000\)/.exec(gameServer);
  const reaper = /zombieProgressAge\(engine\) > (\d+)_000\)/.exec(gameServer);

  it('reads the rule, the stall line and the reaper line', () => {
    expect(block, 'PokerTablesFrozen rule').not.toBeNull();
    expect(stall, 'stalled-table threshold in GameServer').not.toBeNull();
    expect(reaper, 'zombie reaper threshold in GameServer').not.toBeNull();
  });

  it('fires at least a minute after the reaper has rebuilt the table', () => {
    const firesAt = Number(stall![1]) + durationSeconds(block![1]);
    const reaperAt = Number(reaper![1]);
    // 36s measured worst rebuild to first dealt hand, rounded up to a minute.
    expect(firesAt).toBeGreaterThanOrEqual(reaperAt + 60);
  });

  it('still pages within five minutes for a table the chain did not recover', () => {
    const firesAt = Number(stall![1]) + durationSeconds(block![1]);
    expect(firesAt).toBeLessThanOrEqual(300);
  });

  it('the runbook states the same rule', () => {
    expect(read('docs/runbooks/tables-frozen.md')).toContain(
      '`poker_stalled_tables > 0` for ' + block![1]
    );
  });
});
