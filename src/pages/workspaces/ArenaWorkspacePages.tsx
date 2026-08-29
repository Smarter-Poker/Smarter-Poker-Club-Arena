import { Link, useParams } from 'react-router-dom';
import { getClubOperationGroups } from '../../config/clubOperationsNavigation';
import { useClubWorkspace } from '../../contexts/ClubWorkspaceContext';
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
          <img src={art} alt="" />
        </div>
      </header>

      <section className={styles.grid} aria-label={`${title} tools`}>
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
      description="A single route into every live balance, benefit, offer, and earned milestone."
      art="/hub/club-arena/assets/club-buttons/wallets/square/wallet-diamonds-square-v1.webp"
      links={[
        { label: 'Wallet', description: 'Balances, transfers, and ledger', path: '/wallet' },
        {
          label: 'Transactions',
          description: 'Complete account transaction history',
          path: '/transactions',
        },
        { label: 'VIP Status', description: 'Tier, benefits, and progress', path: '/vip' },
        { label: 'Rakeback', description: 'Current rate and payment history', path: '/rakeback' },
        { label: 'Promotions', description: 'Live and upcoming offers', path: '/promotions' },
        { label: 'Bonuses', description: 'Available bonus inventory', path: '/bonuses' },
        {
          label: 'Achievements',
          description: 'Milestones, badges, and unlock progress',
          path: '/achievements',
        },
        { label: 'Challenges', description: 'Daily objectives and progress', path: '/challenges' },
      ]}
    />
  );
}

export function LegalWorkspacePage() {
  return (
    <WorkspacePage
      eyebrow="Trust & Rules"
      title="Legal Center"
      description="The current platform rules, privacy commitments, integrity standards, and promotion terms."
      art="/hub/club-arena/images/bg-vault.jpg"
      links={[
        {
          label: 'Fair Gaming',
          description: 'Integrity, security, and reporting',
          path: '/legal/fair-gaming',
        },
        {
          label: 'Terms Of Service',
          description: 'Platform and account terms',
          path: '/legal/tos',
        },
        {
          label: 'Privacy Policy',
          description: 'Data use, retention, and controls',
          path: '/legal/privacy',
        },
        {
          label: 'Promotion Rules',
          description: 'Eligibility and campaign terms',
          path: '/legal/promotions',
        },
        { label: 'Help Center', description: 'Product help and support paths', path: '/help' },
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
      description="Live club economics, cashier operations, settlement, and exposure without duplicate dashboards."
      art="/hub/club-arena/assets/club-buttons/wallets/desktop/wallet-club-bank-v1.webp"
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
      description="Policy, communications, campaigns, identity, and permissions in one governed workspace."
      art="/hub/club-arena/assets/club-buttons/lobby/lobby-command-chassis-v2.png"
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
