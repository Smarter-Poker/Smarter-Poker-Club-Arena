/**
 * A HAND TORN DOWN MID-DEAL IS NOT DEALT (2026-09-06).
 *
 * `dealHand` builds the HandController, awaits ONE RPC (the VIP time-bank
 * allowance), then registers its listener with `this.handController!` and
 * starts the hand. `stop()` and `killForRestart()` set `handController` to
 * null, and between 09:30 and 12:30 CDT on 2026-09-06 they did so four times
 * inside that await - every one a table the cluster controller had just
 * broken - and the `!` dereferenced null:
 *
 *     TypeError: Cannot read properties of null (reading 'onEvent')
 *
 * The guard is pinned by position: after the await, before the listener.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(join(here, 'ServerTableEngineDealing.ts'), 'utf8');

describe('dealHand re-reads the controller after its one await', () => {
  const construct = SRC.indexOf(
    'this.handController = new HandController(config, hcPlayers, dealerSeat);'
  );
  const awaitAt = SRC.indexOf('const tbExtras = await this.fetchTimeBankExtras(', construct);
  const guard = SRC.indexOf('if (!this.handController || !this.running) {', awaitAt);
  const listener = SRC.indexOf('unsub = this.handController!.onEvent(', awaitAt);
  const start = SRC.indexOf('this.handController!.start();', listener);

  it('the guard sits between the await and the listener', () => {
    expect(construct).toBeGreaterThan(0);
    expect(awaitAt).toBeGreaterThan(construct);
    expect(guard).toBeGreaterThan(awaitAt);
    expect(listener).toBeGreaterThan(guard);
    expect(start).toBeGreaterThan(listener);
  });

  it('there is no other await between constructing the controller and starting the hand', () => {
    const between = SRC.slice(construct, start)
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/.*$/gm, '');
    const awaits = between.match(/\bawait\b/g) ?? [];
    expect(awaits).toHaveLength(1);
  });

  it('the guard returns without dealing and says why', () => {
    const body = SRC.slice(guard, listener);
    expect(body).toContain('not dealt - the engine was');
    expect(body).toMatch(/\n\s*return;\n/);
  });
});
