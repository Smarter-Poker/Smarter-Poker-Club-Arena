/**
 * ═══ ONE ARMED PRICE, AND IT IS THE ENGINE'S (Dan 2026-08-30) ══════════════
 *
 * The client suppresses the ActionPanel while an armed pre-action is one the
 * engine can still honour (src/lib/preActionPanelGate.ts). Until now it judged
 * that against a price the BROWSER snapshotted at tap time, while the engine
 * judged the same question against `toCallAtSet`, recorded from its own
 * authoritative state.
 *
 * Two snapshots of one number, taken at two moments on two machines. They
 * agree almost always — and the "almost" is exactly the bug shape this whole
 * area keeps producing: a panel flash on a hand the engine was going to act,
 * or NO panel on a hand where the engine had already invalidated the arm and
 * the player is sitting on a running clock believing they are covered.
 *
 * `/preaction` now returns `armedToCall` and the client adopts it. Crucially
 * it is a REPLY to the hero's own request, not a table-wide broadcast: telling
 * every seat that someone is armed would hand villains the tell that the
 * engine's visible pre-action beat (preActionVisibleMs) exists to mask.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { isPreActionHonorable } from '../../src/lib/preActionPanelGate';

const read = (p: string) => readFileSync(path.resolve(__dirname, '../..', p), 'utf8');

describe('the engine hands its recorded price back to the hero', () => {
  const turns = read('server/src/engine/ServerTableEngineTurns.ts');

  it('setPreAction returns armedToCall', () => {
    expect(
      /armedToCall\?: number/.test(turns),
      'the engine no longer declares armedToCall on its setPreAction result'
    ).toBe(true);
    expect(
      /return \{ success: true, armedToCall: toCallAtSet \};/.test(turns),
      'the success reply no longer carries the engine-recorded price'
    ).toBe(true);
  });

  it('it is the SAME number the engine caps execution with', () => {
    // toCallAtSet is computed once and used for both the reply and the cap.
    expect(turns).toMatch(
      /const toCallAtSet = Math\.max\(0, state\.currentBet - \(player\.bet \?\? 0\)\)/
    );
    expect(turns).toMatch(/toCallAtSet\s*\n?\s*\);/);
  });

  it('IT IS NOT BROADCAST — no table-wide emit carries the armed price', () => {
    // A tell that every seat can read would defeat the visible beat. The value
    // may only travel in the reply to the arming request.
    const broadcasts = turns.match(/emitEvent\([^)]*armedToCall[^)]*\)/g) ?? [];
    expect(broadcasts, 'the armed price is being broadcast to the whole table').toHaveLength(0);
  });
});

describe('the client adopts it', () => {
  const page = read('src/pages/TablePage.tsx');
  const api = read('src/services/GameServerAPI.ts');

  it('ActionResult carries armedToCall through the API layer', () => {
    expect(api.includes('armedToCall?: number')).toBe(true);
  });

  it('the arm path overwrites the browser snapshot with the engine number', () => {
    expect(
      /if \(typeof res\.armedToCall === 'number' && Number\.isFinite\(res\.armedToCall\)\) \{\s*\n\s*preActionCallAmountRef\.current = res\.armedToCall;/.test(
        page
      ),
      'the client kept its own snapshot — the two prices can disagree again'
    ).toBe(true);
  });

  it('a missing or non-numeric reply leaves the local snapshot intact', () => {
    // An older engine, or a reply that lost the field, must degrade to the
    // previous behaviour rather than to an undefined cap (which would read as
    // "no cap" and turn Call 15 into Call Any).
    expect(page).toMatch(/typeof res\.armedToCall === 'number' && Number\.isFinite/);
  });
});

describe('the rule the shared number feeds, unchanged', () => {
  it('an engine-recorded cap still refuses a raise past it', () => {
    expect(isPreActionHonorable('call', 300, 300)).toBe(true);
    expect(isPreActionHonorable('call', 301, 300)).toBe(false);
  });

  it('Call Any is still uncapped — that button IS the promise', () => {
    expect(isPreActionHonorable('callAny', 999999, 0)).toBe(true);
  });
});
