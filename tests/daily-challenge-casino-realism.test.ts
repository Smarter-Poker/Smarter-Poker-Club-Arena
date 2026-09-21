import { readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  readDailyChallengesStylesheet,
  readDailyChallengesSurface,
  readDailyChallengesUnit,
} from './helpers/dailyChallengesSources';

const page = readFileSync(resolve(__dirname, '../src/pages/DailyChallengesPage.tsx'), 'utf8');
const surface = readDailyChallengesSurface();
const presentation = readDailyChallengesUnit('missionPresentation.ts');
const artwork = readDailyChallengesUnit('MissionArtwork.tsx');
const loadingState = readDailyChallengesUnit('MissionLoadingState.tsx');
const freezeDialog = readDailyChallengesUnit('MissionFreezePurchaseDialog.tsx');
const rewardDialog = readDailyChallengesUnit('MissionRewardSettlementDialog.tsx');
const css = readDailyChallengesStylesheet();
const routeFallback = readFileSync(
  resolve(__dirname, '../src/components/challenges/DailyChallengesRouteFallback.tsx'),
  'utf8'
);
const routeFallbackCss = readFileSync(
  resolve(__dirname, '../src/components/challenges/DailyChallengesRouteFallback.module.css'),
  'utf8'
);
const preloader = readFileSync(resolve(__dirname, '../src/utils/ChunkPreloader.ts'), 'utf8');

