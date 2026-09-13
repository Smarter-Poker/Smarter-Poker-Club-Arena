/**
 * ONE FIX ON ONE OF THREE RENDERERS IS NOT A FIX.
 *
 * The arena's stake ladder is listed while funded play is closed, and the
 * buy-in door refuses every seat. The first pass at this taught the mobile
 * game card to say so and was verified on the card view. The lobby has three
 * join controls, and the live page was rendering a different one: the row list
 * still offered Join Table on all seventeen tables, and the pre-commit panel
 * still opened with a Join action behind it.
 *
 * That is the shape of this whole class of bug, and it is why these pins name
 * all three surfaces rather than the one that happened to be on screen.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { sliceStatement } from '../helpers/sourceWindow';

const read = (p: string) => readFileSync(join(__dirname, '..', '..', p), 'utf8');
const card = read('src/components/lobby/game-cards/ArenaLobbyGameCard.tsx');
const rows = read('src/components/lobby/LobbyTable.tsx');
const panel = read('src/components/lobby/GameLobbyPanel.tsx');
const page = read('src/pages/ClubHomePage.tsx');
const ctx = read('src/components/lobby/lobbyCardContext.ts');

describe('Every join control honours a closed arena', () => {
  it('the game card checks it before offering a seat', () => {
    const at = card.indexOf('ctx.seatsClosedLabel');
    const join = card.indexOf("primaryLabel: game ? 'Join Game' : 'Join Table'");
    expect(at, 'the card lost its closed branch').toBeGreaterThan(-1);
    expect(join).toBeGreaterThan(at);
  });

  it('the row list checks it, and still lets a seated player return', () => {
    const at = rows.indexOf('ctx.seatsClosedLabel');
    expect(at, 'the row list lost its closed branch').toBeGreaterThan(-1);
    expect(rows).toContain('ctx.seatsClosedLabel && !seated');
    expect(rows).toContain('!(ctx.seatsClosedLabel && !seated)');
  });

  it('the pre-commit panel checks it before its Join action', () => {
    const at = panel.indexOf('if (seatsClosedLabel)');
    const join = panel.indexOf("label: game ? 'Join Game' : 'Join Table'");
    expect(at, 'the panel lost its closed branch').toBeGreaterThan(-1);
    expect(join).toBeGreaterThan(at);
  });

  it('the panel recomputes when the label changes', () => {
    expect(panel).toMatch(/\}, \[\s*seatsClosedLabel,/);
  });

  it('the page supplies it to every one of them, and only for a closed arena', () => {
    expect(page).toContain('seatsClosedLabel: arenaSeatsClosedLabel');
    expect(page).toContain('seatsClosedLabel={arenaSeatsClosedLabel}');
    const decl = sliceStatement(page, 'const arenaSeatsClosedLabel =');
    expect(decl).toContain('isAutomaticArena');
    expect(decl).toContain('cashGamesEnabled !== true');
    expect(decl).toContain('undefined');
  });

  it('is optional on the shared context, so no chip surface changes', () => {
    expect(ctx).toContain('seatsClosedLabel?: string');
  });
});
