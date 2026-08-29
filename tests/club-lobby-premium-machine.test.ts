import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(__dirname, '..');
const PAGE = readFileSync(resolve(ROOT, 'src/pages/ClubHomePage.tsx'), 'utf8');
const TOP = readFileSync(resolve(ROOT, 'src/components/lobby/ClubLobbyCommandTop.tsx'), 'utf8');
const CSS = readFileSync(resolve(ROOT, 'src/components/lobby/ClubLobbyCommandTop.css'), 'utf8');
const TABLE_CSS = readFileSync(resolve(ROOT, 'src/components/lobby/LobbyTable.css'), 'utf8');

describe('premium single-frame club lobby', () => {
  it('mounts the approved reference chassis around both the command top and game results', () => {
    const machine = PAGE.indexOf('className="club-lobby-machine"');
    const chassis = PAGE.indexOf('src={CLUB_LOBBY_CHASSIS}', machine);
    const commandTop = PAGE.indexOf('<ClubLobbyCommandTop', machine);
    const results = PAGE.indexOf('className="club-home__games club-home__games--v2"', machine);

    expect(machine).toBeGreaterThan(-1);
    expect(chassis).toBeGreaterThan(machine);
    expect(commandTop).toBeGreaterThan(chassis);
    expect(results).toBeGreaterThan(commandTop);
    expect(TOP).not.toContain('club-lobby-command-top__chassis');
  });

  it('resolves premium artwork through the deployed Club Arena base path', () => {
    expect(PAGE).toContain(
      'const CLUB_LOBBY_ASSET_ROOT = `${import.meta.env.BASE_URL}assets/club-buttons/lobby`'
    );
    expect(PAGE).toContain('src={CLUB_LOBBY_CHASSIS}');
    expect(PAGE).toContain('lobby-approved-desktop-reference-v3.png');
    expect(PAGE).toContain('src={club.banner_url || CLUB_LOBBY_CAMPAIGN}');
    expect(PAGE).not.toContain('src="/assets/club-buttons/lobby/');
    expect(PAGE).not.toContain("'/assets/club-buttons/lobby/");
  });

  it('uses the full native artwork ratio and maps every live region to its own bay', () => {
    expect(CSS).toContain('aspect-ratio: 734 / 977');
    expect(CSS).toContain('734px');
    expect(CSS).toMatch(/club-lobby-command-top__welcome\s*\{[^}]*inset:\s*2\.35%/s);
    expect(CSS).toMatch(/club-lobby-command-top__welcome\s*\{[^}]*5\.15%/s);
    expect(CSS).toMatch(/club-lobby-command-top__controls\s*\{[^}]*inset:\s*15\.35%/s);
    expect(CSS).toMatch(/club-lobby-command-top__campaign\s*\{[^}]*inset:\s*28\.25%/s);
    expect(CSS).toMatch(
      /club-lobby-machine\s*>\s*\.club-home__games--v2\s*\{[^}]*inset:\s*39\.2%/s
    );
  });

  it('uses one dynamic premium header for every club without a Shark-only branch', () => {
    expect(PAGE).not.toContain('exactDesktopWelcome=');
    expect(PAGE).not.toContain("toLocaleLowerCase() === 'shark club'");
    expect(TOP).not.toContain('exactDesktopWelcome');
    expect(TOP).toContain('club-lobby-command-top__welcome--approved-universal');
    expect(CSS).toContain('lobby-header-frame-universal-v4.png');
    expect(CSS).toMatch(
      /@media \(min-width: 901px\)[\s\S]*?club-lobby-command-top__welcome--approved-universal \{[^}]*inset: 0 0 auto[^}]*height: 15\.35%[^}]*background: var\(--machine-header-frame\)/s
    );
    expect(CSS).toMatch(
      /@media \(max-width: 900px\)[\s\S]*?club-lobby-command-top__welcome--approved-universal \{[^}]*aspect-ratio: 734 \/ 150[^}]*background: var\(--machine-header-frame\)/s
    );
    expect(CSS).toMatch(
      /club-lobby-command-top__welcome--approved-universal::before \{[^}]*inset: 0 auto 0 0[^}]*width: 2px[^}]*background: #000/s
    );
    expect(CSS).not.toMatch(/approved-universal[^}]*opacity:\s*0/s);
  });

  it('keeps the bottom medallion above the scrolling tournament ledger', () => {
    expect(CSS).toContain('--machine-approved-chassis');
    expect(CSS).toMatch(/\.club-lobby-machine::after \{[^}]*z-index: 7/s);
    expect(CSS).toMatch(/\.club-lobby-machine::after \{[^}]*bottom: 0/s);
    expect(CSS).toMatch(/\.club-lobby-machine::after \{[^}]*-328px -901px \/ 734px 977px/s);
    expect(CSS).toMatch(/club-lobby-machine\s*>\s*\.club-home__games--v2\s*\{[^}]*z-index:\s*2/s);
  });

  it('uses the real campaign art without stretching it and keeps the desktop ledger mechanical', () => {
    const campaignImage = CSS.slice(CSS.indexOf('.club-lobby-command-top__campaign-button img'));
    expect(campaignImage).toContain('object-fit: cover');
    expect(campaignImage).not.toContain('object-fit: fill');
    expect(campaignImage).not.toContain('scaleY(');
    expect(CSS).toContain('.club-lobby-machine .lobby-table .lt-status');
    expect(CSS).toContain('.club-lobby-machine .lobby-table td.lt-col-name::before');
    expect(CSS).toContain('.club-lobby-machine .lobby-table--mtt .lt-col-tstack');
  });

  it('renders selector faces extracted directly from the approved reference', () => {
    expect(CSS).toContain('lobby-selector-default-v3.png');
    expect(CSS).toContain('lobby-selector-active-v3.png');
    expect(CSS).toContain('lobby-preference-default-v3.png');
    expect(CSS).toContain('lobby-preference-active-v3.png');
    expect(CSS).toContain('lobby-filter-default-v3.png');
    expect(CSS).toMatch(
      /\.lobby-controls \.game-bar__type,[\s\S]*?var\(--machine-selector-default\)/
    );
    expect(CSS).toMatch(/\.game-bar__type\.is-active,[\s\S]*?var\(--machine-selector-active\)/);
    expect(CSS).not.toContain('--machine-nav-shell');
  });

  it('has a dedicated connected mobile console with accessible controls', () => {
    const mobile = CSS.slice(CSS.indexOf('@media (max-width: 900px)'));

    expect(mobile).toContain('.club-lobby-machine__chassis');
    expect(mobile).toMatch(/\.club-lobby-machine__chassis\s*\{\s*display:\s*none/s);
    expect(mobile).toContain('border-image-source: var(--machine-header-frame)');
    expect(mobile).toContain('border-image-source: var(--machine-controls-frame)');
    expect(mobile).toContain('border-image-source: var(--machine-campaign-frame)');
    expect(mobile).toMatch(/\.game-bar\s*\{[^}]*grid-template-columns:\s*repeat\(4,/s);
    expect(mobile).toMatch(
      /\.game-bar__type,[\s\S]*?\.quickprefs__chip\s*\{[^}]*min-height:\s*44px/s
    );
    expect(mobile).toMatch(
      /\.club-lobby-command-top::before\s*\{[^}]*left:\s*0[^}]*width:\s*1px[^}]*background:\s*#000/s
    );
  });

  it('uses the approved campaign directly without adding an unapproved nested frame', () => {
    expect(CSS).toMatch(/\.club-lobby-command-top__campaign-button\s*\{[^}]*background:\s*#000/s);
    expect(CSS).toMatch(
      /\.club-lobby-command-top__campaign-button img\s*\{[^}]*object-fit:\s*cover/s
    );
  });

  it('keeps every reference-derived runtime asset present', () => {
    const lobbyAssets = resolve(ROOT, 'public/assets/club-buttons/lobby');
    for (const file of [
      'lobby-approved-desktop-reference-v3.png',
      'lobby-header-frame-v3.png',
      'lobby-header-frame-universal-v4.png',
      'lobby-controls-frame-v3.png',
      'lobby-campaign-frame-v3.png',
      'lobby-selector-default-v3.png',
      'lobby-selector-active-v3.png',
      'lobby-preference-default-v3.png',
      'lobby-preference-active-v3.png',
      'lobby-filter-default-v3.png',
    ]) {
      expect(existsSync(resolve(lobbyAssets, file)), file).toBe(true);
    }
  });

  it('keeps the premium V2 card renderer through tablet widths', () => {
    expect(TABLE_CSS).toMatch(
      /@media \(max-width: 900px\) \{\s*\.arena-lobby-card-list\s*\{[^}]*display:\s*grid/s
    );
    expect(TABLE_CSS).toMatch(
      /\.arena-lobby-card-list \+ \.lobby-table-wrap\s*\{\s*display:\s*none/s
    );
  });
});
