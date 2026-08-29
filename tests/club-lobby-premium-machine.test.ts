import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(__dirname, '..');
const PAGE = readFileSync(resolve(ROOT, 'src/pages/ClubHomePage.tsx'), 'utf8');
const TOP = readFileSync(resolve(ROOT, 'src/components/lobby/ClubLobbyCommandTop.tsx'), 'utf8');
const CSS = readFileSync(resolve(ROOT, 'src/components/lobby/ClubLobbyCommandTop.css'), 'utf8');
const TABLE_CSS = readFileSync(resolve(ROOT, 'src/components/lobby/LobbyTable.css'), 'utf8');

describe('premium single-frame club lobby', () => {
  it('mounts the approved generated chassis around both the command top and game results', () => {
    const machine = PAGE.indexOf('className="club-lobby-machine"');
    const chassis = PAGE.indexOf('lobby-command-chassis-v2.png', machine);
    const commandTop = PAGE.indexOf('<ClubLobbyCommandTop', machine);
    const results = PAGE.indexOf('className="club-home__games club-home__games--v2"', machine);

    expect(machine).toBeGreaterThan(-1);
    expect(chassis).toBeGreaterThan(machine);
    expect(commandTop).toBeGreaterThan(chassis);
    expect(results).toBeGreaterThan(commandTop);
    expect(TOP).not.toContain('club-lobby-command-top__chassis');
  });

  it('uses the full native artwork ratio and maps every live region to its own bay', () => {
    expect(CSS).toContain('aspect-ratio: 1086 / 1448');
    expect(CSS).toMatch(/club-lobby-command-top__welcome\s*\{[^}]*inset:\s*2\.35%/s);
    expect(CSS).toMatch(/club-lobby-command-top__controls\s*\{[^}]*inset:\s*15\.25%/s);
    expect(CSS).toMatch(/club-lobby-command-top__campaign\s*\{[^}]*inset:\s*28\.1%/s);
    expect(CSS).toMatch(
      /club-lobby-machine\s*>\s*\.club-home__games--v2\s*\{[^}]*inset:\s*40\.25%/s
    );
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

  it('keeps the premium V2 card renderer through tablet widths', () => {
    expect(TABLE_CSS).toMatch(
      /@media \(max-width: 900px\) \{\s*\.arena-lobby-card-list\s*\{[^}]*display:\s*grid/s
    );
    expect(TABLE_CSS).toMatch(
      /\.arena-lobby-card-list \+ \.lobby-table-wrap\s*\{\s*display:\s*none/s
    );
  });
});
