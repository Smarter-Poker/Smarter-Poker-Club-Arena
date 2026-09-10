import { withClubContext } from '../utils/clubScopedPath';

export interface ClubArenaNavItem {
  label: string;
  path: string;
  description: string;
  external?: boolean;
}

export interface ClubArenaNavGroup {
  label: string;
  items: ClubArenaNavItem[];
}

interface ClubArenaNavigationContext {
  clubId: string | null;
  clubRole?: string | null;
  isPlatformStaff?: boolean;
  canManageGames?: boolean;
  /**
   * fn_can_i_operate_the_union_network said yes for this account
   * (see useCanOperateUnionNetwork). Fails closed: absent an explicit yes the
   * union directory is not listed at all.
   */
  canOperateUnionNetwork?: boolean;
}

const CLUB_STAFF_ROLES = new Set(['owner', 'co_owner', 'admin', 'manager', 'super_agent', 'agent']);
/** The roles that may see a club's money. Mirrors ca_can_view_club_finances. */
export const CLUB_FINANCE_ROLES: ReadonlySet<string> = new Set([
  'owner',
  'co_owner',
  'admin',
  'super_agent',
]);
const CLUB_CONTROL_ROLES = new Set(['owner', 'co_owner', 'admin']);

export interface ClubNavigationCapabilities {
  isClubStaff: boolean;
  canViewFinance: boolean;
  canControlClub: boolean;
}

/**
 * One permission vocabulary for every Club Arena navigation surface.
 *
 * The hamburger and the fixed club rail used to maintain separate answers to
 * "who should see this link?". That made the hamburger correctly hide Data
 * from members while the bottom rail still advertised it. Navigation is not
 * an authorization boundary, but it must accurately describe the tools a
 * person can use; the route/API guards remain authoritative underneath.
 */
export function getClubNavigationCapabilities(
  clubRole: string | null | undefined,
  isPlatformStaff = false
): ClubNavigationCapabilities {
  const role = clubRole || '';
  return {
    isClubStaff: isPlatformStaff || CLUB_STAFF_ROLES.has(role),
    canViewFinance: isPlatformStaff || CLUB_FINANCE_ROLES.has(role),
    canControlClub: isPlatformStaff || CLUB_CONTROL_ROLES.has(role),
  };
}

/**
 * The hamburger is an orientation surface, not an exhaustive route registry.
 * Secondary tools remain reachable from the page that owns them (wallet,
 * tournament lobby, club dashboard, etc.), while old URLs stay supported by
 * redirects in App.tsx.
 *
 * ── EVERY DESTINATION CARRIES THE CLUB (Dan, 2026-09-02, binding) ──────────
 *
 * "WHEN YOU GO TO THE HAMBURGER MENU INSIDE ANY CLUB, THAT ENTIRE HAMBURGER
 *  MENU NEEDS TO BE LINKED TO THAT CLUB."
 *
 * This builder already had `clubPath()` and used it for Club Lobby, Table
 * Management, Operations and Cashier — four of sixteen. The other twelve were
 * hardcoded global strings even when `clubId` was right there in scope, so
 * opening Leaderboards from inside Deep Stack Society handed the page nothing
 * and it guessed `clubs[0]`, which was Club JAQK.
 *
 * The fix is not twelve more template literals. Every item's path is passed
 * through `withClubContext` at the bottom of this function, which stamps
 * `?club=<the identifier the route is already using>` onto exactly the routes
 * that render club-scoped data (`CLUB_SCOPED_GLOBAL_ROUTES`) and leaves the
 * rest — `/profile`, `/settings`, `/legal/*` — alone. Adding a destination to
 * this file therefore cannot forget the club; forgetting is no longer a thing
 * an author does, which is the only kind of fix that survives contact with a
 * repo this many agents write to.
 */
