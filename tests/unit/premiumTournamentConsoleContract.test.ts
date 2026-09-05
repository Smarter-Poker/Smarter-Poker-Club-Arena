import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const read = (path: string) => readFileSync(join(process.cwd(), path), 'utf8');

const PAGE = read('src/pages/tournament/TournamentDetails.tsx');
const TYPES = read('src/components/tournament/details/types.ts');
const PREMIUM = read('src/pages/tournament/PremiumTournamentConsole.css');
const GAME_PANEL = read('src/components/lobby/GameLobbyPanel.tsx');
const GAME_PREMIUM = read('src/components/lobby/PremiumGameLobbyPanel.css');

describe('approved premium tournament console contract', () => {
  it('publishes exactly the seven approved tab labels', () => {
    for (const label of [
      'Details',
      'Blinds',
      'Ranking',
      'Entries',
      'Unions',
      'Tables',
      'Rewards',
    ]) {
      expect(TYPES).toContain(`label: '${label}'`);
    }
    expect(TYPES).not.toContain("label: 'Detail'");
    expect(TYPES).not.toContain("label: 'Satellites'");
  });

  it('keeps all seven tabs on the shared live tab contract', () => {
    for (const id of ['detail', 'blinds', 'ranking', 'entries', 'unions', 'tables', 'rewards']) {
      expect(PAGE).toContain(`activeTab === '${id}'`);
    }
    expect(PAGE).toContain('data-active-tab={activeTab}');
  });

  it('fills the complete tab rail instead of leaving a dead right side', () => {
    const rail = PREMIUM.slice(
      PREMIUM.indexOf('.tournament-details .details-tabs {'),
      PREMIUM.indexOf('.tournament-details .details-tabs .tab.active')
    );
    expect(rail).toContain('display: flex');
    expect(rail).toContain('flex-wrap: wrap');
    expect(rail).toMatch(/flex:\s*1 1 110px/);
    expect(rail).not.toMatch(/width:\s*(?:fit-content|max-content)/);
  });

  it('uses the approved Club Arena chassis and hardware assets instead of a CSS imitation', () => {
    expect(PREMIUM).toContain('lobby-command-chassis-v2.png');
    expect(PREMIUM).toContain('club-nav-shell.webp');
    expect(PREMIUM).toContain('action-primary-shell.webp');
  });

  it('keeps every tab vertically scrollable inside the fixed chassis', () => {
    /**
     * THE SCROLLER MOVED UP ONE ELEMENT (2026-08-30), and the guarantee this
     * case exists to defend is unchanged: every tab scrolls.
     *
     * It used to require `.details-content > *` to be the scroller, on the
     * theory that a tab wanting two independently scrolling regions could
     * still have them. In practice that asks eight separate tab stylesheets
     * to get the same four-property incantation right, and eight of eight
     * got it wrong in three different ways: `.dov-info--band` set
     * `overflow: hidden` on the very element carrying the scroller and, being
     * imported later, won; `.dov`, `.blinds-tab` and `.rw` are flex columns
     * that shrink rather than overflow, so there was never anything to
     * scroll; and `.rk-list` / `.et-scroll` capped themselves against `vh`
     * while rendered inside a 75dvh modal sheet. The contract passed the
     * whole time. Every tab was still broken.
     *
     * One scroller, owned by the chassis, cannot be got wrong by a tab that
     * forgets — so that is what is pinned now.
     */
    const css = read('src/pages/tournament/TournamentDetails.css');
    expect(css).toMatch(/\.details-content\s*{[^}]*overflow-y:\s*auto/s);

    // The two properties without which `overflow-y: auto` scrolls nothing:
    // a flex child defaults to `min-height: auto` and refuses to shrink below
    // its content, so the box grows instead of scrolling.
    expect(css).toMatch(/\.details-content\s*{[^}]*min-height:\s*0/s);
    expect(css).toMatch(/\.details-content\s*{[^}]*flex:\s*1 1 auto/s);

    // And the chassis must not hand the scroll back to the children it just
    // took it from — that is the exact arrangement that failed above.
    expect(css).not.toMatch(/\.details-content\s*>\s*\*\s*{[^}]*overflow-y:\s*auto/s);
  });

  it('keeps dynamic blue, green and red action states in the machine footer', () => {
    expect(PREMIUM).toContain('.details-footer .btn-register');
    expect(PREMIUM).toContain('.details-footer .btn-unregister');
    expect(PREMIUM).toContain('.details-footer .tournament-status-badge.running');
  });
});

describe('approved premium cash-table machine contract', () => {
  it('scopes the premium machine to cash lobbies', () => {
    expect(GAME_PANEL).toContain("className={`glp${isCash ? ' glp--cash' : ''}`}");
    expect(GAME_PANEL).toContain('className="glp__arena-card"');
    expect(GAME_PANEL).toContain('arenaGameCardDataFromEntry(entry)');
    expect(GAME_PREMIUM).toContain('lobby-command-chassis-v2.png');
    expect(GAME_PREMIUM).toContain('.glp--cash .glp__arena-card');
  });

  it('retains real join and observe actions', () => {
    // Gate 6 (2026-09-05): a game says Join Game, a manual table Join Table.
    expect(GAME_PANEL).toContain("label: game ? 'Join Game' : 'Join Table'");
    expect(GAME_PANEL).toContain('onJoinTable(entry.id)');
    expect(GAME_PANEL).toContain('to={`/table/${entry.id}`}');
    expect(GAME_PANEL).toContain('Observe Table');
  });

  it('keeps the table machine vertically scrollable', () => {
    expect(read('src/components/lobby/GameLobbyPanel.css')).toMatch(
      /\.glp__scroll\s*{[^}]*overflow-y:\s*auto/s
    );
    expect(GAME_PREMIUM).toContain('.glp--cash .glp__scroll::-webkit-scrollbar-thumb');
  });
});
