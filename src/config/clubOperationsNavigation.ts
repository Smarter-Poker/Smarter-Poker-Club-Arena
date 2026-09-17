import type { ClubNavigationCapabilities } from './clubArenaNavigation';
import { mediaUrl } from '../utils/mediaBase';

export type ClubOperationGroupId = 'people' | 'finance' | 'control';
export type ClubOperationAccess = 'staff' | 'finance' | 'control';

/**
 * The name of a queue in `ca_club_operations_overview`.counts. A tool that
 * declares one gets a live badge on every navigation surface, and the badge
 * always means the same thing: this many things are waiting for a person.
 * Volume is not a signal - a club with 400 members does not need a 400 on the
 * Players tile - so every key below counts work, not size.
 */
export type ClubOperationSignal =
  | 'members_pending'
  | 'reports_open'
  | 'disputes_open'
  | 'blacklist_expired'
  | 'chip_requests_pending'
  | 'cashouts_pending'
  | 'credit_requests_pending'
  | 'invoices_open'
  | 'tickets_outstanding'
  | 'anti_cheat_flags_open';

export interface ClubOperationItem {
  id: string;
  label: string;
  description: string;
  path: string;
  group: ClubOperationGroupId | 'overview';
  access: ClubOperationAccess;
  rail?: boolean;
  /**
   * Every queue this one tool is where the work lands. A list, not a single
   * key: the cashier is the desk for chip requests, cash-out requests AND
   * credit requests, and a badge that counted one of the three would send an
   * operator to a tile reading 3 with 8 things behind it.
   */
  signals?: ClubOperationSignal[];
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
    art: mediaUrl('assets/club-buttons/club/club-identity-template-bbj-finish-v1.png'),
  },
  {
    id: 'finance',
    label: 'Finance & Risk',
    eyebrow: 'Ledger Circuit',
    description: 'Read Live Club Economics, Settle Balances, And Inspect Insurance Exposure.',
    art: mediaUrl('assets/club-buttons/wallets/desktop/wallet-club-bank-v1.webp'),
  },
  {
    id: 'control',
    label: 'Club Control',
    eyebrow: 'House Circuit',
    description: 'Publish Club Policy, Manage Communications, And Control The Operating Profile.',
    art: mediaUrl('assets/club-buttons/lobby/lobby-command-chassis-v2.png'),
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
    signals: ['members_pending'],
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
    signals: ['reports_open'],
  },
  {
    /* PHASE 6 (2026-09-06): the hands players flagged, and the audited lookup
       that opens any hand dealt at this club. Staff triage; the cards
       themselves are owner/admin and Postgres enforces that. */
    id: 'hand-review',
    label: 'Hand Review',
    description: 'Flagged Hands And The Audited Hand Lookup',
    suffix: 'hand-review',
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
  /**
   * PHASE 2 (2026-09-03): 'staff' became 'control'. Every read on this page is
   * gated - in the database - to the club's owner, co-owner or admin: the two
   * detectors have always raised for anyone else, anti_cheat_events grants
   * SELECT to those three roles only, and the phase 2 flag and stats functions
   * use the same gate. An agent could open the page and every panel on it
   * would refuse. The registry now advertises what the data allows.
   */
  {
    id: 'anti-cheat',
    label: 'Anti-Cheat',
    description: 'Integrity Flags, Collusion Screening, And Review Decisions',
    suffix: 'anti-cheat',
    group: 'people',
    access: 'control',
    signals: ['anti_cheat_flags_open'],
  },
  {
    id: 'disputes',
    label: 'Disputes',
    description: 'Investigate And Resolve Club Transaction Disputes',
    suffix: 'disputes',
    group: 'people',
    access: 'staff',
    signals: ['disputes_open'],
  },
  {
    id: 'blacklist',
    label: 'Blacklist',
    description: 'Control Excluded Players, Reasons, And Expiry Dates',
    suffix: 'blacklist',
    group: 'people',
    access: 'control',
    signals: ['blacklist_expired'],
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
    signals: ['chip_requests_pending', 'cashouts_pending', 'credit_requests_pending'],
  },
  {
    id: 'settlement',
    label: 'Settlement',
    description: 'Square Up Club Balances And Settlement Records',
    suffix: 'settlement',
    group: 'finance',
    access: 'finance',
    signals: ['invoices_open'],
  },
  {
    id: 'insurance',
    label: 'Insurance Report',
    description: 'Offer Funnel, Contracts, And Insurance Bank Performance',
    suffix: 'insurance-report',
    group: 'finance',
    access: 'finance',
  },
  /**
   * PHASE 1 OF THE OPERATIONS UPGRADE (2026-09-03) — three more built tools
   * that had no door, and one door that opened onto the wrong room.
   *
   * `bomb-pot-report` (ClubBombPotReportPage) is gated server-side by the same
   * owner/co_owner/admin test as fn_request_manual_bomb_pot, and answers the
   * first question anybody asks about a forced bomb pot: what did it cost.
   * `table-management` (GameManagementPage, club scope) opens, configures and
   * closes the club's tables behind fn_game_creation_access. `promo-vault`
   * (PromoVaultPage) is the club's actual campaign inventory - buy stock with
   * club diamonds, send items to players - behind fn_promo_vault_can_manage.
   *
   * All three were reachable only by typing the URL. `promo-vault` was worse
   * than absent: the Control group's "Promotions" tile described "Create And
   * Manage Club Promotion Campaigns" and opened PromotionsPage, which is the
   * player-facing offer feed with a claim button and no create path at all.
   * The description now says what that page is, and the manager has its own
   * tile.
   */
  {
    id: 'bomb-pot-report',
    label: 'Bomb Pot Report',
    description: 'Forced Bomb Pot Volume, Antes, Rake, And Board Counts',
    suffix: 'bomb-pot-report',
    group: 'finance',
    access: 'control',
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
    label: 'Player Offers',
    description: 'Review The Live Offer Feed Your Players See',
    suffix: 'promotions',
    group: 'control',
    access: 'staff',
  },
  {
    id: 'promo-vault',
    label: 'Promo Vault',
    description: 'Buy Club Inventory And Send Items To Players',
    suffix: 'promo-vault',
    group: 'control',
    access: 'control',
  },
  {
    id: 'table-management',
    label: 'Table Management',
    description: 'Open, Configure, And Close The Club Games',
    suffix: 'table-management',
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

/** The queue counts a badge can be drawn from. Structurally the subset of
 *  ca_club_operations_overview's `counts` that the registry declares signals
 *  for, so the navigation config never has to import the read hook. */
export type ClubOperationSignalCounts = Partial<Record<ClubOperationSignal, number | null>>;

/**
 * How many things are waiting behind one tile. A tool with a signal reports
 * its own queue; a group overview reports the sum of the queues underneath it;
 * the workspace overview reports everything. Anything else is zero, which is
 * how a tile stays quiet instead of showing a decorative badge.
 *
 * `items` must be the caller's own permission-filtered list, so a super agent
 * never sees a total that includes a control-only queue they cannot open.
 */
export function getClubOperationBadge(
  item: ClubOperationItem,
  counts: ClubOperationSignalCounts | null | undefined,
  items: readonly ClubOperationItem[] = []
): number {
  if (!counts) return 0;
  const own = (entry: ClubOperationItem): number =>
    (entry.signals || []).reduce((total, key) => {
      const value = counts[key];
      return total + (typeof value === 'number' && value > 0 ? value : 0);
    }, 0);
  if (item.signals?.length) return own(item);
  const sum = (scope: readonly ClubOperationItem[]) =>
    scope.reduce((total, entry) => total + own(entry), 0);
  if (item.id === 'overview') return sum(items);
  if (item.id.endsWith('-overview')) return sum(items.filter((e) => e.group === item.group));
  return 0;
}

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

/**
 * Every suffix the operator workspace owns. This set is what
 * ClubCapabilityGuard consults, so a registry item missing from it is a tool
 * with NO route-level permission check: `anti-cheat` was exactly that until
 * 2026-09-03, which also meant the operations rail vanished on that page
 * because getClubOperationContext could not recognise the route either.
 * `tests/unit/clubOperationsRegistryIntegrity.test.ts` now fails if a
 * definition is ever added without its suffix.
 */
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
  'anti-cheat',
  'reports',
  'hand-review',
  'disputes',
  'blacklist',
  'financials',
  'cashier',
  'cashier-classic',
  'settlement',
  'insurance-report',
  'bomb-pot-report',
  'table-management',
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

const CONTROL_SUFFIXES = new Set([
  'control',
  'blacklist',
  'settings',
  'bomb-pot-report',
  'table-management',
  'anti-cheat',
]);

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

/** The rail item that stands for a group when the current tool is not itself
 *  in the rail. Standing on /blacklist should light up Control Overview rather
 *  than leaving the whole rail with nothing selected. */
const GROUP_RAIL_PARENT: Record<ClubOperationGroupId | 'overview', string> = {
  overview: 'overview',
  people: 'overview',
  finance: 'finance-overview',
  control: 'control-overview',
};

/** Pick one current item even when the page is a nested player detail. */
export function getActiveClubOperationPath(
  pathname: string,
  items: readonly ClubOperationItem[]
): string | null {
  const current = pathname
    .replace(/\/+$/, '')
    .replace(/\/dashboard$/, '/data')
    .replace(/\/cashier-classic$/, '/cashier');
  const direct =
    items
      .filter(({ path }) => current === path || current.startsWith(`${path}/`))
      .sort((a, b) => b.path.length - a.path.length)[0]?.path || null;
  if (direct) return direct;

  // No rail item owns this route. Fall back to the rail item that stands for
  // its group, so the rail always says where you are.
  const suffix = current.match(/^\/clubs\/[^/]+\/([^/]+)/)?.[1];
  if (!suffix) return null;
  const definition = DEFINITIONS.find((item) => item.suffix === suffix);
  if (!definition) return null;
  const parentId = GROUP_RAIL_PARENT[definition.group];
  return items.find((item) => item.id === parentId)?.path || null;
}
