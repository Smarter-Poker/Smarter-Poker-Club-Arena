/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * THE ACTION ROW IS SACRED, AND THE SHEET YOU SIT DOWN THROUGH IS REACHABLE
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Mobile/a11y sweep 2026-08-28.
 *
 *  - WaitlistBanner was `position: fixed; bottom: 80; zIndex: 9999`, mounted
 *    app-wide. The action bar is fixed at bottom 0 with a 52px row PLUS
 *    env(safe-area-inset-bottom) — ~86px on a notched iPhone — and its z-index
 *    token is 100. So a banner about a DIFFERENT table covered fold / call /
 *    raise mid-hand. It must clear the bar by construction, not by a number
 *    that happens to look big enough.
 *  - BuyInModal — the sheet every player passes through to sit down — had no
 *    dialog semantics and no Escape handler; the backdrop click was the only
 *    exit, which no keyboard can reach.
 *  - A payout button ran window.confirm: unstyled OS chrome on a money action,
 *    no Title Case, and it blocks the JS thread.
 *  - House rule, binding: AI players are horses, never "bots".
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

const read = (p: string) => readFileSync(resolve(__dirname, '../../src', p), 'utf8');

/**
 * Source with comments removed. The fixes below all carry a note explaining
 * what the old value WAS, so a naive `not.toContain('bottom: 80')` would
 * match the explanation and fail on correct code. Negative assertions run
 * against code only; positive ones can use the raw text.
 */
const readCode = (p: string) =>
  read(p)
    .replace(/\{\s*\/\*[\s\S]*?\*\/\s*\}/g, '') // JSX comment expressions
    .replace(/\/\*[\s\S]*?\*\//g, '') // block comments
    .replace(/(^|[^:])\/\/.*$/gm, '$1'); // line comments (not '://')

describe('WaitlistBanner cannot cover the action row', () => {
  const src = read('components/common/WaitlistBanner.tsx');
  const code = readCode('components/common/WaitlistBanner.tsx');

  it('clears the action bar using the same height and safe-area the bar reserves', () => {
    expect(src).toContain("bottom: 'calc(52px + env(safe-area-inset-bottom, 0px) + 12px)'");
    expect(code).not.toMatch(/bottom:\s*80\b/);
  });

  it('drops out of the 9999 arms race and sits on the token scale', () => {
    expect(code).not.toContain('zIndex: 9999');
    // Above overlays (200), below the modal backdrop (400) and toasts (600).
    expect(src).toMatch(/zIndex:\s*300/);
  });

  it('caps its own width so it cannot overflow a 375px viewport', () => {
    expect(src).toContain("maxWidth: 'min(90vw, 420px)'");
  });

  it('gives the dismiss control a name and a 44px hit area', () => {
    expect(src).toContain('`Dismiss The Waitlist Notice For ${entry.tableName}`');
    expect(src).toContain("'Dismiss The Waitlist Notice'");
    expect(src).toContain('.waitlist-banner__dismiss::after');
    expect(src).toMatch(/width:\s*44px;[\s\S]*height:\s*44px;/);
  });
});

describe('BuyInModal is reachable and announced', () => {
  const src = read('components/table/BuyInModal.tsx');

  it('is a real dialog with an accessible name', () => {
    expect(src).toContain('role="dialog"');
    expect(src).toContain('aria-modal="true"');
    expect(src).toContain('aria-labelledby="buy-in-modal-title"');
    expect(src).toContain('id="buy-in-modal-title"');
  });

  it('closes on Escape, but never mid-buy-in', () => {
    expect(src).toMatch(/if \(e\.key !== 'Escape'\) return;/);
    expect(src).toMatch(/if \(isProcessing\) return;/);
    // Listener attached only while open, and removed on cleanup.
    expect(src).toContain("window.addEventListener('keydown', onKeyDown)");
    expect(src).toContain("window.removeEventListener('keydown', onKeyDown)");
  });

  it('names the close button for a screen reader', () => {
    expect(src).toContain('aria-label="Close Buy-In"');
  });
});

describe('money actions do not use OS dialogs', () => {
  it('the leaderboard does not expose an unsafe browser payout action', () => {
    const src = read('pages/LeaderboardPage.tsx');
    expect(readCode('pages/LeaderboardPage.tsx')).not.toContain('window.confirm');
    expect(src).not.toContain('<ConfirmModal');
    expect(src).not.toContain('payoutLeaderboardPeriod');
    expect(src).toContain('<LeaderboardPrizeWizard');
    expect(src).toContain(
      'Published Rules Activate At The Dates Shown. Settlement Uses The Recorded Promo Wallet After The Period Closes.'
    );
  });
});

describe('house rules', () => {
  it('AI players are horses, never bots, in user-facing copy', () => {
    expect(read('components/union/UnionOpsPanel.tsx')).toContain('A Horse Or Colluding Ring');
    expect(readCode('components/union/UnionOpsPanel.tsx')).not.toContain('A Bot Or');
  });
});
