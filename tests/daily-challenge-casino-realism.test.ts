import { readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const page = readFileSync(resolve(__dirname, '../src/pages/DailyChallengesPage.tsx'), 'utf8');
const css = readFileSync(resolve(__dirname, '../src/pages/DailyChallengesPage.module.css'), 'utf8');

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
    expect(css).toContain('.backButton:active');
    expect(css).toContain('transform: translateY(1px)');
    expect(css).toContain(':focus-visible');
    expect(css).toContain('.buyFreezeBtn:disabled');
    expect(css).toContain('@media (prefers-reduced-motion: reduce)');
  });

  it('keeps the mobile hero compact and the ledger directly reachable', () => {
    const mobile = css.slice(css.lastIndexOf('@media (max-width: 680px)'));
    expect(mobile).toContain('min-height: 548px');
    expect(mobile).not.toMatch(/min-height:\s*(?:6\d\d|[7-9]\d\d)px/);
    expect(page).toContain('View Challenge Ledger');
    expect(page).toContain("document.getElementById('mission-board-title')?.scrollIntoView");
  });

  it('keeps server-clock labels in the English Title Case contract in every locale', () => {
    expect(page.match(/new Intl\.DateTimeFormat\('en-US'/g)).toHaveLength(2);
    expect(page).not.toContain('new Intl.DateTimeFormat(undefined');
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
