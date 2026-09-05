import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const read = (path: string) => readFileSync(resolve(process.cwd(), path), 'utf8');

const SEARCH = read('src/pages/SearchPage.tsx');
const FRIENDS = read('src/pages/FriendsPage.tsx');
const CHALLENGE_PANEL = read('src/components/social/FriendChallengesPanel.tsx');
const CHALLENGE_MODAL = read('src/components/social/FriendChallengeModal.tsx');
const ACTIVITY = read('src/components/social/FriendActivityFeed.tsx');

describe('Community Command Center information architecture', () => {
  it('makes search scope and submitted query addressable', () => {
    expect(SEARCH).toContain("searchParams.get('type') || searchParams.get('tab')");
    expect(SEARCH).toContain("next.set('type', nextCategory)");
    expect(SEARCH).toContain("next.set('q', nextQuery.trim())");
    expect(SEARCH).toContain('role="tablist"');
    expect(SEARCH).toContain('role="tabpanel"');
    expect(SEARCH).toContain("next.delete('tab')");
    expect(SEARCH).toContain('setSearchParams(next, { replace: true })');
  });

  it('queries independent community indexes concurrently and exposes failures', () => {
    expect(SEARCH).toContain('Promise.allSettled([');
    expect(SEARCH).toContain('setSearchError(');
    expect(SEARCH).toContain('role="alert"');
    expect(SEARCH).not.toContain('setRecentSearches((prev)');
  });

  it('searches players through the privacy-aware RPC and falls back to a recent snapshot on total failure', () => {
    // 2026-09-05: the raw `ilike` on profiles is gone. fn_search_players owns
    // fuzzy player matching AND the discoverable preference; the page must
    // not re-implement either.
    expect(SEARCH).toContain('PlayerSearchService.search({');
    expect(SEARCH).not.toContain('PLAYER_NAME_COLUMNS');
    expect(SEARCH).toContain('readSearchCache(normalized, category)');
    expect(SEARCH).toContain('writeSearchCache(normalized, category, next)');
    expect(SEARCH).toContain("searchFreshness === 'cached'");
  });

  it('gives every friends state a canonical shareable query while preserving aliases', () => {
    expect(FRIENDS).toContain(
      "type FriendsTab = 'friends' | 'requests' | 'activity' | 'challenges'"
    );
    expect(FRIENDS).toContain("if (value === 'pending') return 'requests'");
    expect(FRIENDS).toContain("if (value === 'recent') return 'activity'");
    expect(FRIENDS).toContain("next.set('tab', tab)");
    expect(FRIENDS).toContain('role="tablist"');
    expect(FRIENDS).toContain('role="tabpanel"');
  });

  it('removes the dead recent-player placeholder and consolidates discovery under Activity', () => {
    expect(FRIENDS).not.toContain('RecentPlayers');
    expect(FRIENDS).toContain('<FriendActivityFeed friends={friends} />');
    expect(FRIENDS).toContain('<FriendSuggestions />');
    expect(existsSync(resolve(process.cwd(), 'src/components/social/RecentPlayers.tsx'))).toBe(
      false
    );
  });
});

