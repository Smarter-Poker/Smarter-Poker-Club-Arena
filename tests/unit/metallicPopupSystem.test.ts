import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const read = (path: string) => readFileSync(resolve(__dirname, '../..', path), 'utf8');

const main = read('src/main.tsx');
const popupCss = read('src/styles/metallic-popups.css');
const lobbyCss = read('src/pages/ClubHomePage.css');
const tableCss = read('src/components/lobby/LobbyTable.css');

describe('solid-color metallic popup system', () => {
  it('loads globally before the final reduced-motion guard', () => {
    const popupImport = main.indexOf("import './styles/metallic-popups.css'");
    const reducedMotionImport = main.indexOf("import './styles/reducedMotion.css'");

    expect(popupImport).toBeGreaterThan(-1);
    expect(reducedMotionImport).toBeGreaterThan(popupImport);
  });

  it('uses depth without any decorative gradients', () => {
    expect(popupCss).not.toMatch(/(?:linear|radial|conic)-gradient\s*\(/i);
    expect(popupCss).toContain('inset 0 3px 0 var(--ca-popup-rail)');
    expect(popupCss).toContain('0 34px 80px rgba(0, 0, 0, 0.48)');
    expect(popupCss).toContain('background: var(--ca-popup-shell) !important');
  });

  it('covers every popup family instead of only the shared modal', () => {
    const requiredSurfaces = [
      // Shared and confirmation surfaces
      '.modal',
      '.base-modal',
      '.confirm-modal',
      '.confirm-dialog',
      '.action-sheet',
      // Club creation and CSS-module modals
      "[class*='_modal_']",
      "[class*='_modal-content_']",
      "[class*='_modalContainer_']",
      // Wallet and cashier surfaces
      '.cashier-modal',
      '.cashout-modal',
      '.cbc-panel',
      '.cmm-panel',
      '.diamond-wallet-modal',
      // Table and tournament surfaces
      '.buy-in-modal',
      '.rules-modal',
      '.hdm-panel',
      '.insurance-modal',
      '.rebuy-modal',
      '.signup-modal',
      '.waitlist-modal',
      // Social, support and admin surfaces
      '.report-modal',
      '.block-modal',
      '.faq-modal',
      '.reports-modal',
      '.audit-modal',
      // Drawers and detail sheets
      '.drawer',
      '.afx-sheet',
      '.glp',
      '.table-chat',
      '.settings-panel',
    ];

    for (const selector of requiredSurfaces) {
      expect(popupCss, `missing metallic coverage for ${selector}`).toContain(selector);
    }
  });

  it('gives overlays, fields, buttons, close controls and mobile sheets depth', () => {
    expect(popupCss).toContain('.modal-overlay');
    expect(popupCss).toContain("[class*='_modalOverlay_']");
    expect(popupCss).toContain("input:not([type='checkbox']):not([type='radio'])");
    // Was `button:hover:not(:disabled)`. Hover was removed estate-wide on
    // 2026-08-29, so the pressed state is now the only interaction feedback a
    // popup button gives -- and it is the one that was always doing the work,
    // since a phone cannot hover and this sheet is mostly read on a phone.
    expect(popupCss).toContain('button:active:not(:disabled)');
    expect(popupCss).toContain("[aria-label*='Close']");
    expect(popupCss).toContain('@media (max-width: 640px)');
  });

  it('gives a popup button no hover state to fall back on', () => {
    expect(popupCss.replace(/\/\*[\s\S]*?\*\//g, '')).not.toContain(':hover');
  });
});

describe('solid-color live lobby', () => {
  it('removes gradients from the redesigned control deck', () => {
    const liveBoard = lobbyCss.slice(
      lobbyCss.indexOf('LIVE GAME BOARD'),
      lobbyCss.indexOf('APPROVED CLUB ARENA COMPOSITION')
    );
    expect(liveBoard).not.toMatch(/(?:linear|radial|conic)-gradient\s*\(/i);
    expect(liveBoard).toContain('background: #111a2a');
    expect(liveBoard).toContain('background: #2866dc');
  });

  it('removes gradients from the redesigned desktop rows and mobile cards', () => {
    const liveEvents = tableCss.slice(tableCss.indexOf('LIVE EVENT BOARD'));
    expect(liveEvents).not.toMatch(/(?:linear|radial|conic)-gradient\s*\(/i);
    expect(liveEvents).toContain('background: #111722');
    expect(liveEvents).toContain('background: #0d1725');
    expect(liveEvents).toContain('background: #12294b');
  });
});
