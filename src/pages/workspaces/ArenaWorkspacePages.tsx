import { Link, useParams } from 'react-router-dom';
import { getClubOperationGroups } from '../../config/clubOperationsNavigation';
import { useClubWorkspace } from '../../contexts/ClubWorkspaceContext';
import { mediaUrl } from '../../utils/mediaBase';
import styles from './ArenaWorkspacePages.module.css';

interface WorkspaceLink {
  label: string;
  description: string;
  path: string;
  signal?: string;
}

function WorkspacePage({
  eyebrow,
  title,
  description,
  art,
  links,
}: {
  eyebrow: string;
  title: string;
  description: string;
  art: string;
  links: WorkspaceLink[];
}) {
  return (
    <main className={styles.page}>
      <header className={styles.hero}>
        <div className={styles.heroCopy}>
          <span className={styles.eyebrow}>{eyebrow}</span>
          <h1>{title}</h1>
          <p>{description}</p>
          <span className={styles.liveLine}>
            <span aria-hidden="true" /> Live Systems Remain Authoritative
          </span>
        </div>
        <div className={styles.artFrame} aria-hidden="true">
          <img src={mediaUrl(art)} alt="" />
        </div>
      </header>

      <section className={styles.grid} aria-label={`${title} Tools`}>
        {links.map((item, index) => (
          <Link to={item.path} className={styles.card} key={item.path}>
            <span className={styles.index}>{String(index + 1).padStart(2, '0')}</span>
            <span className={styles.cardCopy}>
              <strong>{item.label}</strong>
              <span>{item.description}</span>
            </span>
            {item.signal && <span className={styles.signal}>{item.signal}</span>}
            <span className={styles.arrow} aria-hidden="true">
              ›
            </span>
          </Link>
        ))}
      </section>
    </main>
  );
}

export function RewardsWorkspacePage() {
  return (
    <WorkspacePage
      eyebrow="Player Value Circuit"
      title="Rewards Center"
      description="A Single Route Into Every Live Balance, Benefit, Offer, And Earned Milestone."
      art="assets/club-buttons/wallets/square/wallet-diamonds-square-v1.webp"
      links={[
        { label: 'Wallet', description: 'Balances, Transfers, And Ledger', path: '/wallet' },
        {
          label: 'Transactions',
          description: 'Complete Account Transaction History',
          path: '/transactions',
        },
        { label: 'VIP Status', description: 'Tier, Benefits, And Progress', path: '/vip' },
        { label: 'Rakeback', description: 'Current Rate And Payment History', path: '/rakeback' },
        { label: 'Promotions', description: 'Live And Upcoming Offers', path: '/promotions' },
        { label: 'Bonuses', description: 'Available Bonus Inventory', path: '/bonuses' },
        {
          label: 'Achievements',
          description: 'Milestones, Badges, And Unlock Progress',
          path: '/achievements',
        },
        { label: 'Challenges', description: 'Daily Objectives And Progress', path: '/challenges' },
        {
          label: 'Marketplace',
          description: 'Diamonds, Membership, Cosmetics, And Owned Items',
          path: '/marketplace',
        },
      ]}
    />
  );
}

export function CommunityWorkspacePage() {
  return (
    <WorkspacePage
      eyebrow="Community Network"
      title="Community Center"
      description="Discover Players And Clubs, Manage Trusted Connections, Follow Shared Activity, And Move Into Conversation From One Network Map."
      art="images/community/community-network-v1.webp"
      links={[
        {
          label: 'Discover',
          description: 'Search Live Players, Clubs, Tables, And Tournaments',
          path: '/search',
          signal: 'Live',
        },
        {
          label: 'Friends',
          description: 'Trusted Connections, Presence, And Direct Actions',
          path: '/friends',
        },
        {
          label: 'Requests',
          description: 'Review Incoming Connection Requests',
          path: '/friends?tab=requests',
        },
        {
          label: 'Activity',
          description: 'Shared Achievements, Hands, And Network Discovery',
          path: '/friends?tab=activity',
        },
        {
          label: 'Challenges',
          description: 'Head-To-Head Social Missions And Progress',
          path: '/friends?tab=challenges',
        },
        {
          label: 'Messages',
          description: 'Continue In Smarter.Poker Messenger',
          path: '/messages',
        },
        {
          label: 'Union Network',
          description: 'Browse And Operate Connected Club Networks',
          path: '/unions',
        },
      ]}
    />
  );
}

