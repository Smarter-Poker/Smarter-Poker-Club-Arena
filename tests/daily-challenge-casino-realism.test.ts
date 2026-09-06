import { readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const page = readFileSync(resolve(__dirname, '../src/pages/DailyChallengesPage.tsx'), 'utf8');
const css = readFileSync(resolve(__dirname, '../src/pages/DailyChallengesPage.module.css'), 'utf8');
const preloader = readFileSync(resolve(__dirname, '../src/utils/ChunkPreloader.ts'), 'utf8');

describe('Daily Challenges Smarter Casino Realism surface', () => {
  it('ships responsive cinematic artwork and a physical reward object', () => {
    for (const asset of [
      'daily-missions-casino-v2.webp',
      'daily-missions-casino-v2-mobile.webp',
      'daily-missions-reward-pedestal-v1.webp',
    ]) {
      const path = resolve(__dirname, `../public/images/challenges/${asset}`);
      expect(statSync(path).size).toBeGreaterThan(10_000);
      expect(statSync(path).size).toBeLessThan(200_000);
      expect(page).toContain(asset);
    }
    expect(page).toContain('<picture className={styles.heroPicture}');
  });

  it('uses the shared realism vocabulary instead of the retired matrix skin', () => {
    for (const token of [
      '--realism-obsidian',
      '--realism-carbon',
      '--realism-panel',
      '--realism-gunmetal',
      '--realism-chrome',
      '--realism-cyan',
      '--realism-gold',
    ]) {
      expect(css).toContain(token);
    }
    expect(css).not.toContain('bg_digital_matrix.jpg');
  });

  it('gives every control physical press, focus, disabled, and reduced-motion states', () => {
    expect(css).toContain('.backButton:not(:disabled):active');
    expect(css).toContain('transform: translateY(1px)');
    expect(css).toContain(':focus-visible');
    expect(css).toContain('.buyFreezeBtn:disabled');
    expect(css).toContain('@media (prefers-reduced-motion: reduce)');
  });

  it('keeps the mobile hero compact and the ledger directly reachable', () => {
    const realismStart = css.indexOf('SMARTER CASINO REALISM');
    const mobileStart = css.indexOf('@media (max-width: 680px)', realismStart);
    const mobileEnd = css.indexOf('@media (max-width: 420px)', mobileStart);
    const mobile = css.slice(mobileStart, mobileEnd);
    expect(mobile).toContain('min-height: 548px');
    expect(mobile).not.toMatch(/min-height:\s*(?:6\d\d|[7-9]\d\d)px/);
    expect(page).toContain('View Challenge Ledger');
    expect(page).toContain("document.getElementById('mission-board-title')?.scrollIntoView");
  });

  it('keeps server-clock labels in the English Title Case contract in every locale', () => {
    expect(page.match(/new Intl\.DateTimeFormat\('en-US'/g)?.length).toBeGreaterThanOrEqual(3);
    expect(page).not.toContain('new Intl.DateTimeFormat(undefined');
  });

  it('fails closed on a cold ledger error and renders freeze settlement truthfully', () => {
    expect(page).toContain('if (loadError && lastSyncedAt === null)');
    expect(page).toContain('<MissionUnavailableState');
    expect(page).toContain('Streak Freeze Applied');
    expect(page).toContain('streak.usedFreeze && streak.frozenDate');
    expect(page).toContain('<span className={styles.srOnly}>Diamonds</span>');
    expect(page).toContain('10 Diamonds? Current Progress Will Be Replaced.');
    expect(css).not.toMatch(/\.cardClaimed\s*\{[^}]*opacity:/s);
    const claimedState = css.slice(
      css.lastIndexOf(".challengeCard[data-mission-state='claimed']"),
      css.indexOf('.cardTopline', css.lastIndexOf(".challengeCard[data-mission-state='claimed']"))
    );
    expect(claimedState).not.toMatch(/(?:filter|opacity)\s*:/);
  });

  it('warms the exact mission destination chunk on mouse, touch, and keyboard intent', () => {
    expect(page).toContain('{...prefetchIntent(missionAction.path)}');
    expect(preloader).toContain(
      "'/tournaments': () => import('../pages/tournament/TournamentLobbyPage')"
    );
  });

  it('keeps cold-error recovery above the fold and disabled controls physically still', () => {
    const finalUnavailableRule = css.slice(css.lastIndexOf('.unavailableHero'));
    expect(finalUnavailableRule).toContain('min-height: 420px');
    expect(css).not.toContain(':hover');
    expect(css).toContain('.buyFreezeBtn:not(:disabled):active');
  });

  it('renders both purchase and reward dialogs as complete casino settlement surfaces', () => {
    expect(page).toContain('Streak Protection Desk');
    expect(page).toContain('Balance After Purchase');
    expect(page).toContain('Reward Settled');
    expect(page).toContain('Added To Your Club Arena Diamond Balance');
    expect(css).toContain('.freezePurchaseLedger');
    expect(css).toContain('.celebrateArtwork');
  });
});
