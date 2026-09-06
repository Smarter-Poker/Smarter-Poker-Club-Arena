import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(__dirname, '../..');
const lobbyCss = readFileSync(
  resolve(root, 'src/components/lobby/ClubLobbyCommandTop.css'),
  'utf8'
);
const rakeCss = readFileSync(
  resolve(root, 'src/components/club/RakeSnapshotPanel.module.css'),
  'utf8'
);

describe('mobile operator controls remain reachable', () => {
  it('ends the lobby cascade with real 44px selector buttons', () => {
    const finalMobileLock = lobbyCss.slice(lobbyCss.lastIndexOf('/* MOBILE FIND-YOUR-GAME LOCK'));
    expect(finalMobileLock).toMatch(
      /\.game-bar__type,[\s\S]*\.game-bar__filter-btn,[\s\S]*\.quickprefs__chip\s*\{[\s\S]*min-height:\s*44px;[\s\S]*height:\s*44px;/
    );
  });

  it('gives the rake scope, period, and export controls a 44px target', () => {
    expect(rakeCss).toMatch(
      /\.scope,[\s\S]*\.period,[\s\S]*\.exportBtn\s*\{[\s\S]*min-height:\s*44px;/
    );
  });
});
