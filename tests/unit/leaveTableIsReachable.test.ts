/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  EVERY CLASS A COMPONENT APPLIES MUST EXIST IN ITS STYLESHEET
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Dan 2026-08-25: "LEAVE TABLE FROM THE HAMBURGER MENU DOESN'T WORK AT ALL."
 *
 * It worked. Nobody could see it.
 *
 * LeaveTableConfirm rendered `className="leave-confirm-overlay"` and
 * `className="leave-confirm"`, and LeaveTableConfirm.css defines NEITHER — it
 * has the BEM pair `__backdrop` / `__dialog`, which every CHILD element in that
 * component already used. The only `.leave-confirm-overlay` rule anywhere is in
 * QuickLeaveButton.css, a component nothing imports, so that file is not even in
 * the bundle.
 *
 * With no rule matching, the overlay lost `position: fixed`, `inset: 0` and its
 * z-index, and the dialog lost its background and sizing. It rendered as a plain
 * static flex child appended after `.table-page` — `position: fixed; inset: 0;
 * overflow: hidden` — and was clipped out of existence. State flipped, React
 * rendered, and nothing appeared.
 *
 * That one mismatch is why TWO of the three reports looked like dead buttons:
 * the hamburger Leave Table, and Leave Table while sitting out. The paths that
 * DID work — the tab X, the tab long-press — are exactly the ones that skip this
 * confirm dialog entirely.
 *
 * A styling typo that silently disables a control is invisible to typecheck, to
 * lint, and to any test that renders and asserts on roles. So this pins the
 * class names themselves.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { sliceCssRule } from '../helpers/sourceWindow';

const read = (p: string) => readFileSync(resolve(__dirname, '../../', p), 'utf8');

/** Every class token this component passes to className={"..."} literals. */
function literalClasses(tsx: string): string[] {
  const out = new Set<string>();
  for (const m of tsx.matchAll(/className="([^"{}]+)"/g)) {
    for (const cls of m[1].split(/\s+/)) if (cls) out.add(cls);
  }
  return [...out];
}

function definedClasses(css: string): Set<string> {
  const out = new Set<string>();
  for (const m of css.matchAll(/\.([a-zA-Z0-9_-]+)/g)) out.add(m[1]);
  return out;
}

describe('LeaveTableConfirm is actually visible', () => {
  const tsx = read('src/components/table/LeaveTableConfirm.tsx');
  const css = read('src/components/table/LeaveTableConfirm.css');

  it('every static class it applies is defined in its own stylesheet', () => {
    const defined = definedClasses(css);
    const missing = literalClasses(tsx).filter((c) => !defined.has(c));
    expect(
      missing,
      `LeaveTableConfirm applies classes with no CSS behind them: ${missing.join(', ')}. ` +
        `An unstyled overlay loses position:fixed and is clipped out of view — the dialog ` +
        `renders and nobody can see it, which reads as "Leave Table does nothing".`
    ).toEqual([]);
  });

  it('the backdrop is the one that carries position:fixed', () => {
    // The specific property whose absence made the dialog unreachable.
    expect(tsx).toMatch(/className="leave-confirm__backdrop"/);
    const at = css.indexOf('.leave-confirm__backdrop');
    expect(at).toBeGreaterThan(-1);
    expect(sliceCssRule(css, '.leave-confirm__backdrop')).toMatch(/position:\s*fixed/);
  });

  it('the dead class names never come back', () => {
    expect(tsx).not.toMatch(/className="leave-confirm-overlay"/);
    expect(tsx).not.toMatch(/className="leave-confirm"/);
  });
});

describe('a sitting-out player has a way off the table', () => {
  const tsx = read('src/components/table/SitOutModal.tsx');
  const css = read('src/components/table/SitOutModal.css');

  it('renders a Leave Table button, not just "I\'m Back"', () => {
    // SitOutModal has ALWAYS taken an onLeaveTable prop and built a handleLeave
    // for it — TableModalsLayer passes onConfirmLeaveTable in — and then
    // rendered only the return button. The handler was dead code, so the one
    // screen a sitting-out player is looking at offered no way out.
    expect(tsx).toMatch(/Leave Table/);
    expect(tsx).toMatch(/handleLeave\(\)/);
  });

  it('and that button has CSS behind it', () => {
    const defined = definedClasses(css);
    const missing = literalClasses(tsx).filter((c) => !defined.has(c));
    expect(missing, `SitOutModal applies undefined classes: ${missing.join(', ')}`).toEqual([]);
  });
});
