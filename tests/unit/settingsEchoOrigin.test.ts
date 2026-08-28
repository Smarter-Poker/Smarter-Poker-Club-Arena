/**
 * A SETTING NEVER STOPS UPDATING LIVE.
 *
 * Dan 2026-08-26. `useTableSettings` and `useUserTableSettings` both need to
 * ignore their OWN echo off the bus without ignoring anybody else's. Both did
 * it with a one-shot boolean:
 *
 *     localOriginRef.current = true;      // set before emitting
 *     masterBus.emit('SETTINGS_CHANGED', …);
 *     // …and the subscriber clears it when the echo arrives
 *
 * That is only safe if the echo ALWAYS arrives, and it does not. MasterBus
 * drops a duplicate `{type, payload}` fingerprint inside 500ms, and
 * SETTINGS_CHANGED is not in DEDUP_BYPASS. Set a value to what it already is
 * — or hit "Reset To Defaults" twice — and the emit is suppressed. The echo
 * never comes, the latch stays TRUE, and the NEXT genuine change from another
 * component or another tab is silently swallowed.
 *
 * That is the shape of "sometimes my settings just stop applying": no error,
 * no console, and it un-sticks itself the next time you change anything.
 *
 * These tests pin the property that replaced it: identity, not state. They
 * assert against the SOURCE, deliberately — the failure is a latch existing
 * at all, and a behavioural test would have to reproduce the bus's internal
 * dedup timing to see it.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/* Comments in these files quote the OLD latch at length, deliberately, so the
   next reader knows why it is gone. Strip comments before asserting, or the
   history is mistaken for the code. */
const read = (p: string) =>
  readFileSync(resolve(__dirname, '../..', p), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');

const HOOKS = ['src/hooks/useTableSettings.ts', 'src/hooks/useUserTableSettings.ts'] as const;

describe.each(HOOKS)('%s', (file) => {
  const src = read(file);

  it('does not use a set-before-emit boolean latch', () => {
    expect(
      /localOriginRef/.test(src),
      'the stuck-latch is back: a suppressed emit will swallow the next live update'
    ).toBe(false);
  });

  it('tags every SETTINGS_CHANGED it emits with its own origin', () => {
    const emits = [...src.matchAll(/masterBus\.emit\(\s*'SETTINGS_CHANGED',\s*\{([^}]*)\}/g)].map(
      (m) => m[1]
    );
    expect(emits.length, 'no SETTINGS_CHANGED emits found — did the file move?').toBeGreaterThan(0);
    for (const body of emits) {
      expect(body, `an emit without an origin cannot be distinguished from a peer's`).toMatch(
        /origin:\s*originIdRef\.current/
      );
    }
  });

  it('ignores only its own echo, by comparing that origin', () => {
    expect(src).toMatch(/event\.payload\?\.origin === originIdRef\.current/);
  });

  it('derives the origin id at runtime rather than hardcoding one', () => {
    /* WHAT THIS PINS, and why it is no longer "one id per hook instance"
       (2026-08-28).

       The original rule was "derived per instance, not a module constant — two
       mounted tables must not share an id or they would ignore each other's
       changes." That was correct while each mounted hook kept its OWN copy of
       the settings: two copies are two receivers, and a shared id would make
       each ignore the other's echo.

       `useTableSettings` no longer works that way. Its state is a single
       module-level store that every consumer reads through
       `useSyncExternalStore`, because eight independent copies each rewriting
       the whole localStorage blob is what made settings silently revert (Dan:
       "NEVER REGRESS OR AUTO CHANGE BACK"). With one store there is exactly one
       receiver in the tab, so one origin id is not merely acceptable, it is the
       accurate description — and per-instance ids would now be wrong, since two
       ids would both be talking about the same object.

       `useUserTableSettings` still keeps per-instance state, so it still uses a
       `useRef`. Both shapes are accepted below; what must never come back is
       the boolean latch, which the first case in this file pins, or a
       hardcoded/static string, which `Math.random()` rules out. */
    expect(src).toMatch(/originIdRef\s*=\s*(useRef<string>\(|\{\s*current:)/);
    expect(src).toMatch(/Math\.random\(\)/);
  });
});

describe('the bus contract carries the origin', () => {
  it('SETTINGS_CHANGED declares an optional origin', () => {
    const bus = read('src/core/MasterBus.ts');
    expect(bus).toMatch(/SETTINGS_CHANGED:\s*\{[\s\S]*?origin\?:\s*string;[\s\S]*?\}/);
  });
});
