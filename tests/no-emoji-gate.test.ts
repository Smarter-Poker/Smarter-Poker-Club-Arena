/**
 * The emoji rule was the only one of the Club Arena's three copy rules that
 * nothing enforced, which is why gameplay drifted: a chat bubble, a clock, a
 * snowflake, a smiley and a diamond were rendering on the profile sheet a
 * player opens by tapping their own avatar mid-hand, and a flame in the
 * session HUD.
 *
 * check-no-emoji.mjs closes that. These pins keep it CONNECTED - a gate that
 * exists but runs nowhere is the state we were already in.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';

const read = (p: string) => readFileSync(join(__dirname, '..', p), 'utf8');

describe('the no-emoji rule is mechanical', () => {
  it('the gate exists', () => {
    expect(existsSync(join(__dirname, '..', 'scripts/ci/check-no-emoji.mjs'))).toBe(true);
  });

  it('runs in CI beside the other two copy gates', () => {
    const ci = read('.github/workflows/ci.yml');
    expect(ci).toContain('node scripts/ci/check-no-emoji.mjs');
    // Its siblings must still be there too: a gate suite that loses one rule
    // silently is how this drifted in the first place.
    expect(ci).toContain('node scripts/ci/check-ui-text.mjs');
    expect(ci).toContain('node scripts/ci/check-title-case.mjs');
  });

  it('runs in the local all-gates suite', () => {
    expect(read('scripts/ci/all-gates.sh')).toContain('check-no-emoji');
  });

  it('still permits the typography the Club Arena actually uses', () => {
    const gate = read('scripts/ci/check-no-emoji.mjs');
    // The card suits and arrows must never be swept up as "emoji": the felt is
    // built out of them.
    expect(gate).toMatch(/Emoji_Presentation/);
    expect(gate).toMatch(/FE0F/);
  });

  it('sees through the escape that walked around the first cut', () => {
    const gate = read('scripts/ci/check-no-emoji.mjs');
    // `icon: '\\u{1F3AF}'` is a direct hit emoji as surely as pasting one.
    // Two shipped that way while this gate reported OK; it now decodes first.
    expect(gate).toContain('decodeEscapes');
    expect(gate).toMatch(/String\.fromCodePoint/);
    expect(gate).toMatch(/String\.fromCharCode/);
  });

  it('the escaped emoji it missed are gone from the source', () => {
    for (const f of [
      'src/components/table/TournamentAnnouncementOverlay.tsx',
      'src/components/common/TransactionLedgerView.tsx',
    ]) {
      expect(read(f)).not.toMatch(/\\u\{1F[0-9A-Fa-f]{3}\}/);
    }
  });

  it('allowlists the pickers, where emoji are the product', () => {
    const gate = read('scripts/ci/check-no-emoji.mjs');
    expect(gate).toContain('src/components/table/EmojiPicker.tsx');
    expect(gate).toContain('src/components/emoji/EmojiPicker.tsx');
  });
});
