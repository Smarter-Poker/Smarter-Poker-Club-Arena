import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const read = (path: string) => readFileSync(join(process.cwd(), path), 'utf8');

const PAGE = read('src/pages/tournament/TournamentDetails.tsx');
const TYPES = read('src/components/tournament/details/types.ts');
const SHELL = read('src/pages/tournament/TournamentDetails.css');
const GAME_PANEL = read('src/components/lobby/GameLobbyPanel.tsx');
const GAME_PREMIUM = read('src/components/lobby/PremiumGameLobbyPanel.css');

describe('tournament lobby shell contract', () => {
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

  /* THE CHASSIS IS GONE, AND THIS CONTRACT SAYS SO (Dan 2026-10-04).
   *
   * "remove all these large frames, and make it like a normal, 'industry
   * standard' tournament lobby card ... this whole display REALLY SUCKS and is
   * trash, it needs a 100% redesign."
   *
   * The two cases that stood here REQUIRED the frames: one pinned the tab
   * rail to `flex-wrap: wrap` with a 110px basis (two rows of framed tabs on
   * a phone), the other required lobby-command-chassis-v2.png,
   * club-nav-shell.webp and action-primary-shell.webp to be painted behind
   * the shell. Inside the in-game popup that stack left the tab panel 52px
   * tall at 375x667. They are replaced by the opposite pins, deliberately, in
   * the commit that replaces the behaviour (CLAUDE.md section 5 rule 8).
   */
  it('keeps the tab strip on ONE row that scrolls, so tabs never eat the content', () => {
    const rail = SHELL.slice(
      SHELL.indexOf('.details-tabs {'),
      SHELL.indexOf('.details-tabs::-webkit-scrollbar')
    );
    expect(rail).toContain('display: flex');
    expect(rail).toMatch(/overflow-x:\s*auto/);
    expect(rail).not.toMatch(/flex-wrap:\s*wrap/);
  });

  it('paints no artwork and no machined frame around the shell', () => {
    const code = SHELL.replace(/\/\*[\s\S]*?\*\//g, '');
    expect(code, 'the lobby shell must not load frame artwork').not.toMatch(/url\(/);
    expect(code, 'chamfered frames are drawn with clip-path').not.toMatch(/clip-path/);
    expect(PAGE).not.toContain('PremiumTournamentConsole');
    expect(() => read('src/pages/tournament/PremiumTournamentConsole.css')).toThrow();
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

  it('keeps the register, unregister and running states distinct in the footer', () => {
    expect(SHELL).toContain('.details-footer .btn-register');
    expect(SHELL).toContain('.details-footer .btn-unregister');
    expect(SHELL).toContain('.tournament-status-badge.running');
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
