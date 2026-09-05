/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  A HELPER USED IN RENDER MUST EXIST BEFORE RENDER (2026-09-05 outage)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `parseTimed` was a `const` arrow declared INSIDE MultiTablePage, below the
 * `anyTurnLive` gate. #3089 made the gate call it. A `const` read before its
 * declaration in the same scope throws ReferenceError ("Cannot access 'He'
 * before initialization" in the bundle), on the first render with any table
 * open. Every table page on production was a "Something Went Wrong" card.
 * No test rendered MultiTablePage, and no source pin looked at declaration
 * order, so it shipped green.
 *
 * The fix is structural: helpers the render body calls are module-level
 * FUNCTION DECLARATIONS, which are hoisted and cannot be in a temporal dead
 * zone whatever their position. This pins that for the ones render reads.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const SRC = readFileSync(join(__dirname, '../../src/pages/MultiTablePage.tsx'), 'utf8');
const componentAt = SRC.indexOf('export default function MultiTablePage()');

describe('MultiTablePage render helpers are hoisted', () => {
  it('parseTimed is a module-level function declaration above the component', () => {
    const decl = SRC.indexOf('function parseTimed(');
    expect(decl).toBeGreaterThan(-1);
    expect(componentAt).toBeGreaterThan(-1);
    expect(decl).toBeLessThan(componentAt);
    // And never again a const arrow inside the component.
    expect(SRC).not.toMatch(/const parseTimed\s*=/);
  });

  it('no const arrow declared inside the component is read by anyTurnLive', () => {
    // The gate that fired the outage. Every identifier it calls must be a
    // hoisted function or an import, never a `const` of the component body
    // declared further down.
    const gateAt = SRC.indexOf('const anyTurnLive = tables.some(');
    expect(gateAt).toBeGreaterThan(componentAt);
    const gate = SRC.slice(gateAt, SRC.indexOf(');', gateAt));
    const calls = [...gate.matchAll(/([A-Za-z_$][\w$]*)\(/g)].map((m) => m[1]);
    for (const name of calls) {
      if (name === 'some') continue;
      const laterConst = new RegExp(`\\n\\s*const ${name}\\s*=`).exec(SRC.slice(gateAt));
      expect(laterConst, `${name} is a const declared after anyTurnLive reads it`).toBeNull();
    }
  });
});
