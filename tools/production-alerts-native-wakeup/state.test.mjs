import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { openState } from './state.mjs';
import { createIntake } from './core.mjs';
const parent = process.env.RUNNER_TEMP || process.env.TMPDIR;
if (!parent) throw new Error('owned native test workspace required');
const A = '00000000-0000-0000-0000-000000000001';
const B = '00000000-0000-0000-0000-000000000002';
const submitting = { operationId: B, ids: [A], phase: 'submitting' };

test('a second service cannot overwrite its live owner; close permits explicit restart', async () => {
  const dir = await mkdtemp(join(parent, 'native-state-'));
  let first, second;
  try {
    first = await openState(dir);
    await first.save(submitting);
    await assert.rejects(openState(dir), /owned or unavailable/);
    assert.deepEqual(await first.load(), submitting);
    first.close();
    second = await openState(dir);
    assert.deepEqual(await second.load(), submitting);
    await second.save(null);
    assert.equal(await second.load(), null);
  } finally {
    first?.close();
    second?.close();
    await rm(dir, { recursive: true });
  }
});

test(
  'actual SIGKILL releases ownership, preserves committed uncertainty and never duplicates the native queue',
  { timeout: 15000 },
  async () => {
    const dir = await mkdtemp(join(parent, 'native-crash-'));
    let child, store;
    try {
      const script = `import {openState} from ${JSON.stringify(new URL('./state.mjs', import.meta.url).href)}; const state=await openState(process.argv[1]);await state.save(${JSON.stringify(submitting)});process.stdout.write('committed\\n');process.stdin.resume();`;
      child = spawn(process.execPath, ['--input-type=module', '-e', script, dir], {
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      const ready = await Promise.race([
        once(child.stdout, 'data'),
        once(child, 'exit').then(() => {
          throw new Error('state owner failed before commit');
        }),
      ]);
      assert.match(String(ready[0]), /committed/);
      const exited = once(child, 'exit');
      child.kill('SIGKILL');
      await exited;
      store = await openState(dir);
      assert.deepEqual(await store.load(), submitting);
      let queued = 0,
        acknowledged = false;
      const intake = createIntake({
        load: store.load,
        save: store.save,
        pending: async () => ({
          version: 1,
          active_acknowledged: acknowledged,
          pending: acknowledged ? [] : [A],
        }),
        queue: async () => {
          queued++;
          throw new Error('duplicate queue');
        },
      });
      await intake.event();
      assert.equal(queued, 0);
      acknowledged = true;
      await intake.event();
      assert.equal(queued, 0);
      assert.equal(await store.load(), null);
    } finally {
      if (child?.exitCode === null && child?.signalCode === null) child.kill('SIGKILL');
      store?.close();
      await rm(dir, { recursive: true });
    }
  }
);

test('corrupt persisted state is refused without replacing it with a successful empty state', async () => {
  const dir = await mkdtemp(join(parent, 'native-corrupt-'));
  try {
    const path = join(dir, 'intake.sqlite');
    await writeFile(path, 'not a database');
    await assert.rejects(openState(dir), /unavailable/);
    assert.equal(await readFile(path, 'utf8'), 'not a database');
  } finally {
    await rm(dir, { recursive: true });
  }
});
