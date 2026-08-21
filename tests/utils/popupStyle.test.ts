/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  POPUP STYLE — Dan's House Rule, Pinned
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Dan 2026-08-20, from a live table: "any and all pop ups need the first
 * letter of every word capitalized, and forbid the use of em bars."
 *
 * The rule lives in the render path (Toast provider -> formatPopupText), so
 * these tests pin two things: the transform itself, and that the Toast layer
 * actually applies it — because a rule enforced at one door is only a rule if
 * every message walks through that door.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { formatPopupText } from '../../src/utils/popupStyle';

describe('formatPopupText — Title Case', () => {
  it('capitalizes the first letter of every word', () => {
    expect(formatPopupText('check your connection')).toBe('Check Your Connection');
    expect(formatPopupText('reconnected to the table.')).toBe('Reconnected To The Table.');
  });

  it('preserves interior capitals — acronyms and product names survive', () => {
    expect(formatPopupText('VIP level up')).toBe('VIP Level Up');
    expect(formatPopupText('BBJ hit at NLH table')).toBe('BBJ Hit At NLH Table');
    expect(formatPopupText('your TimeBank is active')).toBe('Your TimeBank Is Active');
  });

  it('capitalizes after brackets and quotes, not just spaces', () => {
    expect(formatPopupText('rebuy failed (insufficient chips)')).toBe(
      'Rebuy Failed (Insufficient Chips)'
    );
  });

  it('leaves numbers and punctuation alone', () => {
    expect(formatPopupText('20s granted, 1 use left')).toBe('20s Granted, 1 Use Left');
  });
});

describe('formatPopupText — no em dashes, ever', () => {
  it('turns a clause-break dash into a sentence break', () => {
    expect(formatPopupText('connection lost — the server may fold for you')).toBe(
      'Connection Lost. The Server May Fold For You'
    );
  });

  it('covers the en dash too — it reads the same on a phone', () => {
    expect(formatPopupText('paused – back soon')).toBe('Paused. Back Soon');
  });

  it('an unspaced dash becomes a plain hyphen', () => {
    expect(formatPopupText('auto—fold armed')).toBe('Auto-Fold Armed');
  });

  it('output NEVER contains an em or en dash, whatever comes in', () => {
    for (const nasty of ['a — b — c', '——', 'x–y–z', '— leading', 'trailing —']) {
      const out = formatPopupText(nasty);
      expect(out).not.toMatch(/[—–]/);
    }
  });
});

describe('the Toast layer actually enforces the rule', () => {
  const toast = readFileSync(resolve(__dirname, '../../src/components/common/Toast.tsx'), 'utf8');

  it('showToast routes every message through formatPopupText', () => {
    expect(toast).toMatch(/formatPopupText\(message\)/);
    expect(toast).toMatch(/from '\.\.\/\.\.\/utils\/popupStyle'/);
  });

  it('identical popups dedupe instead of stacking', () => {
    // "connection lost pop ups need to stop" — a retry loop must not build a
    // column of five matching warnings.
    expect(toast).toMatch(/prev\.some\(\(t\) => t\.message === styled && t\.type === type\)/);
  });
});
