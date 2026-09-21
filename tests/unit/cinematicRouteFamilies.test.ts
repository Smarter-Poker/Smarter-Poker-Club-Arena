import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import sharp from 'sharp';
import { readDailyChallengesUnit } from '../helpers/dailyChallengesSources';

const REWARD_PAGES = [
  'src/pages/PlayerWalletPage.tsx',
  'src/pages/TransactionHistoryPage.tsx',
  'src/pages/VIPPage.tsx',
  'src/pages/RakebackPage.tsx',
  'src/pages/PromotionsPage.tsx',
  'src/pages/DailyBonusPage.tsx',
  'src/pages/AchievementsPage.tsx',
  'src/pages/MarketplacePage.tsx',
];

const PLAY_PAGES = [
  'src/pages/tournament/TournamentLobbyPage.tsx',
  'src/pages/tournament/TournamentResultsPage.tsx',
  'src/pages/HandHistoryPage.tsx',
  'src/pages/SessionHistoryPage.tsx',
];

const UNION_PAGES = [
  'src/pages/CreateUnionPage.tsx',
  'src/pages/UnionDetailPage.tsx',
  'src/pages/UnionGamesPage.tsx',
  'src/pages/UnionStatementsPage.tsx',
  'src/pages/UnionDashboardPage.tsx',
];

