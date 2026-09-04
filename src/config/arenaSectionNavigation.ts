export interface ArenaSectionItem {
  label: string;
  path: string;
}

export interface ArenaSectionNavigation {
  id: 'account' | 'community' | 'play' | 'rewards' | 'support' | 'union';
  label: string;
  items: ArenaSectionItem[];
}

const PLAY_ITEMS: ArenaSectionItem[] = [
  { label: 'Overview', path: '/play' },
  { label: 'Tournaments', path: '/tournaments' },
  { label: 'Results', path: '/tournament-results' },
  { label: 'Hands', path: '/hand-history' },
  { label: 'Sessions', path: '/session-history' },
  { label: 'Leaderboards', path: '/leaderboard' },
];

const COMMUNITY_ITEMS: ArenaSectionItem[] = [
  { label: 'Overview', path: '/community' },
  { label: 'Discover', path: '/search' },
  { label: 'Friends', path: '/friends' },
  { label: 'Messages', path: '/messages' },
  { label: 'Unions', path: '/unions' },
];

const REWARD_ITEMS: ArenaSectionItem[] = [
  { label: 'Overview', path: '/rewards' },
  { label: 'Wallet', path: '/wallet' },
  { label: 'Transactions', path: '/transactions' },
  { label: 'VIP', path: '/vip' },
  { label: 'Rakeback', path: '/rakeback' },
  { label: 'Promotions', path: '/promotions' },
  { label: 'Bonuses', path: '/bonuses' },
  { label: 'Achievements', path: '/achievements' },
  { label: 'Challenges', path: '/challenges' },
  { label: 'Marketplace', path: '/marketplace' },
];

const ACCOUNT_ITEMS: ArenaSectionItem[] = [
  { label: 'Profile', path: '/profile' },
  { label: 'Settings', path: '/settings' },
  { label: 'Notifications', path: '/notifications' },
];

const SUPPORT_ITEMS: ArenaSectionItem[] = [
  { label: 'Help Center', path: '/help' },
  { label: 'Legal Center', path: '/legal' },
  { label: 'Fair Gaming', path: '/legal/fair-gaming' },
  { label: 'Terms', path: '/legal/tos' },
  { label: 'Privacy', path: '/legal/privacy' },
  { label: 'Promotion Rules', path: '/legal/promotions' },
];

function cleanPath(pathname: string): string {
  return pathname.replace(/\/+$/, '') || '/';
}

function isWithin(pathname: string, roots: readonly string[]): boolean {
  const current = cleanPath(pathname);
  return roots.some((root) => current === root || current.startsWith(`${root}/`));
}

/**
 * Secondary navigation belongs to a route family, not to every page.
 * Club routes already own a fixed, club-aware rail; immersive table routes
 * bypass AppLayout; Notifications deliberately remains flush to the header.
 */
/** What the caller knows that a path alone cannot say. */
export interface ArenaSectionOptions {
  /** fn_can_create_union said yes for this account (see useCanCreateUnion). */
  canCreateUnion?: boolean;
}

export function getArenaSectionNavigation(
  pathname: string,
  opts?: ArenaSectionOptions
): ArenaSectionNavigation | null {
  const current = cleanPath(pathname);

  if (
    isWithin(current, [
      '/play',
      '/tournaments',
      '/tournament-results',
      '/hand-history',
      '/session-history',
      '/leaderboard',
    ])
  ) {
    return { id: 'play', label: 'Play Records', items: PLAY_ITEMS };
  }

  if (isWithin(current, ['/community', '/search', '/friends', '/messages'])) {
    return { id: 'community', label: 'Community', items: COMMUNITY_ITEMS };
  }

  if (
    isWithin(current, [
      '/wallet',
      '/rewards',
      '/transactions',
      '/vip',
      '/rakeback',
      '/promotions',
      '/bonuses',
      '/achievements',
      '/challenges',
      '/marketplace',
    ])
  ) {
    return { id: 'rewards', label: 'Rewards Circuit', items: REWARD_ITEMS };
  }

  // A public player's `/profile/:userId` is a community destination, not an
  // account-control surface. Showing the Player Identity rail there selected
  // "Profile" even though that link opens the viewer's own profile.
  if (current === '/profile' || isWithin(current, ['/settings'])) {
    return { id: 'account', label: 'Player Identity', items: ACCOUNT_ITEMS };
  }

  if (isWithin(current, ['/help', '/legal'])) {
    return { id: 'support', label: 'Support & Rules', items: SUPPORT_ITEMS };
  }

  const unionMatch = current.match(/^\/unions\/([^/]+)/);
  if (current === '/unions' || current === '/unions/create') {
    return {
      id: 'union',
      label: 'Union Network',
      items: [
        { label: 'Directory', path: '/unions' },
        /* Create Union is an allowlisted door (Dan 2026-09-04). The rail is a
           pure function of the path, so the caller passes what it knows;
           absent an explicit yes, the entry is not offered. */
        ...(opts?.canCreateUnion ? [{ label: 'Create Union', path: '/unions/create' }] : []),
      ],
    };
  }
  if (unionMatch) {
    const unionId = unionMatch[1];
    const gamesPath = `/unions/${unionId}/games`;
    const ownerWorkspace = current !== gamesPath;
    const items: ArenaSectionItem[] = [
      { label: 'Directory', path: '/unions' },
      { label: 'Overview', path: `/unions/${unionId}` },
      { label: 'Games', path: gamesPath },
    ];
    // UnionDetailPage is owner-only and the statement/settlement routes have
    // server-side oversight gates. Union Games can be opened by club members,
    // so its rail deliberately omits those financial destinations.
    if (ownerWorkspace) {
      items.push(
        { label: 'Operations', path: `/unions/${unionId}/operations` },
        { label: 'Statements', path: `/unions/${unionId}/statements` },
        { label: 'Settlement', path: `/unions/${unionId}/settlement` }
      );
    }
    return {
      id: 'union',
      label: 'Union Network',
      items,
    };
  }

  return null;
}

/** Pick one current item even when parent and child paths both match. */
export function getActiveArenaSectionPath(
  pathname: string,
  items: readonly ArenaSectionItem[]
): string | null {
  const current = cleanPath(pathname);
  return (
    items
      .filter(({ path }) => current === path || current.startsWith(`${path}/`))
      .sort((a, b) => b.path.length - a.path.length)[0]?.path || null
  );
}