export function getClubArenaNavigation({
  clubId,
  clubRole = null,
  isPlatformStaff = false,
  canManageGames = false,
  canOperateUnionNetwork = false,
}: ClubArenaNavigationContext): ClubArenaNavGroup[] {
  const clubPath = (suffix = '') => (clubId ? `/clubs/${clubId}${suffix}` : '/');

  const groups: ClubArenaNavGroup[] = [
    {
      label: 'Play',
      items: [
        {
          label: 'Play & Review',
          path: '/play',
          description: 'Competition, Hands, Sessions, And Rankings',
        },
        {
          label: 'Club Arena',
          path: '/',
          description: 'Your Clubs And Live Games',
        },
        {
          label: 'Tournaments',
          path: '/tournaments',
          description: 'Schedule, Registration, And Live Events',
        },
        {
          label: 'Tournament Results',
          path: '/tournament-results',
          description: 'Finishes, Prizes, And Past Events',
        },
        {
          label: 'My Spin Results',
          path: '/tournament-results?filter=mine&type=spin',
          description: 'Your Spin Finishes And Prizes',
        },
        {
          label: 'Hand History',
          path: '/hand-history',
          description: 'Review, Replay, And Share Hands',
        },
        {
          label: 'Session History',
          path: '/session-history',
          description: 'Session Results And Performance',
        },
        {
          label: 'Leaderboards',
          path: '/leaderboard',
          description: 'Club And Global Rankings',
        },
      ],
    },
    {
      label: 'Community',
      items: [
        {
          label: 'Community Center',
          path: '/community',
          description: 'Discovery, Connections, Activity, And Conversation',
        },
        {
          label: 'Find Players & Clubs',
          path: '/search',
          description: 'One Search For The Whole Arena',
        },
        {
          label: 'Messages',
          path: '/messages',
          description: 'Open Smarter.Poker Messenger',
          external: true,
        },
        {
          label: 'Friends',
          path: '/friends',
          description: 'Friends, Requests, And Challenges',
        },
        /* The union directory is an allowlisted door (Dan 2026-09-05: "hidden
           to everyone except me"). Absent an explicit yes it is not offered -
           the same fail-closed rule the section rail and the Community Center
           follow, and all three read the one answer from
           fn_can_i_operate_the_union_network. A link that bounces the person
           straight back out is worse than no link. */
        ...(canOperateUnionNetwork
          ? [
              {
                label: 'Unions',
                path: '/unions',
                description: 'Browse And Manage Club Networks',
              },
            ]
          : []),
      ],
    },
    {
      label: 'Wallet & Rewards',
      items: [
        {
          label: 'Rewards Center',
          path: '/rewards',
          description: 'All Balances, Benefits, Offers, And Milestones',
        },
        {
          label: 'Wallet',
          path: '/wallet',
          description: 'Balances, Transfers, And Ledger',
        },
        {
          label: 'Cashier',
          path: clubId ? clubPath('/cashier') : '/cashier',
          description: 'Club Chips And Trade Records',
        },
        {
          label: 'Marketplace',
          path: '/marketplace',
          description: 'Diamonds, Membership, And Items',
        },
        {
          label: 'VIP & Rakeback',
          path: '/vip',
          description: 'Tier Benefits And Earning Rate',
        },
        {
          label: 'Promotions',
          path: '/promotions',
          description: 'Active Offers, Bonuses, And Rewards',
        },
        {
          label: 'Achievements',
          path: '/achievements',
          description: 'Progress, Milestones, And Unlocks',
        },
      ],
    },
  ];

  if (clubId) {
    const { isClubStaff, canViewFinance, canControlClub } = getClubNavigationCapabilities(
      clubRole,
      isPlatformStaff
    );
    const operationItems: ClubArenaNavItem[] = [
      {
        label: 'Club Lobby',
        path: clubPath(),
        description: 'Games, Schedule, And Club Activity',
      },
    ];

    if (canManageGames) {
      operationItems.push({
        label: 'Table Management',
        path: clubPath('/table-management'),
        description: 'Create, Schedule, Edit, Close Games, And Control The Ticker',
      });
    }

    if (isClubStaff) {
      /**
       * PHASE 7 — the agent dashboard had no door anywhere.
       *
       * AgentDashboardPage is eight tabs of agent operations (Overview,
       * Players, Cashouts, Commissions, Score, Analytics, Promo, Credit) and
       * was reachable only by typing /agent-dashboard, while
       * agent_commissions carried 1,490,109 rows against 113 agents. The
       * entry is gated with the rest of the staff tools because agents and
       * super agents are club staff and owners oversee them.
       *
       * The path stays global, but it is no longer CONTEXT-FREE: this comment
       * used to end "it resolves its own club, so the path stays global",
       * and what the page actually did was take `mems[0].club_id` — the first
       * row of an unordered membership query. An agent working two clubs got
       * whichever one Postgres returned first. `withClubContext` now stamps
       * the club the player is standing in, and the page prefers it.
       */
      operationItems.push({
        label: 'Agent Dashboard',
        path: '/agent-dashboard',
        description: 'Downline Players, Commissions, Cashouts, And Credit',
      });
      /* Dan 2026-09-03: club owners advertise their club or events, paying
         in diamonds. The page itself fails closed on a non-staff caller. */
      operationItems.push({
        label: 'Advertise Your Club',
        path: clubPath('/advertise'),
        description: 'Buy A Picture On The Lobby Strip Or Session Summary, Paid In Diamonds',
      });
      operationItems.push({
        label: 'Operations Center',
        path: clubPath('/operations'),
        description: canControlClub
          ? 'People, Finance, Safety, And Club Controls'
          : canViewFinance
            ? 'People, Finance, Reports, And Settlement'
            : 'Players, Agents, Reports, And Announcements',
      });
    }

    groups.push({
      label: 'Club Operations',
      items: operationItems,
    });
  }

  if (isPlatformStaff) {
    groups.push({
      label: 'Platform Operations',
      items: [
        {
          label: 'Administration',
          path: '/admin',
          description: 'Platform And Club Operations',
        },
        {
          label: 'House Ads',
          path: '/house-ads',
          description: 'Platform Campaign Controls',
        },
      ],
    });
  }

  /* THE ONE PLACE THE CLUB IS ATTACHED. Done here rather than at each item so
     a destination added later cannot be added club-blind — the failure mode
     that produced the reported bug. `withClubContext` is a no-op for paths
     that are already club-scoped (`/clubs/…`), for personal routes, and when
     there is no club in play, so this line is safe to apply to everything.

     `external` items are stamped too. The one that carries the flag is
     Messages, and `external` describes its DESTINATION (the World Hub
     messenger) rather than its route: it navigates in-app to
     `NavigateToMessenger`, which reads `?club=` and forwards it to the Hub as
     `clubId`. Skipping it would drop the club at the last hop, which is the
     bug wearing a different hat. The flag only chooses the arrow glyph. */
  if (!clubId) return groups;
  return groups.map((group) => ({
    ...group,
    items: group.items.map((item) => ({ ...item, path: withClubContext(item.path, clubId) })),
  }));
}

export const CLUB_ARENA_SUPPORT_NAV: ClubArenaNavItem[] = [
  {
    label: 'Help Center',
    path: '/help',
    description: 'Answers, Support, And Account Help',
  },
  {
    label: 'Legal Center',
    path: '/legal',
    description: 'All Platform Rules And Privacy Commitments',
  },
  {
    label: 'Fair Gaming',
    path: '/legal/fair-gaming',
    description: 'Integrity, Security, And Reporting',
  },
  {
    label: 'Terms Of Service',
    path: '/legal/tos',
    description: 'Platform And Account Terms',
  },
  {
    label: 'Privacy Policy',
    path: '/legal/privacy',
    description: 'Data Collection, Use, And Controls',
  },
  {
    label: 'Promotion Rules',
    path: '/legal/promotions',
    description: 'Eligibility And Live Campaign Governance',
  },
];
