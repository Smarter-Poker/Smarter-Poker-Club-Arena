import type { ClubNavigationCapabilities } from './clubArenaNavigation';

export type ClubOperationGroupId = 'people' | 'finance' | 'control';
export type ClubOperationAccess = 'staff' | 'finance' | 'control';

export interface ClubOperationItem {
  id: string;
  label: string;
  description: string;
  path: string;
  group: ClubOperationGroupId | 'overview';
  access: ClubOperationAccess;
  rail?: boolean;
}

export interface ClubOperationGroup {
  id: ClubOperationGroupId;
  label: string;
  eyebrow: string;
  description: string;
  art: string;
  items: ClubOperationItem[];
}

const GROUPS: Array<Omit<ClubOperationGroup, 'items'>> = [
  {
    id: 'people',
    label: 'People & Safety',
    eyebrow: 'Roster Circuit',
    description: 'Run The Team, Review Player Activity, And Protect The Integrity Of The Club.',
    art: '/hub/club-arena/assets/club-buttons/club/club-identity-template-bbj-finish-v1.png',
  },
  {
    id: 'finance',
    label: 'Finance & Risk',
    eyebrow: 'Ledger Circuit',
    description: 'Read Live Club Economics, Settle Balances, And Inspect Insurance Exposure.',
    art: '/hub/club-arena/assets/club-buttons/wallets/desktop/wallet-club-bank-v1.webp',
  },
  {
    id: 'control',
    label: 'Club Control',
    eyebrow: 'House Circuit',
    description: 'Publish Club Policy, Manage Communications, And Control The Operating Profile.',
    art: '/hub/club-arena/assets/club-buttons/lobby/lobby-command-chassis-v2.png',
  },
];

interface OperationDefinition extends Omit<ClubOperationItem, 'path'> {
  suffix: string;
}

/**
 * The authoritative club-operations inventory. Existing URLs remain the
 * destinations because the pages and their server/RLS gates continue to own
 * their business logic. This registry only gives those tools one coherent
 * workspace and one permission vocabulary.
 */
const DEFINITIONS: OperationDefinition[] = [
  {
    id: 'overview',
    label: 'Overview',
    description: 'Permission-Aware Command Center',
    suffix: 'operations',
    group: 'overview',
    access: 'staff',
    rail: true,
  },
  {
    id: 'dashboard',
    label: 'Dashboard',
    description: 'Club Performance, Tables, Tournaments, And Activity',
    suffix: 'dashboard-full',
    group: 'people',
    access: 'staff',
    rail: true,
  },
  {
    id: 'players',
    label: 'Players',
    description: 'Roster, Roles, Balances, And Member Records',
    suffix: 'members',
    group: 'people',
    access: 'staff',
    rail: true,
  },
  {
    id: 'agents',
    label: 'Agent Team',
    description: 'Hierarchy, Downlines, And Agent Management',
    suffix: 'agents',
    group: 'people',
    access: 'staff',
  },
  {
    id: 'reports',
    label: 'Reports',
    description: 'Review Player Reports And Moderation Decisions',
    suffix: 'reports',
    group: 'people',
    access: 'staff',
    rail: true,
  },
  /**
   * PHASE 7 — two built tools that had no door.
   *
   * `agent-dashboard` renders SuperAgentDashboard, the club-scoped view of an
   * agent network. `anti-cheat` renders AntiCheatPage, five tabs of collusion
   * and anomaly review. Both were reachable only by typing the URL while
   * agent_commissions carried 1,490,109 rows and anti_cheat_flags carried
   * live flags. Neither is new work; both are doors onto work already shipped.
   */
  {
    id: 'agent-network',
    label: 'Agent Network',
    description: 'Downlines, Live Agent Activity, And Network Performance',
    suffix: 'agent-dashboard',
    group: 'people',
    access: 'staff',
  },
  {
    id: 'anti-cheat',
    label: 'Anti-Cheat',
    description: 'Collusion Flags, Player Anomalies, And Review Decisions',
    suffix: 'anti-cheat',
    group: 'people',
    access: 'staff',
  },
  {
    id: 'disputes',
    label: 'Disputes',
    description: 'Investigate And Resolve Club Transaction Disputes',
    suffix: 'disputes',
    group: 'people',
    access: 'staff',
  },
  {
    id: 'blacklist',
    label: 'Blacklist',
    description: 'Control Excluded Players, Reasons, And Expiry Dates',
    suffix: 'blacklist',
    group: 'people',
    access: 'control',
  },
  {
    id: 'finance-overview',
    label: 'Finance Overview',
    description: 'One Live Entry Point For Ledgers, Cashier, Settlement, And Risk',
    suffix: 'finance',
    group: 'finance',
    access: 'finance',
    rail: true,
  },
  {
    id: 'data',
    label: 'Club Data',
    description: 'Game Production, Player Results, And Union Invoices',
    suffix: 'data',
    group: 'finance',
    access: 'finance',
    rail: true,
  },
  {
    id: 'financials',
    label: 'Financials',
    description: 'Rake, Commissions, Fees, Wallets, And Ledger Activity',
    suffix: 'financials',
    group: 'finance',
    access: 'finance',
  },
  {
    id: 'cashier',
    label: 'Cashier',
    description: 'Club Chips, Transfers, And Trade Records',
    suffix: 'cashier',
    group: 'finance',
    access: 'finance',
  },
  {
    id: 'settlement',
    label: 'Settlement',
    description: 'Square Up Club Balances And Settlement Records',
    suffix: 'settlement',
    group: 'finance',
    access: 'finance',
  },
  {
    id: 'insurance',
    label: 'Insurance Report',
    description: 'Offer Funnel, Contracts, And Insurance Bank Performance',
    suffix: 'insurance-report',
    group: 'finance',
    access: 'finance',
  },
  {
    id: 'control-overview',
    label: 'Control Overview',
    description: 'One Live Entry Point For Policy, Promotions, Identity, And Access',
    suffix: 'control',
    group: 'control',
    access: 'control',
    rail: true,
  },
  {
    id: 'announcements',
    label: 'Announcements',
    description: 'Publish And Review Club-Wide Notices',
    suffix: 'announcements',
    group: 'control',
    access: 'staff',
  },
  {
    id: 'promotions',
    label: 'Promotions',
    description: 'Create And Manage Club Promotion Campaigns',
    suffix: 'promotions',
    group: 'control',
    access: 'control',
  },
  {
    id: 'rules',
    label: 'Club Rules',
    description: 'Publish The Rules Players See Before They Join',
    suffix: 'rules',
    group: 'control',
    access: 'control',
  },
  {
    id: 'settings',
    label: 'Settings',
    description: 'Identity, Limits, Permissions, And Club Lifecycle',
    suffix: 'settings',
    group: 'control',
    access: 'control',
    rail: true,
  },
];