describe('Community Command Center interaction contracts', () => {
  it('hands every player message to the canonical Messenger compose contract', () => {
    expect(SEARCH).toContain('`/messages?compose=${player.id}`');
    expect(FRIENDS).toContain('`/messages?compose=${friend.user_id}`');
    expect(SEARCH).not.toContain('handleMessagePlayer');
    expect(FRIENDS).not.toContain('/messages/new?userId=');
  });

  it('uses explicit relationship actions and a destructive confirmation', () => {
    expect(FRIENDS).toContain('Actions For ${friend.username}');
    expect(FRIENDS).toMatch(/>\s*Message\s*<\/button>/);
    expect(FRIENDS).toMatch(/>\s*Challenge\s*<\/button>/);
    expect(FRIENDS).toMatch(/>\s*Remove\s*<\/button>/);
    expect(FRIENDS).toContain('<ConfirmModal');
    expect(FRIENDS).not.toContain('useSwipeAction');
  });

  it('progressively renders large friend networks without limiting search or export', () => {
    expect(FRIENDS).toContain('const FRIENDS_PAGE_SIZE = 40');
    expect(FRIENDS).toContain('.slice(0, visibleFriendCount)');
    expect(FRIENDS).toContain('setVisibleFriendCount((current) => current + FRIENDS_PAGE_SIZE)');
    expect(FRIENDS).toContain("exportToCSV(filteredFriends, 'friends_list.csv'");
  });

  it('keeps every relationship tab fully visible and tappable on phones', () => {
    const friendsCss = read('src/pages/FriendsPage.css');

    expect(friendsCss).toMatch(
      /@media \(max-width: 500px\)[\s\S]*?\.friends-tab-rail button \{[\s\S]*?flex: 1 1 0;[\s\S]*?min-width: 0;/
    );
    expect(friendsCss).toMatch(
      /@media \(max-width: 500px\)[\s\S]*?\.friends-tab-rail \{[\s\S]*?overflow-x: clip;/
    );
  });

  it('pages the complete relationship set and resolves profiles without Unknown identities', () => {
    expect(FRIENDS).toContain('readCompleteSocialSet<FriendshipEdge>');
    expect(FRIENDS).toContain('chunkSocialProfileIds(allProfileIds)');
    expect(FRIENDS).toContain('PLAYER_NAME_COLUMNS');
    expect(FRIENDS).toContain('resolveSocialProfile(');
    expect(FRIENDS).not.toContain(
      "username: profileMap[friendship.friendId]?.username || 'Unknown'"
    );
    expect(FRIENDS).toContain('profile_available: resolved.available');
  });

  it('combines realtime and fresh persisted presence without trusting stale online flags', () => {
    expect(FRIENDS).toContain('isSocialProfileOnline(');
    expect(FRIENDS).toContain('formatSocialLastSeen(friend.last_seen)');
    expect(FRIENDS).toContain('is_online, last_seen');
  });

  it('keeps challenge and activity data live while making failure states recoverable', () => {
    expect(CHALLENGE_PANEL).toContain("supabase.rpc('fn_respond_friend_challenge'");
    expect(CHALLENGE_PANEL).toContain('if (challengeError) throw challengeError');
    expect(CHALLENGE_PANEL).toContain('onClick={load}');
    expect(ACTIVITY).toContain('Promise.all([');
    expect(ACTIVITY).toContain('onClick={loadRealActivities}');
  });

  it('makes the challenge composer a named, trapped dialog', () => {
    expect(CHALLENGE_MODAL).toContain('useFocusTrap(isOpen)');
    expect(CHALLENGE_MODAL).toContain('role="dialog"');
    expect(CHALLENGE_MODAL).toContain('aria-modal="true"');
    expect(CHALLENGE_MODAL).toContain('aria-pressed={selectedType === type.id}');
    expect(CHALLENGE_MODAL).toContain("event.key === 'Escape'");
  });
});

describe('#SmarterCasinoRealism community surfaces', () => {
  it('shares one cinematic network anchor and avoids glassmorphism', () => {
    const hero = read('src/components/community/CommunitySurfaceHeader.module.css');
    const heroComponent = read('src/components/community/CommunitySurfaceHeader.tsx');
    const searchCss = read('src/pages/SearchPage.module.css');
    const friendsCss = read('src/pages/FriendsPage.css');
    const modalCss = read('src/components/social/FriendChallengeModal.css');

    expect(heroComponent).toContain("mediaUrl('images/community/community-network-v1.webp')");
    expect(hero).toContain('#030609');
    expect(hero).toContain('#3aa8ff');
    expect(searchCss).toContain('border-radius: 3px');
    expect(friendsCss).toContain('#26333d');
    expect([hero, searchCss, friendsCss, modalCss].join('\n')).not.toContain('backdrop-filter');
  });
});