describe('cinematic retained route families', () => {
  it.each(REWARD_PAGES)('%s uses the live Rewards Circuit visual anchor', (path) => {
    expect(readFileSync(path, 'utf8')).toContain('RewardsSurfaceHeader');
  });

  it.each(PLAY_PAGES)('%s uses the Play & Review visual anchor', (path) => {
    const source = readFileSync(path, 'utf8');
    expect(source).toContain('CasinoSurfaceHeader');
    expect(source).toContain('data-arena-surface="play"');
  });

  it('uses the user-approved painted console for championship leaderboards', () => {
    // Dan explicitly approved replacing the protected Championship Deck design.
    const source = readFileSync('src/pages/LeaderboardPage.tsx', 'utf8');
    expect(source).toContain('data-arena-surface="leaderboard-console"');
    expect(source).toContain('<SpadeConsole');
    expect(source).toContain('eyebrow="Club Arena"');
    expect(source).not.toContain('className="lb-hero"');
    expect(existsSync('public/assets/club-buttons/console/spade-console-v1/top.png')).toBe(true);
  });

  it('preserves the mission-native Daily Challenges visual authority', () => {
    const source = readFileSync('src/pages/DailyChallengesPage.tsx', 'utf8');
    expect(source).toContain('data-arena-surface="missions"');
    expect(readDailyChallengesUnit('MissionHero.tsx')).toContain('className={styles.hero}');
    const presentation = readDailyChallengesUnit('missionPresentation.ts');
    expect(presentation).toContain('Club Arena / Daily Challenge Vault');
    expect(presentation).toContain('Club Arena / Weekly Challenge Circuit');
    expect(presentation).toContain('Club Arena / Monthly High-Roller Ledger');
    expect(presentation).toContain("'images/challenges/daily-missions-casino-v2.webp'");
    expect(presentation).toContain("'images/challenges/daily-missions-casino-v2-mobile.webp'");
    expect(presentation).toContain("'images/challenges/daily-missions-reward-pedestal-v1.webp'");
    expect(presentation).toContain("'images/challenges/daily-missions-streak-freeze-v1.webp'");
    expect(presentation).toContain("'images/challenges/daily-missions-diamond-96-v1.webp'");
    expect(existsSync('public/images/challenges/daily-missions-casino-v2.webp')).toBe(true);
    expect(existsSync('public/images/challenges/daily-missions-casino-v2-mobile.webp')).toBe(true);
    expect(existsSync('public/images/challenges/daily-missions-reward-pedestal-v1.webp')).toBe(
      true
    );
    expect(existsSync('public/images/challenges/daily-missions-streak-freeze-v1.webp')).toBe(true);
    expect(existsSync('public/images/challenges/daily-missions-diamond-96-v1.webp')).toBe(true);
  });

  it('ships the transparent Daily Missions instrument artwork at its certified dimensions', async () => {
    const diamond = await sharp(
      'public/images/challenges/daily-missions-diamond-96-v1.webp'
    ).metadata();
    const freeze = await sharp(
      'public/images/challenges/daily-missions-streak-freeze-v1.webp'
    ).metadata();

    expect(diamond).toMatchObject({ width: 96, height: 96, hasAlpha: true });
    expect(freeze).toMatchObject({ width: 720, height: 720, hasAlpha: true });
  });

  it('uses a native-ratio text-free Challenge Vault render at the primary lobby door', async () => {
    const config = readFileSync('src/config/lobbyTiles.config.ts', 'utf8');
    const home = readFileSync('src/pages/HomePage.tsx', 'utf8');
    const homeCss = readFileSync('src/pages/HomePage.module.css', 'utf8');
    const tile = await sharp('public/images/tiles/daily-challenges-v9.webp').metadata();

    expect(tile).toMatchObject({ width: 1024, height: 1536, hasAlpha: false });
    expect(config).toContain('images/tiles/daily-challenges-v9.webp');
    expect(config).not.toContain('images/tiles/daily-challenges-v8.jpg');
    expect(config).toContain("portalStatus: 'Open Challenge Vault'");
    expect(home).toContain('width={tile.width || 640}');
    expect(home).toContain('height={tile.height || 1024}');
    expect(home).toContain('tile.preserveNativeRatio ? styles.tileImageNative');
    expect(homeCss).toMatch(/\.tileImageNative\s*\{[^}]*object-fit:\s*contain/s);
  });

  it.each(UNION_PAGES)('%s uses the Union Network visual anchor', (path) => {
    const source = readFileSync(path, 'utf8');
    expect(source).toContain('CasinoSurfaceHeader');
    expect(source).toContain('wallet-union-bank-v1.webp');
  });

  it('resolves cinematic artwork through the deploy- and CDN-aware media base', () => {
    // The Rewards header prints on the spade console (#ClubArenaConsole,
    // 2026-09-09) and carries no art of its own, so it left this list.
    const account = readFileSync('src/components/account/AccountSurfaceHeader.tsx', 'utf8');
    const community = readFileSync('src/components/community/CommunitySurfaceHeader.tsx', 'utf8');
    const workspaces = readFileSync('src/pages/workspaces/ArenaWorkspacePages.tsx', 'utf8');
    const missions = readFileSync('src/pages/DailyChallengesPage.tsx', 'utf8');

    for (const source of [account, community, workspaces, missions]) {
      expect(source).toContain('mediaUrl(');
    }
    for (const path of [
      'public/assets/club-buttons/wallets/desktop/wallet-diamonds-v1.webp',
      'public/assets/club-buttons/lobby/shark-club-championship-ad-v2.png',
      'public/images/community/community-network-v1.webp',
      'public/images/challenges/daily-missions-casino-v2.webp',
      'public/images/challenges/daily-missions-casino-v2-mobile.webp',
      'public/images/challenges/daily-missions-reward-pedestal-v1.webp',
      'public/images/challenges/daily-missions-streak-freeze-v1.webp',
      'public/images/challenges/daily-missions-diamond-96-v1.webp',
      'public/images/bg-vault.jpg',
    ]) {
      expect(existsSync(path), `${path} must ship with the build`).toBe(true);
    }
  });

  it('separates tournament results from the fixed tournament-details shell', () => {
    const results = readFileSync('src/pages/tournament/TournamentResultsPage.tsx', 'utf8');
    expect(results).toContain('className="tournament-results-page"');
    expect(results).not.toContain('className="tournament-details"');
  });

  it('renders a union avatar image instead of exposing its URL as text', () => {
    const detail = readFileSync('src/pages/UnionDetailPage.tsx', 'utf8');
    expect(detail).toContain('union.avatarUrl ? <img src={union.avatarUrl}');
    expect(detail).not.toContain('{union.avatarUrl || union.name.charAt(0)}');
  });
});