function canAccess(access: ClubOperationAccess, capabilities: ClubNavigationCapabilities): boolean {
  if (access === 'control') return capabilities.canControlClub;
  if (access === 'finance') return capabilities.canViewFinance;
  return capabilities.isClubStaff;
}

export function getClubOperationItems(
  clubId: string,
  capabilities: ClubNavigationCapabilities
): ClubOperationItem[] {
  const base = `/clubs/${clubId}`;
  return DEFINITIONS.filter((item) => canAccess(item.access, capabilities)).map(
    ({ suffix, ...item }) => ({ ...item, path: `${base}/${suffix}` })
  );
}

export function getClubOperationGroups(
  clubId: string,
  capabilities: ClubNavigationCapabilities
): ClubOperationGroup[] {
  const items = getClubOperationItems(clubId, capabilities);
  return GROUPS.map((group) => ({
    ...group,
    items: items.filter((item) => item.group === group.id),
  })).filter((group) => group.items.length > 0);
}

export function getClubOperationRailItems(
  clubId: string,
  capabilities: ClubNavigationCapabilities
): ClubOperationItem[] {
  return getClubOperationItems(clubId, capabilities).filter((item) => item.rail);
}

const OPERATION_SUFFIXES = new Set([
  'operations',
  'dashboard',
  'dashboard-full',
  'data',
  'finance',
  'control',
  'members',
  'agents',
  'agent-dashboard',
  'reports',
  'disputes',
  'blacklist',
  'financials',
  'cashier',
  'cashier-classic',
  'settlement',
  'insurance-report',
  'announcements',
  'promotions',
  'promo-vault',
  'rules',
  'settings',
]);

const FINANCE_SUFFIXES = new Set([
  'finance',
  'data',
  'financials',
  'settlement',
  'insurance-report',
]);

const CONTROL_SUFFIXES = new Set(['control', 'blacklist', 'settings']);

// These routes combine a member-facing read/buy experience with controls that
// are already gated inside the page and again by RLS/RPC. Blocking the whole
// route would remove valid player cashier, rules, promotion, announcement, or
// read-only vault behavior.
const MEMBER_VISIBLE_SUFFIXES = new Set([
  'cashier',
  'cashier-classic',
  'announcements',
  'promotions',
  'promo-vault',
  'rules',
]);

/**
 * Route-level capability contract for the operator workspace. This registry is
 * shared with navigation so hidden tools and protected tools cannot drift.
 */
export function getRequiredClubOperationAccess(pathname: string): ClubOperationAccess | null {
  const match = pathname.replace(/\/+$/, '').match(/^\/clubs\/[^/]+\/([^/]+)/);
  const suffix = match?.[1];
  if (!suffix || !OPERATION_SUFFIXES.has(suffix)) return null;
  if (MEMBER_VISIBLE_SUFFIXES.has(suffix)) return null;
  if (CONTROL_SUFFIXES.has(suffix)) return 'control';
  if (FINANCE_SUFFIXES.has(suffix)) return 'finance';
  return 'staff';
}

/** Return the club id only for routes that belong to the operator workspace. */
export function getClubOperationContext(pathname: string): string | null {
  const current = pathname.replace(/\/+$/, '');
  const match = current.match(/^\/clubs\/([^/]+)\/([^/]+)/);
  if (!match || !OPERATION_SUFFIXES.has(match[2])) return null;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return match[1];
  }
}

/** Pick one current item even when the page is a nested player detail. */
export function getActiveClubOperationPath(
  pathname: string,
  items: readonly ClubOperationItem[]
): string | null {
  const current = pathname
    .replace(/\/+$/, '')
    .replace(/\/dashboard$/, '/data')
    .replace(/\/cashier-classic$/, '/cashier')
    .replace(/\/agent-dashboard$/, '/agents')
    .replace(/\/promo-vault$/, '/promotions');
  return (
    items
      .filter(({ path }) => current === path || current.startsWith(`${path}/`))
      .sort((a, b) => b.path.length - a.path.length)[0]?.path || null
  );
}