describe('Daily Challenges Smarter Casino Realism surface', () => {
  it('ships responsive cinematic artwork and a physical reward object', () => {
    for (const asset of [
      'daily-missions-casino-v2.webp',
      'daily-missions-casino-v2-mobile.webp',
      'daily-missions-reward-pedestal-v1.webp',
      'daily-missions-streak-freeze-v1.webp',
    ]) {
      const path = resolve(__dirname, `../public/images/challenges/${asset}`);
      expect(statSync(path).size).toBeGreaterThan(10_000);
      expect(statSync(path).size).toBeLessThan(200_000);
      expect(presentation).toContain(asset);
    }
    expect(artwork).toContain('className={styles.heroPicture} data-hero-cycle={tier}');
    expect(artwork).toContain('<picture>');
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
    expect(mobile).not.toContain('clip-path: none');
    expect(mobile).not.toContain('border-inline: 0');
    expect(page).toContain('View Challenge Ledger');
    expect(page).toContain("document.getElementById('mission-board-title')?.scrollIntoView");
  });

  it('keeps server-clock labels in the English Title Case contract in every locale', () => {
    expect(presentation.match(/new Intl\.DateTimeFormat\('en-US'/g)?.length).toBeGreaterThanOrEqual(
      3
    );
    expect(surface).not.toContain('new Intl.DateTimeFormat(undefined');
  });

  it('fails closed on a cold ledger error and renders freeze settlement truthfully', () => {
    expect(page).toContain('if (loadError && lastSyncedAt === null)');
    expect(page).toContain('<MissionUnavailableState');
    expect(page).toContain('Streak Freeze Applied');
    expect(page).toContain('streak.usedFreeze && streak.lastFrozenDate');
    expect(page).toContain('<span className={styles.srOnly}>Diamonds</span>');
    expect(page).toContain('{DAILY_MISSION_REROLL_COST} Diamond? Current Progress Will Be');
    expect(page).toContain('Replaced.');
    expect(css).not.toMatch(/\.cardClaimed\s*\{[^}]*opacity:/s);
    const claimedCardRules = [
      ...css.matchAll(/\.challengeCard\[data-mission-state='claimed'\]\s*\{([^}]*)\}/g),
    ];
    expect(claimedCardRules.length).toBeGreaterThan(0);
    expect(claimedCardRules.at(-1)?.[1]).not.toMatch(/(?:filter|opacity)\s*:/);
  });

  it('warms the exact mission destination chunk on mouse, touch, and keyboard intent', () => {
    expect(page).toContain('{...prefetchIntent(missionAction.path)}');
    expect(preloader).toContain(
      "'/tournaments': () => import('../pages/tournament/TournamentLobbyPage')"
    );
  });

  it('keeps cold-error recovery above the fold and animates only enabled intent surfaces', () => {
    const finalUnavailableRule = css.slice(css.lastIndexOf('.unavailableHero'));
    expect(finalUnavailableRule).toContain('min-height: 420px');
    expect(css).not.toContain(':hover');
    expect(css).toContain('.challengeCard:focus-within .iconBox');
    expect(css).toContain('.buyFreezeBtn:not(:disabled):active');
    expect(css).toContain('.rerollButton:not(:disabled):active');
  });

  it('closes every chamfer and gives each mission icon live progress and state', () => {
    expect(page.match(/className=\{styles\.bevelFrame\}/g)?.length).toBeGreaterThanOrEqual(7);
    expect(css).toContain('Precision Frame Closure');
    expect(css).toContain('100% 100% / var(--bevel-size) var(--bevel-size) no-repeat');
    expect(css).toContain('.rerollButton::after');
    expect(page).toContain("'--mission-progress': `${pct}%`");
    expect(page).toContain('data-mission-icon={c.type}');
    expect(page).toContain('data-icon-state=');
    expect(page).toContain('<MissionInstrumentGlyph');
    expect(page).toContain('<CasinoControlIcon');
    expect(css).toContain('conic-gradient(');
    expect(css).toContain('@keyframes missionScannerOrbit');
    expect(css).toContain(".iconAssembly[data-mission-icon='friends_added']");
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\)[\s\S]*\.iconOrbit/);
  });

  it('gives every cycle a distinct physical instrument and every loading card a closed chassis', () => {
    expect(presentation).toContain("daily: 'cycle-daily'");
    expect(presentation).toContain("weekly: 'cycle-weekly'");
    expect(presentation).toContain("monthly: 'cycle-monthly'");
    expect(page).toContain('variant={TIER_CONTROL_ICONS[tier]}');
    expect(loadingState).toContain('data-loading-mission-card=""');
    expect(loadingState).toContain('className={styles.loadingCardInstrument}');
    expect(css).toContain('.loadingCard > .bevelFrame');
    expect(css).toContain('.loadingCardAction');
  });

  it('keeps route fallbacks cinematic without eagerly loading the full mission-page stylesheet', () => {
    expect(routeFallback).toContain("from './DailyChallengesRouteFallback.module.css'");
    expect(routeFallback).not.toContain('DailyChallengesPage.module.css');
    expect(routeFallback).toContain('data-daily-missions-auth-loading=""');
    expect(routeFallback).toContain('data-daily-missions-crash-fallback=""');
    expect(routeFallbackCss.match(/linear-gradient\(/g)?.length).toBeGreaterThanOrEqual(12);
    expect(routeFallbackCss).toContain('100% 100% / var(--frame-size) var(--frame-size) no-repeat');
    expect(routeFallbackCss).toContain('@media (max-width: 680px)');
    expect(routeFallbackCss).toContain('@media (prefers-reduced-motion: reduce)');
    expect(routeFallbackCss).not.toContain(':hover');
  });

  it('uses only sanctioned danger and warm accents in the Daily Missions paint', () => {
    for (const retiredColor of [
      '#d3a855',
      '#d9ac58',
      '#ff765f',
      '#ff9d8b',
      '#ffb765',
      '#f08b3b',
      '#ff8f79',
      'rgba(108, 43, 10',
      'rgba(211, 168, 85',
    ]) {
      expect(`${page}${css}`).not.toContain(retiredColor);
    }
  });

  it('renders both purchase and reward dialogs as complete casino settlement surfaces', () => {
    expect(freezeDialog).toContain('Streak Protection Desk');
    expect(freezeDialog).toContain('Balance After Purchase');
    expect(rewardDialog).toContain('Reward Settled');
    expect(rewardDialog).toContain('Added To Your Club Arena Diamond Balance');
    expect(css).toContain('.freezePurchaseLedger');
    expect(css).toContain('.celebrateArtwork');
    expect(css).toContain('.freezeVaultArtwork');
  });
});
