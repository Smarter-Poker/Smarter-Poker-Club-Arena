import { useMemo } from 'react';
import { Link, useParams } from 'react-router-dom';
import {
  getClubOperationBadge,
  getClubOperationGroups,
  type ClubOperationGroupId,
} from '../../config/clubOperationsNavigation';
import { useClubWorkspace } from '../../contexts/ClubWorkspaceContext';
import {
  useClubOperationsOverview,
  type ClubOperationsAlert,
} from '../../hooks/useClubOperationsOverview';
import { formatChips, formatInt } from '../../utils/clubDashboard';
import { mediaUrl } from '../../utils/mediaBase';
import styles from './ArenaWorkspacePages.module.css';

interface WorkspaceLink {
  label: string;
  description: string;
  path: string;
  signal?: string;
}

interface WorkspaceReading {
  label: string;
  value: string;
}

interface WorkspaceAlert extends ClubOperationsAlert {
  path: string | null;
}

function WorkspacePage({
  eyebrow,
  title,
  description,
  art,
  links,
  readings,
  alerts,
  liveLine = 'Live Systems Remain Authoritative',
}: {
  eyebrow: string;
  title: string;
  description: string;
  art: string;
  links: WorkspaceLink[];
  readings?: WorkspaceReading[];
  alerts?: WorkspaceAlert[];
  liveLine?: string;
}) {
  /* A <section>, not a <main>. AppLayout already renders <main
     id="main-content"> around the router outlet, so every one of these pages
     was shipping two main landmarks and an ambiguous skip link. */
  return (
    <section className={styles.page}>
      <header className={styles.hero}>
        <div className={styles.heroCopy}>
          <span className={styles.eyebrow}>{eyebrow}</span>
          <h1>{title}</h1>
          <p>{description}</p>
          <span className={styles.liveLine}>
            <span aria-hidden="true" /> {liveLine}
          </span>
        </div>
        <div className={styles.artFrame} aria-hidden="true">
          <img src={mediaUrl(art)} alt="" />
        </div>
      </header>

      {readings && readings.length > 0 && (
        <section className={styles.readings} aria-label={`${title} Readings`}>
          {readings.map((reading) => (
            <p className={styles.reading} key={reading.label}>
              <span>{reading.label}</span>
              <strong>{reading.value}</strong>
            </p>
          ))}
        </section>
      )}

      {alerts && alerts.length > 0 && (
        <section className={styles.alerts} aria-label={`${title} Work Waiting`} aria-live="polite">
          <p className={styles.alertsTitle}>Waiting For You</p>
          <ul className={styles.alertList}>
            {alerts.map((alert) => {
              const body = (
                <>
                  <span
                    className={`${styles.alertPip} ${styles[alert.severity]}`}
                    aria-hidden="true"
                  />
                  <span className={styles.alertTitle}>{alert.title}</span>
                  {alert.count > 0 && <span className={styles.alertCount}>{alert.count}</span>}
                </>
              );
              return (
                <li key={alert.id}>
                  {alert.path ? (
                    <Link className={styles.alertRow} to={alert.path}>
                      {body}
                    </Link>
                  ) : (
                    <span className={styles.alertRow}>{body}</span>
                  )}
                </li>
              );
            })}
          </ul>
        </section>
      )}

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
    </section>
  );
}

/**
 * The club sub-workspaces used to be pure link grids under a line that read
 * "Live Systems Remain Authoritative" - true of the tools, and not true of
 * anything on the page. They now carry the same live reading as
 * /operations: every queue that is waiting for a person, on the tile that
 * owns it, plus the group's own headline numbers.
 */
