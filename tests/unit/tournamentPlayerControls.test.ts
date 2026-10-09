import { beforeEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { getArenaSectionNavigation } from '../../src/config/arenaSectionNavigation';
import {
  resetTournamentDockStoreForTests,
  subscribeTournamentDock,
  tournamentDockClosed,
  setTournamentDockClosed,
  tournamentDockCollapsed,
  toggleTournamentDockCollapsed,
} from '../../src/lib/tournamentDockStore';
const read = (p: string) => readFileSync(p, 'utf8');
beforeEach(() => {
  localStorage.clear();
  resetTournamentDockStoreForTests();
});
describe('tournament player controls', () => {
  it('keeps the history rail off standalone tournament lobbies', () => {
    expect(getArenaSectionNavigation('/tournaments/event-1')).toBeNull();
    expect(getArenaSectionNavigation('/tournaments')).not.toBeNull();
    expect(getArenaSectionNavigation('/hand-history')).not.toBeNull();
  });
  it('closes every subscribed dock, remembers closure and reopens without changing collapse', () => {
    let calls = 0;
    const off = subscribeTournamentDock(() => calls++);
    toggleTournamentDockCollapsed();
    setTournamentDockClosed(true);
    setTournamentDockClosed(true);
    expect(calls).toBe(2);
    expect(tournamentDockClosed()).toBe(true);
    expect(tournamentDockCollapsed()).toBe(true);
    off();
    resetTournamentDockStoreForTests();
    expect(tournamentDockClosed()).toBe(true);
    setTournamentDockClosed(false);
    expect(tournamentDockClosed()).toBe(false);
    expect(tournamentDockCollapsed()).toBe(true);
  });
  it('closure is wired to the button and menu, retaining a static felt reserve', () => {
    const page = read('src/pages/TablePage.tsx');
    const hud = read('src/components/tournament/TournamentHUD.tsx');
    const tabs = read('src/components/table/TableTabBar.tsx');
    expect(hud).toContain('aria-label="Close Tournament Info"');
    expect(hud).toContain('event.stopPropagation()');
    expect(page).toContain('onClose={() => setTournamentDockClosed(true)}');
    expect(page).toContain("case 'SHOW_TOURNAMENT_DOCK':");
    expect(tabs).toContain("action: 'SHOW_TOURNAMENT_DOCK'");
    expect(read('src/components/tournament/TournamentHUD.css')).toMatch(
      /data-tdock='closed'\] \{\s*--sp-tdock-now: 0px;/
    );
  });
  it('bust consumers retain field updates without per-player placement toasts', () => {
    const details = read('src/pages/tournament/TournamentDetails.tsx');
    const handler = details.slice(
      details.indexOf('const unsubElim'),
      details.indexOf('const unsubBlind')
    );
    expect(handler).toContain('patchEntries');
    expect(handler).not.toContain('toast.info');
  });
});
