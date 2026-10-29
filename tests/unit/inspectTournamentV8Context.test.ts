import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { expect, it } from 'vitest';
const script = resolve(__dirname, '../../scripts/ci/inspect-tournament-refill.py');
const stamp = '2026-10-28T00:45:32.123Z ';
const fatal =
  stamp +
  'FATAL ERROR: Ineffective mark-compacts near heap limit Allocation failed - JavaScript heap out of memory';
const gc =
  stamp +
  '[27:0xabc123] 9876 ms: Mark-Compact (reduce) 2011.4 (2050.5) -> 2001.2 (2040.3) MB, 42.5 / 0.0 ms';
function read(lines: string[], stream = false) {
  const code = stream
    ? `import json,runpy,sys; m=runpy.run_path(sys.argv[1]); print(json.dumps(m['process_history']([sys.executable,'-c','import sys;sys.stdout.write('+repr(json.loads(sys.stdin.read()))+')'])['signals']))`
    : `import json,runpy,sys; m=runpy.run_path(sys.argv[1]); print(json.dumps(m['process_signals'](json.loads(sys.stdin.read()))))`;
  const r = spawnSync('python3', ['-c', code, script], {
    input: JSON.stringify(lines.join('\n')),
    encoding: 'utf8',
    timeout: 5000,
  });
  expect(r.status, r.stderr).toBe(0);
  return JSON.parse(r.stdout);
}
it('retains independently expected GC numbers and native hints without claiming heap limit or isolate ownership', () => {
  for (const stream of [false, true]) {
    const value = read(
      [gc, fatal, stamp + ' 12: 0xabc node::worker::Worker::Run() [node]'],
      stream
    );
    const c = value.v8_ineffective_gc.crashContexts[0];
    expect(c.gc).toEqual([
      { pid: 27, beforeMB: 2011.4, beforeTotalMB: 2050.5, afterMB: 2001.2, afterTotalMB: 2040.3 },
    ]);
    expect(c.workerNativeFrame).toBe(true);
    expect(c.mainNativeFrame).toBe(false);
    expect(c.heapLimitMB).toBeNull();
    expect(c.isolateOwner).toBe('unknown');
    expect(c.allocationOwner).toBe('unknown');
    expect(JSON.stringify(value)).not.toContain('0xabc');
  }
});
it('refuses malformed, stale and oversized context and does not export arbitrary strings', () => {
  const v = read([
    gc.replace('00:45:32', '00:44:32'),
    gc.replace('2011.4', '999999999'),
    stamp + 'private-secret node::worker::Worker::Run()',
    'x'.repeat(5000),
    fatal,
  ]);
  expect(v.v8_ineffective_gc.crashContexts[0].gc).toEqual([]);
  expect(v.v8_ineffective_gc.crashContexts[0].workerNativeFrame).toBe(false);
  expect(JSON.stringify(v)).not.toContain('private-secret');
});
it('caps crash contexts and preserves absent context as unknown', () => {
  const v = read(Array(20).fill(fatal));
  expect(v.v8_ineffective_gc.count).toBe(20);
  expect(v.v8_ineffective_gc.crashContexts).toHaveLength(8);
  expect(v.v8_ineffective_gc.crashContexts[0].gc).toEqual([]);
  expect(read([gc])).toEqual({});
});
it('treats mixed native frames as ambiguous and discards GC beyond the nearby line bound', () => {
  const value = read([
    gc,
    fatal,
    stamp + ' 10: 0xdef node::NodeMainInstance::Run() [node]',
    stamp + ' 11: 0xabc node::worker::Worker::Run() [node]',
  ]);
  const c = value.v8_ineffective_gc.crashContexts[0];
  expect(c.mainNativeFrame).toBe(true);
  expect(c.workerNativeFrame).toBe(true);
  expect(c.isolateOwner).toBe('unknown');
  expect(c.association).toBe('nearby_only');
  const distant = read([gc, ...Array(9).fill(stamp + 'unrelated'), fatal], true);
  expect(distant.v8_ineffective_gc.crashContexts[0].gc).toEqual([]);
});
it('caps contexts across both fatal categories in streamed history', () => {
  const logs = Array.from({ length: 20 }, (_, i) =>
    i % 2 ? fatal : fatal.replace('Ineffective mark-compacts near heap limit', 'Reached heap limit')
  );
  const v = read(logs, true);
  expect(
    Object.values(v).reduce(
      (sum: number, entry: any) => sum + (entry.crashContexts?.length ?? 0),
      0
    )
  ).toBe(8);
});
