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
    eyebrow: 'Roster circuit',
    description: 'Run the team, review player activity, and protect the integrity of the club.',
    art: '/hub/club-arena/assets/club-buttons/club/club-identity-template-bbj-finish-v1.png',
  },
  {
    id: 'finance',
    label: 'Finance & Risk',
    eyebrow: 'Ledger circuit',
    description: 'Read live club economics, settle balances, and inspect insurance exposure.',
    art: '/hub/club-arena/assets/club-buttons/wallets/desktop/wallet-club-bank-v1.webp',
  },
  {
    id: 'control',
    label: 'Club Control',
    eyebrow: 'House circuit',
    description: 'Publish club policy, manage communications, and control the operating profile.',
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
    description: 'Permission-aware command center',
    suffix: 'operations',
    group: 'overview',
    access: 'staff',
    rail: true,
  },
  {
    id: 'dashboard',
    label: 'Dashboard',
    description: 'Club performance, tables, tournaments, and activity',
    suffix: 'dashboard-full',
    group: 'people',
    access: 'staff',
    rail: true,
  },
  {
    id: 'players',
    label: 'Players',
    description: 'Roster, roles, balances, and member records',
    suffix: 'members',
    group: 'people',
    access: 'staff',
    rail: true,
  },
  {
    id: 'agents',
    label: 'Agent Team',
    description: 'Hierarchy, downlines, and agent management',
    suffix: 'agents',
    group: 'people',
    access: 'staff',
  },
  {
    id: 'reports',
    label: 'Reports',
    description: 'Review player reports and moderation decisions',
    suffix: 'reports',
    group: 'people',
    access: 'staff',
    rail: true,
  },
  {
    id: 'disputes',
    label: 'Disputes',
    description: 'Investigate and resolve club transaction disputes',
    suffix: 'disputes',
    group: 'people',
    access: 'staff',
  },
  {
    id: 'blacklist',
    label: 'Blacklist',
    description: 'Control excluded players, reasons, and expiry dates',
    suffix: 'blacklist',
    group: 'people',
    access: 'control',
  },
  {
    id: 'finance-overview',
    label: 'Finance Overview',
    description: 'One live entry point for ledgers, cashier, settlement, and risk',
    suffix: 'finance',
    group: 'finance',
    access: 'finance',
    rail: true,
  },
  {
    id: 'data',
    label: 'Club Data',
    description: 'Game production, player results, and union invoices',
    suffix: 'data',
    group: 'finance',
    access: 'finance',
    rail: true,
  },
  {
    id: 'financials',
    label: 'Financials',
    description: 'Rake, commissions, fees, wallets, and ledger activity',
    suffix: 'financials',
    group: 'finance',
    access: 'finance',
  },
  {
    id: 'cashier',
    label: 'Cashier',
    description: 'Club chips, transfers, and trade records',
    suffix: 'cashier',
    group: 'finance',
    access: 'finance',
  },
  {
    id: 'settlement',
    label: 'Settlement',
    description: 'Square up club balances and settlement records',
    suffix: 'settlement',
    group: 'finance',
    access: 'finance',
  },
  {
    id: 'insurance',
    label: 'Insurance Report',
    description: 'Offer funnel, contracts, and insurance bank performance',
    suffix: 'insurance-report',
    group: 'finance',
    access: 'finance',
  },
  {
    id: 'control-overview',
    label: 'Control Overview',
    description: 'One live entry point for policy, promotions, identity, and access',
    suffix: 'control',
    group: 'control',
    access: 'control',
    rail: true,
  },
  {
    id: 'announcements',
    label: 'Announcements',
    description: 'Publish and review club-wide notices',
    suffix: 'announcements',
    group: 'control',
    access: 'staff',
  },
  {
    id: 'promotions',
    label: 'Promotions',
    description: 'Create and manage club promotion campaigns',
    suffix: 'promotions',
    group: 'control',
    access: 'control',
  },
  {
    id: 'rules',
    label: 'Club Rules',
    description: 'Publish the rules players see before they join',
    suffix: 'rules',
    group: 'control',
    access: 'control',
  },
  {
    id: 'settings',
    label: 'Settings',
    description: 'Identity, limits, permissions, and club lifecycle',
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