function useClubWorkspaceGroup(group: ClubOperationGroupId) {
  const { clubId = '' } = useParams();
  const access = useClubWorkspace();
  const { overview } = useClubOperationsOverview(
    access.isClubStaff &&
      !access.loading &&
      !access.error &&
      (access.routeClubId === clubId || access.clubUUID === clubId)
      ? access.clubUUID
      : null
  );
  const items = useMemo(
    () => getClubOperationGroups(clubId, access).find((entry) => entry.id === group)?.items || [],
    [access, clubId, group]
  );
  const counts = overview?.counts || null;

  const links = useMemo<WorkspaceLink[]>(
    () =>
      items
        .filter((item) => item.id !== `${group}-overview`)
        .map((item) => {
          const badge = getClubOperationBadge(item, counts);
          return {
            label: item.label,
            description: item.description,
            path: item.path,
            signal: badge > 0 ? `${formatInt(badge)} Waiting` : undefined,
          };
        }),
    [counts, group, items]
  );

  /* Only the alerts this group's own tools own. An operator on /finance is
     not helped by a membership queue, and sending them to a tool that is not
     on the page they are looking at is how a link grid earns its reputation. */
  const alerts = useMemo<WorkspaceAlert[]>(
    () =>
      (overview?.alerts || [])
        .filter((alert) => items.some((item) => item.id === alert.tool))
        .map((alert) => ({
          ...alert,
          path: items.find((item) => item.id === alert.tool)?.path || null,
        })),
    [items, overview]
  );

  return { links, alerts, overview };
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
  const { links, alerts, overview } = useClubWorkspaceGroup('finance');
  const kpis = overview?.kpis;
  const counts = overview?.counts;
  const readings: WorkspaceReading[] = [];
  if (kpis) {
    if (typeof kpis.club_bank === 'number') {
      readings.push({ label: 'Club Bank', value: formatChips(kpis.club_bank) });
    }
    if (typeof kpis.member_chips === 'number') {
      readings.push({ label: 'Member Wallets', value: formatChips(kpis.member_chips) });
    }
    if (typeof kpis.rake_today === 'number') {
      readings.push({ label: 'Fees Today', value: formatChips(kpis.rake_today) });
    }
    readings.push({ label: 'Hands Today', value: formatInt(kpis.hands_today) });
  }
  if (counts) {
    readings.push({
      label: 'Tickets Outstanding',
      value: formatInt(counts.tickets_outstanding),
    });
  }
  return (
    <WorkspacePage
      eyebrow="Ledger Circuit"
      title="Finance & Risk"
      description="Live Club Economics, Cashier Operations, Settlement, And Exposure Without Duplicate Dashboards."
      art="assets/club-buttons/wallets/desktop/wallet-club-bank-v1.webp"
      liveLine={
        readings.length > 0 ? 'Read Live From This Club' : 'Live Systems Remain Authoritative'
      }
      readings={readings}
      alerts={alerts}
      links={links}
    />
  );
}

export function ClubControlWorkspacePage() {
  const { links, alerts, overview } = useClubWorkspaceGroup('control');
  const kpis = overview?.kpis;
  const counts = overview?.counts;
  const readings: WorkspaceReading[] = [];
  if (kpis) {
    readings.push({ label: 'Members', value: formatInt(kpis.members) });
    readings.push({ label: 'Live Tables', value: formatInt(kpis.live_tables) });
    readings.push({
      label: 'Tournaments',
      value: formatInt(kpis.tournaments_registering + kpis.tournaments_running),
    });
  }
  if (counts) {
    readings.push({ label: 'Membership Requests', value: formatInt(counts.members_pending) });
    readings.push({ label: 'Excluded Players', value: formatInt(counts.blacklist_active) });
  }
  return (
    <WorkspacePage
      eyebrow="House Circuit"
      title="Club Control"
      description="Policy, Communications, Campaigns, Identity, And Permissions In One Governed Workspace."
      art="assets/club-buttons/lobby/lobby-command-chassis-v2.png"
      liveLine={
        readings.length > 0 ? 'Read Live From This Club' : 'Live Systems Remain Authoritative'
      }
      readings={readings}
      alerts={alerts}
      links={links}
    />
  );
}
