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

  it('protects content drafts across sections and in-app links', () => {
    expect(page).toContain('surfaceDirty &&');
    expect(page).toContain('Discard the unsaved changes on this management section?');
    expect(page).toContain("document.addEventListener('click', onClickCapture, true)");
    expect(page).toContain('Leave Table Management And Discard Your Unsaved Changes?');
  });

  it('never lets an operator switch host clubs on a management page (Dan 2026-09-04)', () => {
    // One page, one host. The union console hosts games on the union's own
    // club row; member clubs are labels on the board, never a selectable host.
    expect(page).not.toContain('changeHostClub');
    expect(page).not.toContain('<select value={hostClubId}');
    expect(page).toContain("eq('is_union', true)");
    expect(page).toContain("setHostClubId(nextHosts[0]?.id || '')");
  });

  it('keeps the create-table flow on the management page instead of a club route', () => {
    // The selector and the config form are embedded; picking a variant sets
    // ?create=table&game=<variant> on THIS page rather than navigating to
    // /clubs/<host>/create-table/<variant>, which from a union console meant
    // landing on a member club's URL.
    expect(page).toContain('onSelectGameType={openTableConfig}');
    expect(page).toContain('gameTypeOverride={requestedGameType}');
    expect(page).not.toMatch(/navigate\(`\/clubs\/\$\{[a-zA-Z]+\}\/create-table/);
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
