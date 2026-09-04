/**
 * A FOLD IS A FOLD (Dan 2026-09-04)
 *
 * "When you 'fold when you can check' it freezes the game, and glitches... it
 * needs to be smooth and just accept the action and move on."
 *
 * What froze: a fold with a free check did not fold. It opened
 * FoldProtectionDialog ("Check Or Fold?"), a full-viewport modal that ignored
 * every input for 350ms, could not be dismissed by its backdrop, and was never
 * closed by the game. When the clock ran out under it the server checked for
 * the player and the modal stayed up over a hand that had moved on; the next
 * tap on its Fold button was an out-of-turn fold and a "Not your turn" toast.
 *
 * The server never needed protecting from a voluntary fold
 * (ServerActionValidator.validateFold: "player may fold even when they can
 * check"). The client now sends it straight through, and the dialog, its CSS,
 * `commitFold` and the dialog-only `handleCheck` are gone.
 */
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(__dirname, '../..');
const read = (p: string) => readFileSync(resolve(root, p), 'utf8');
const strip = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');

describe('a fold is a fold, whether or not a check was free', () => {
  it('the protection dialog no longer exists', () => {
    expect(existsSync(resolve(root, 'src/components/table/FoldProtectionDialog.tsx'))).toBe(false);
    expect(existsSync(resolve(root, 'src/components/table/FoldProtectionDialog.css'))).toBe(false);
  });

  it('TablePage neither imports nor renders it, and holds no state for it', () => {
    const src = strip(read('src/pages/TablePage.tsx'));
    expect(src).not.toMatch(/FoldProtectionDialog/);
    expect(src).not.toMatch(/foldProtectOpen|setFoldProtectOpen/);
    expect(src).not.toMatch(/\bcommitFold\b/);
  });

  it("the panel's fold case does not consult canCheckRightNow before folding", () => {
    const src = strip(read('src/pages/TablePage.tsx'));
    const at = src.indexOf("case 'fold':");
    expect(at).toBeGreaterThan(-1);
    const next = src.indexOf("case 'check':", at);
    const foldCase = src.slice(at, next);
    expect(foldCase).not.toMatch(/canCheckRightNow/);
    // And it still does what every other case does: validate, sound, paint
    // optimistically, submit, revert on rejection.
    expect(foldCase).toMatch(/validateAndExecuteAction\('fold'\)/);
    expect(foldCase).toMatch(/applyOptimisticHeroAction\('fold'\)/);
    expect(foldCase).toMatch(/submitActionWithToast\([\s\S]*?'fold'/);
  });

  it('the server accepts a voluntary fold with a free check (the reason no client gate was needed)', () => {
    const validator = strip(read('server/src/engine/ServerActionValidator.ts'));
    const at = validator.indexOf('private validateFold(');
    expect(at).toBeGreaterThan(-1);
    const body = validator.slice(at, validator.indexOf('}', at));
    expect(body).toMatch(/valid:\s*true/);
    expect(body).not.toMatch(/canCheck/);
  });

  it('pre-actions still map an armed fold to check-or-fold when the check is free', () => {
    // That is a different thing: a PRE-selected fold means "check if I can,
    // fold if I cannot", and this pin keeps the two from being confused.
    const src = strip(read('src/pages/TablePage.tsx'));
    expect(src).toMatch(/auto_check_fold/);
  });
});
