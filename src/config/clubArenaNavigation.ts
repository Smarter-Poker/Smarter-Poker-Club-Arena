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
}

const CLUB_STAFF_ROLES = new Set(['owner', 'co_owner', 'admin', 'manager', 'super_agent', 'agent']);
const CLUB_FINANCE_ROLES = new Set(['owner', 'co_owner', 'admin', 'super_agent']);
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
 */
export function getClubArenaNavigation({
  clubId,
  clubRole = null,
  isPlatformStaff = false,
}: ClubArenaNavigationContext): ClubArenaNavGroup[] {
  const clubPath = (suffix = '') => (clubId ? `/clubs/${clubId}${suffix}` : '/');

  const groups: ClubArenaNavGroup[] = [
    {
      label: 'Play',
      items: [
        {
          label: 'Club Arena',
          path: '/',
          description: 'Your clubs and live games',
        },
        {
          label: 'Tournaments',
          path: '/tournaments',
          description: 'Schedule, registration, and live events',
        },
        {
          label: 'Tournament Results',
          path: '/tournament-results',
          description: 'Finishes, prizes, and past events',
        },
        {
          label: 'My Spin Results',
          path: '/tournament-results?filter=mine&type=spin',
          description: 'Your Spin finishes and prizes',
        },
        {
          label: 'Hand History',
          path: '/hand-history',
          description: 'Review, replay, and share hands',
        },
        {
          label: 'Session History',
          path: '/session-history',
          description: 'Session results and performance',
        },
        {
          label: 'Leaderboards',
          path: '/leaderboard',
          description: 'Club and global rankings',
        },
      ],
    },
    {
      label: 'Community',
      items: [
        {
          label: 'Find Players & Clubs',
          path: '/search',
          description: 'One search for the whole arena',
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
          description: 'Friends, requests, and challenges',
        },
        {
          label: 'Unions',
          path: '/unions',
          description: 'Browse and manage club networks',
        },
      ],
    },
    {
      label: 'Wallet & Rewards',
      items: [
        {
          label: 'Rewards Center',
          path: '/rewards',
          description: 'All balances, benefits, offers, and milestones',
        },
        {
          label: 'Wallet',
          path: '/wallet',
          description: 'Balances, transfers, and ledger',
        },
        {
          label: 'Cashier',
          path: clubId ? clubPath('/cashier') : '/cashier',
          description: 'Club chips and trade records',
        },
        {
          label: 'Marketplace',
          path: '/marketplace',
          description: 'Diamonds, membership, and items',
        },
        {
          label: 'VIP & Rakeback',
          path: '/vip',
          description: 'Tier benefits and earning rate',
        },
        {
          label: 'Promotions',
          path: '/promotions',
          description: 'Active offers, bonuses, and rewards',
        },
        {
          label: 'Achievements',
          path: '/achievements',
          description: 'Progress, milestones, and unlocks',
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
        description: 'Games, schedule, and club activity',
      },
    ];

    if (isClubStaff) {
      operationItems.push({
        label: 'Operations Center',
        path: clubPath('/operations'),
        description: canControlClub
          ? 'People, finance, safety, and club controls'
          : canViewFinance
            ? 'People, finance, reports, and settlement'
            : 'Players, agents, reports, and announcements',
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
          description: 'Platform and club operations',
        },
        {
          label: 'House Ads',
          path: '/house-ads',
          description: 'Platform campaign controls',
        },
      ],
    });
  }

  return groups;
}

export const CLUB_ARENA_SUPPORT_NAV: ClubArenaNavItem[] = [
  {
    label: 'Help Center',
    path: '/help',
    description: 'Answers, support, and account help',
  },
  {
    label: 'Legal Center',
    path: '/legal',
    description: 'All platform rules and privacy commitments',
  },
  {
    label: 'Fair Gaming',
    path: '/legal/fair-gaming',
    description: 'Integrity, security, and reporting',
  },
  {
    label: 'Terms Of Service',
    path: '/legal/tos',
    description: 'Platform and account terms',
  },
  {
    label: 'Privacy Policy',
    path: '/legal/privacy',
    description: 'Data collection, use, and controls',
  },
];
