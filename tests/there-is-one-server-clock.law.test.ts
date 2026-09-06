/**
 * LAW: THERE IS ONE SERVER CLOCK (Realtime Phase 5, 2026-09-06)
 *
 * For one day this app had TWO functions called `serverNow()`, in two modules,
 * with OPPOSITE SIGNS:
 *
 *   utils/serverClock (2026-08-18)  offset = Date.now() - serverTime
 *                                   serverNow() = Date.now() - offset
 *   lib/serverClock   (2026-09-05)  offset = serverTime - Date.now()
 *                                   serverNow() = Date.now() + offset
 *
 * Same name, same meaning, inverted arithmetic. Whichever module a file
 * imported decided which clock it got; both compiled and both returned a
 * plausible number, so one wrong import path would have turned a three-second
 * FAST phone into a three-second SLOW one - doubling the error on the turn
 * ring rather than removing it - and nothing anywhere would have said so.
 *
 * They also had different quality, and the wrong one had the better feed. The
 * latency-corrected estimator (Cristian's algorithm, added after a 2026-08-28
 * finding that the countdown was showing time the player did not have) was fed
 * only by SNAPSHOTS and drove the TURN CLOCK. The rough one - whose header
 * says "latency is ignored on purpose", written for a ninety-second freshness
 * gate - was fed by every EVENT and PING frame.
 *
 * So they are one. This law keeps them one.
 *
 * PINS
 *   1. Exactly one module defines `serverNow`.
 *   2. Nothing imports the deleted one.
 *   3. Every consumer reads the surviving one.
 *   4. The estimator still corrects for latency in the safe direction - the
 *      2026-08-28 finding, which is the half a merge could quietly lose.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import {
  recordServerTime,
  noteServerTime,
  serverNow,
  clockOffsetMs,
  __resetServerClock,
} from '../src/utils/serverClock';

const ROOT = join(__dirname, '..');
const SRC = join(ROOT, 'src');

function everySourceFile(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) everySourceFile(full, out);
    else if (/\.(ts|tsx)$/.test(entry)) out.push(full);
  }
  return out;
}

describe('LAW 1/2 - one definition, and the other one is gone', () => {
  const files = everySourceFile(SRC);

  it('exactly one module in src/ defines serverNow', () => {
    const definers = files.filter((f) =>
      /export function serverNow\(/.test(readFileSync(f, 'utf8'))
    );
    expect(
      definers.map((f) => relative(ROOT, f)),
      'two serverNow implementations is how a clock silently inverts'
    ).toEqual(['src/utils/serverClock.ts']);
  });

  it('nothing imports the deleted lib/serverClock', () => {
    const offenders = files.filter((f) =>
      /from '.*lib\/serverClock'/.test(readFileSync(f, 'utf8'))
    );
    expect(offenders.map((f) => relative(ROOT, f))).toEqual([]);
  });

  it('and it really is deleted, not merely unimported', () => {
    let exists = true;
    try {
      statSync(join(SRC, 'lib', 'serverClock.ts'));
    } catch {
      exists = false;
    }
    expect(exists, 'src/lib/serverClock.ts is back').toBe(false);
  });
});

describe('LAW 3 - every consumer reads the surviving clock', () => {
  const files = everySourceFile(SRC);

  it.each([
    'src/components/table/SeatSlot.tsx',
    'src/components/table/PineappleDiscard.tsx',
    'src/hooks/useTableTimer.ts',
    'src/pages/TablePage.tsx',
    'src/lib/bbjHitOnce.ts',
  ])('%s imports utils/serverClock', (rel) => {
    const src = readFileSync(join(ROOT, rel), 'utf8');
    expect(src).toMatch(/from '(\.\.\/)+utils\/serverClock'/);
  });

  it('the transport feeds it, so it learns from every frame and not only snapshots', () => {
    const client = readFileSync(join(SRC, 'services', 'EngineStateClient.ts'), 'utf8');
    expect(client).toMatch(/import \{ noteServerTime \} from '\.\.\/utils\/serverClock'/);
    expect(client).toContain('noteServerTime(msg.ts)');
    const mapper = readFileSync(join(SRC, 'utils', 'mapEngineSnapshot.ts'), 'utf8');
    expect(mapper).toContain('recordServerTime(s.server_time_ms)');
  });

  it('every file that imports it names the same path shape', () => {
    for (const f of files) {
      const src = readFileSync(f, 'utf8');
      for (const m of src.matchAll(/from '([^']*serverClock)'/g)) {
        expect(m[1], `${relative(ROOT, f)} imports a serverClock that is not utils/`).toMatch(
          /utils\/serverClock$|\.\/serverClock$/
        );
      }
    }
  });
});

describe('LAW 4 - the estimator still errs the safe way', () => {
  beforeEach(() => __resetServerClock());

  it('both feeds reach the same estimator', () => {
    const ENGINE = 1_800_000_000_000;
    const spy = vi.spyOn(Date, 'now').mockReturnValue(ENGINE + 5_000);
    noteServerTime(ENGINE);
    expect(clockOffsetMs()).toBe(5_000);
    expect(serverNow()).toBe(ENGINE);
    __resetServerClock();
    recordServerTime(ENGINE);
    expect(clockOffsetMs()).toBe(5_000);
    spy.mockRestore();
  });

  it('converges on the LOWEST-latency sample, never the average', () => {
    /* 2026-08-28: every one-way sample overstates the offset by its own
       latency, so averaging bakes in the average latency and the countdown
       shows time the player does not have. Cristian's algorithm takes the
       window minimum instead. Feeding a good sample then worse ones must not
       drag the offset up. */
    const ENGINE = 1_800_000_000_000;
    const spy = vi.spyOn(Date, 'now');
    spy.mockReturnValue(ENGINE + 1_000); // best sample: offset 1000
    recordServerTime(ENGINE);
    const afterBest = clockOffsetMs();
    for (let i = 0; i < 20; i++) {
      spy.mockReturnValue(ENGINE + 9_000); // worse samples: offset 9000
      recordServerTime(ENGINE);
    }
    expect(clockOffsetMs()).toBeCloseTo(afterBest, 0);
    spy.mockRestore();
  });

  it('ignores junk rather than adopting it', () => {
    noteServerTime(undefined);
    noteServerTime('soon');
    noteServerTime(0);
    noteServerTime(NaN);
    expect(clockOffsetMs()).toBe(0);
  });
});