export function PlayWorkspacePage() {
  return (
    <WorkspacePage
      eyebrow="Poker Command Circuit"
      title="Play & Review"
      description="Move From Live Competition Into Results, Hands, Sessions, And Rankings Without Crossing Disconnected History Surfaces."
      art="assets/club-buttons/lobby/shark-club-championship-ad-v2.png"
      links={[
        {
          label: 'Tournaments',
          description: 'Scheduled, Registering, And Live Events',
          path: '/tournaments',
          signal: 'Live',
        },
        {
          label: 'Tournament Results',
          description: 'Finishes, Prizes, And Completed Fields',
          path: '/tournament-results',
        },
        {
          label: 'My Spin Results',
          description: 'Your Spin Finishes And Prizes',
          path: '/tournament-results?filter=mine&type=spin',
        },
        {
          label: 'Hand History',
          description: 'Review, Replay, And Share Completed Hands',
          path: '/hand-history',
        },
        {
          label: 'Session History',
          description: 'Session-Level Results And Performance',
          path: '/session-history',
        },
        {
          label: 'Leaderboards',
          description: 'Club And Global Competitive Rankings',
          path: '/leaderboard',
        },
      ]}
    />
  );
}

export function LegalWorkspacePage() {
  return (
    <WorkspacePage
      eyebrow="Trust & Rules"
      title="Legal Center"
      description="The Current Platform Rules, Privacy Commitments, Integrity Standards, And Promotion Terms."
      art="images/bg-vault.jpg"
      links={[
        {
          label: 'Fair Gaming',
          description: 'Integrity, Security, And Reporting',
          path: '/legal/fair-gaming',
        },
        {
          label: 'Terms Of Service',
          description: 'Platform And Account Terms',
          path: '/legal/tos',
        },
        {
          label: 'Privacy Policy',
          description: 'Data Use, Retention, And Controls',
          path: '/legal/privacy',
        },
        {
          label: 'Promotion Rules',
          description: 'Eligibility And Campaign Terms',
          path: '/legal/promotions',
        },
        { label: 'Help Center', description: 'Product Help And Support Paths', path: '/help' },
      ]}
    />
  );
}

export function ClubFinanceWorkspacePage() {
  const { clubId = '' } = useParams();
  const access = useClubWorkspace();
  const finance = getClubOperationGroups(clubId, access).find((group) => group.id === 'finance');
  return (
    <WorkspacePage
      eyebrow="Ledger Circuit"
      title="Finance & Risk"
      description="Live Club Economics, Cashier Operations, Settlement, And Exposure Without Duplicate Dashboards."
      art="assets/club-buttons/wallets/desktop/wallet-club-bank-v1.webp"
      links={(finance?.items || [])
        .filter((item) => item.id !== 'finance-overview')
        .map((item) => ({
          label: item.label,
          description: item.description,
          path: item.path,
        }))}
    />
  );
}

export function ClubControlWorkspacePage() {
  const { clubId = '' } = useParams();
  const access = useClubWorkspace();
  const control = getClubOperationGroups(clubId, access).find((group) => group.id === 'control');
  return (
    <WorkspacePage
      eyebrow="House Circuit"
      title="Club Control"
      description="Policy, Communications, Campaigns, Identity, And Permissions In One Governed Workspace."
      art="assets/club-buttons/lobby/lobby-command-chassis-v2.png"
      links={(control?.items || [])
        .filter((item) => item.id !== 'control-overview')
        .map((item) => ({
          label: item.label,
          description: item.description,
          path: item.path,
        }))}
    />
  );
}
