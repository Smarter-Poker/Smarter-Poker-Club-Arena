import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const REWARD_PAGES = [
  'src/pages/PlayerWalletPage.tsx',
  'src/pages/TransactionHistoryPage.tsx',
  'src/pages/VIPPage.tsx',
  'src/pages/RakebackPage.tsx',
  'src/pages/PromotionsPage.tsx',
  'src/pages/BonusPage.tsx',
  'src/pages/AchievementsPage.tsx',
  'src/pages/DailyChallengesPage.tsx',
  'src/pages/MarketplacePage.tsx',
];

const PLAY_PAGES = [
  'src/pages/tournament/TournamentLobbyPage.tsx',
  'src/pages/tournament/TournamentResultsPage.tsx',
  'src/pages/HandHistoryPage.tsx',
  'src/pages/SessionHistoryPage.tsx',
  'src/pages/LeaderboardPage.tsx',
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

  it.each(UNION_PAGES)('%s uses the Union Network visual anchor', (path) => {
    const source = readFileSync(path, 'utf8');
    expect(source).toContain('CasinoSurfaceHeader');
    expect(source).toContain('wallet-union-bank-v1.webp');
  });

  it('resolves cinematic artwork through the deploy- and CDN-aware media base', () => {
    const header = readFileSync('src/components/rewards/RewardsSurfaceHeader.tsx', 'utf8');
    const account = readFileSync('src/components/account/AccountSurfaceHeader.tsx', 'utf8');
    const community = readFileSync('src/components/community/CommunitySurfaceHeader.tsx', 'utf8');
    const workspaces = readFileSync('src/pages/workspaces/ArenaWorkspacePages.tsx', 'utf8');

    for (const source of [header, account, community, workspaces]) {
      expect(source).toContain('mediaUrl(');
    }
    for (const path of [
      'public/assets/club-buttons/wallets/desktop/wallet-diamonds-v1.webp',
      'public/assets/club-buttons/lobby/shark-club-championship-ad-v2.png',
      'public/images/community/community-network-v1.webp',
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
