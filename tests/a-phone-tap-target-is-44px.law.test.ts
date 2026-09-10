/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  LAW: A PHONE TAP TARGET IS 44px
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * CLAUDE.md working rule 6: mobile-first, 375px first, then scale up. The
 * minimum tap target on a phone is 44px. Audit 2026-09-08 found two dismiss
 * or create controls under that on surfaces a phone reaches:
 *
 *   CL-31  GameCreationActions: the `.compact` variant set buttons to 30px
 *          and the 760px breakpoint re-flowed the row to two columns
 *          without restoring height. On the union and game-management
 *          screens that row is the ONLY route to creating a game.
 *   CL-33  GameLobbyPanel: `.glp__close` was 30x30 and the 640px breakpoint
 *          only widened the sheet. That button is the only way off the
 *          lobby game panel.
 *
 * Each pin below is one of those. If you restyle either control, keep the
 * hit area at 44px on a phone; do not shrink it back to fit a row.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(__dirname, '..');
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');

describe('a phone tap target is 44px', () => {
  it('CL-31: the create-game row restores 44px buttons where it re-flows for a phone', () => {
    const css = read('src/components/club/GameCreationActions.module.css');
    const block = /@media \(max-width: 760px\) \{([\s\S]*?)\n\}/.exec(css);
    expect(block, 'the 760px block is the phone re-flow and must still exist').not.toBeNull();
    const phone = block![1];
    // Both the base row and the compact variant, in one rule, at 44px.
    expect(phone).toMatch(/\.actions button,\s*\.compact button \{[^}]*min-height: 44px/);
    // And that rule comes after the compact 30px rule, so it wins the tie.
    expect(css.indexOf('.compact button {')).toBeLessThan(css.indexOf('@media (max-width: 760px)'));
  });

  it('CL-33: the lobby game panel close button is 44x44 at every width', () => {
    const css = read('src/components/lobby/GameLobbyPanel.css');
    const rule = /\.glp__close \{([^}]*)\}/.exec(css);
    expect(rule).not.toBeNull();
    expect(rule![1]).toMatch(/width: 44px/);
    expect(rule![1]).toMatch(/height: 44px/);
    // No later rule shrinks it.
    const after = css.slice(css.indexOf('.glp__close {') + 1);
    expect(after).not.toMatch(/\.glp__close[^{]*\{[^}]*(?:width|height): (?:[0-3]\d|4[0-3])px/);
  });
});
