import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const read = (path: string) => readFileSync(resolve(__dirname, '../../', path), 'utf8');
const page = read('src/pages/GameManagementPage.tsx');
const pageStyles = read('src/pages/GameManagementPage.module.css');
const tickerStyles = read('src/components/club/TickerManagementPanel.module.css');
const messageStyles = read('src/components/club/ClubMessageManagementPanel.module.css');

describe('Table Management Phase 5 wiring laws', () => {
  it('rejects late responses after route identity changes', () => {
    expect(page).toContain('const loadEpochRef = useRef(0)');
    expect(page).toContain('const requestId = ++loadEpochRef.current');
    expect(page).toContain('loadEpochRef.current === requestId');
    expect(page).toContain('loadedRouteRef.current !== routeKey');
  });

  it('protects content drafts across sections, host clubs, and in-app links', () => {
    expect(page).toContain('surfaceDirty &&');
    expect(page).toContain('Discard the unsaved changes on this management section?');
    expect(page).toContain('Discard the unsaved club-message changes before changing host clubs?');
    expect(page).toContain("document.addEventListener('click', onClickCapture, true)");
    expect(page).toContain('Leave Table Management And Discard Your Unsaved Changes?');
  });

  it('ships keyboard focus, high-contrast, reduced-motion, and target-size support', () => {
    expect(page).toContain('useFocusTrap');
    expect(page).toContain('useDialogEscape(true');
    expect(page).toContain('aria-modal="true"');
    for (const css of [pageStyles, tickerStyles, messageStyles]) {
      expect(css).toContain(':focus-visible');
      expect(css).toContain('@media (forced-colors: active)');
    }
    expect(`${pageStyles}\n${tickerStyles}\n${messageStyles}`).toMatch(/min-height:\s*44px/);
    expect(`${pageStyles}\n${tickerStyles}`).toContain('@media (prefers-reduced-motion: reduce)');
  });
});
