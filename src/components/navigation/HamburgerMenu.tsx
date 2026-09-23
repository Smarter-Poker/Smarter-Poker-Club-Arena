/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * HAMBURGER MENU — Smarter Casino Realism Command Drawer
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Clean, classy navigation with complete page coverage
 * No emojis - professional Facebook-style design
 */

import React, { useEffect, useId, useMemo, useRef, useState } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { supabase } from '../../lib/supabase';
import { identityDNA } from '../../core/IdentityDNA';
import { useAuthUser } from '../../hooks/useAuthUser';
import { unionService } from '../../services/UnionService';
import { useToast } from '../common/Toast';
import { masterBus } from '../../core/MasterBus';
import { useMasterBusSubscription } from '../../hooks/useMasterBusSubscription';
import { useWalletStore } from '../../stores/useWalletStore';
import { useHeaderDataStore } from '../../stores/useHeaderDataStore';
import { STORAGE_KEYS } from '../../lib/storage';
import { persistIdentity } from '../../lib/cachedIdentity';
import { generateDefaultAvatar } from '../../utils/avatarGenerator';
import { preloadRoute } from '../../utils/ChunkPreloader';
import { useUserTableSettings } from '../../hooks/useUserTableSettings';
import { TableSettingsPanel } from '../table/TableSettingsPanel';
import { ThemeSettingsModal } from '../table/ThemeSettingsModal';
import { getClubLevel, ClubLevelInfo } from '../../utils/clubLevels';
import { resolveClubUUID } from '../../utils/clubIdResolver';
import { reportError } from '../../utils/errorReporter';
import { AUTH_STORAGE_KEY, SPA_AUTH_BREADCRUMB } from '../../lib/authUtils';
import { isPlatformStaffRole } from '../../utils/platformRoles';
import { fetchGameCreationAccess } from '../../services/GameAccessService';
import { soundService } from '../../services/SoundService';
import { isSoundAllowed } from '../../utils/soundGate';
import { isVibrationPreferred, setVibrationAllowed } from '../../utils/vibrationGate';
import { AvatarGallery } from '../customization/AvatarGallery';
import AvatarCosmetics from '../avatars/AvatarCosmetics';
import { CLUB_ARENA_SUPPORT_NAV, getClubArenaNavigation } from '../../config/clubArenaNavigation';
import { switchClubTarget } from '../../utils/clubScopedPath';
import { useClubWorkspace } from '../../contexts/ClubWorkspaceContext';
import { capture } from '../../lib/analytics';
import { fetchQuickLinkClubs, type QuickLinkClub } from '../../utils/clubQuickLink';
import {
  LeaderboardService,
  type LeaderboardRewardContext,
} from '../../services/LeaderboardService';
import {
  clearTableStudioCheckoutReturnUrl,
  readTableStudioCheckoutIntent,
  tableStudioCheckoutResult,
} from '../../lib/tableStudioCheckoutResume';
import { formatPopupText } from '../../utils/popupStyle';
import { playerDisplayName, PLAYER_NAME_COLUMNS } from '../../utils/playerDisplayName';
import styles from './HamburgerMenu.module.css';
import { useCanCreateUnion, useCanOperateUnionNetwork } from '../../hooks/useCanCreateUnion';
import { mediaUrl } from '../../utils/mediaBase';
import { signInUrl } from '../../lib/signIn';
import { rewardToolMatchesSearch as matchesRewardToolSearch } from './rewardToolSearch';

/* Dan 2026-08-30: "THE FIRST LETTER OF EVERY WORD INSIDE THE HAMBURGER MENU
   MUST BE CAPITALIZED. AS WELL AS EVERY CLICKABLE PAGE AND SUBPAGE."
   Enforced in the render path — the same reasoning as the Toast layer's house
   rule: hundreds of label/description strings are written by many agents, and
   a style that lives in a convention drifts by the next commit. Every label
   and description this drawer renders passes through here. */
const tc = formatPopupText;

interface HamburgerMenuProps {
  isOpen: boolean;
  onClose: () => void;
}

// Facebook Dark Theme Colors (matching globals.css CSS variables)
const colors = {
  bg: 'var(--near-black)', // #18191A
  bgSecondary: 'var(--dark-surface)', // #242526
  bgHover: 'var(--card-surface)', // #3A3B3C
  text: 'var(--off-white)', // #E4E6EB
  textSecondary: 'var(--soft-white)', // #B0B3B8
  divider: 'var(--border-subtle)', // rgba(255,255,255,0.1)
  accent: 'var(--royal-blue)', // #1877F2
  accentHover: 'var(--royal-blue-dark)', // #0D5DC7
  success: 'var(--success)', // #31A24C
  danger: 'var(--danger)', // #F02849
};

export default function HamburgerMenu({ isOpen, onClose }: HamburgerMenuProps) {
  const navigate = useNavigate();
  const { user } = useAuthUser();
  const toast = useToast();
  const touchStartRef = useRef<number | null>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);
  const previousBodyOverflowRef = useRef('');
  const navigatingRef = useRef(false);
  const dialogTitleId = useId();
  const tableSettingsId = useId();

  /**
   * LAZY INITIALIZERS (2026-08-28, first-paint flash sweep): these four
   * toggles began at hard-coded defaults and read localStorage one tick
   * later in the load effect — so an open drawer could flash the wrong
   * switch positions. The read is synchronous; do it before the first
   * paint, before any asynchronous profile refinement. The load
   * effect's async profile fetch still refines them afterwards.
   */
  const readStoredBool = (key: string, fallback: boolean): boolean => {
    try {
      const raw = localStorage.getItem(key);
      return raw === null ? fallback : raw === 'true';
    } catch {
      return fallback;
    }
  };
  /* SEED FROM THE GATES, not from one of the two keys each gate reads.
     `soundGate` and `vibrationGate` fail closed on EITHER of their keys; reading
     only `club_arena_sounds` here meant a player who had muted IN-TABLE
     ('ca_sound_enabled'='false') opened this menu to a Sounds switch reading ON
     over a silent app. `useTableSound` was converted to `isSoundAllowed()` on
     2026-08-29 for exactly this reason and this component was not — the fourth
     hand-rolled copy of a two-key rule that lives in one place. */
  const [soundsEnabled, setSoundsEnabled] = useState(() => isSoundAllowed());
  const [vibrationsEnabled, setVibrationsEnabled] = useState(() => isVibrationPreferred());
  /* `showBBEnabled` state DELETED 2026-08-29: it was written in three places
     and READ IN NONE — no JSX, no condition. The switch a player sees lives in
     the expandable TableSettingsPanel and reads the hook directly. What
     survives is the localStorage MIRROR below, which is a real first-paint seed
     for the next cold open; the `setState` beside it only forced a re-render
     that changed nothing on screen. */
  // Avatar from persistent header store (avoids duplicate Supabase query)
  const avatarUrl = useHeaderDataStore((s) => s.avatarUrl);
  const equippedFrame = useHeaderDataStore((s) => s.equippedFrame);
  const equippedAura = useHeaderDataStore((s) => s.equippedAura);
  const [userName, setUserName] = useState<string>('');
  const [useRealName, setUseRealName] = useState(() =>
    readStoredBool(STORAGE_KEYS.USE_REAL_NAME, false)
  );
  const [showAvatarGallery, setShowAvatarGallery] = useState(false);
  const [isVIP, setIsVIP] = useState(false);
  const [isPlatformStaff, setIsPlatformStaff] = useState(false);
  const { diamonds: diamondBalance } = useWalletStore();
  // Bible V8 §11.1: User table settings (12 toggles) from Supabase
  const {
    settings: tableSettings,
    loading: tableSettingsLoading,
    toggleSetting: toggleTableSetting,
  } = useUserTableSettings(user?.id);
  /* THE ONLY WRITER of this switch's state and of its localStorage key.
     `useUserTableSettings` is the single reader of the canonical column, so
     mirroring here — rather than in a query of this component's own — is what
     removed the two-callback race described further down. The localStorage key
     is a first-paint seed for the next cold open; keeping it in step here
     means it can never disagree with the row for a whole session. */
  useEffect(() => {
    /* Wait for the row. Until it lands the hook is serving defaults, and
       writing those over the localStorage seed would show a cold-open user
       chips for a moment and then persist that as their answer. */
    if (tableSettingsLoading) return;
    try {
      localStorage.setItem(STORAGE_KEYS.SHOW_STACK_BB, String(tableSettings.show_stack_in_bb));
    } catch {
      /* private mode */
    }
  }, [tableSettings.show_stack_in_bb, tableSettingsLoading]);
  const [showTableSettings, setShowTableSettings] = useState(false);
  const [showThemeSettings, setShowThemeSettings] = useState(false);
  const checkoutResumeHandledRef = useRef(false);

  const location = useLocation();
  const workspace = useClubWorkspace();
  const { canCreateUnion } = useCanCreateUnion();
  const { canOperateUnionNetwork } = useCanOperateUnionNetwork();
  const [clubLevelInfo, setClubLevelInfo] = useState<ClubLevelInfo | null>(null);
  const [clubChoices, setClubChoices] = useState<QuickLinkClub[]>([]);
  const [searchQuery, setSearchQuery] = useState('');
  const [attentionCount, setAttentionCount] = useState(0);
  const [rewardContexts, setRewardContexts] = useState<LeaderboardRewardContext[]>([]);
  const [rewardContextClubId, setRewardContextClubId] = useState<string>('');
  const [canManageGames, setCanManageGames] = useState(false);
  /**
   * The union this club is operated from, when the signed-in user is one of its
   * operators - its owner OR one of its union_admins.
   *
   * A member club's games are run from the union console, which is why
   * canManageGames goes false as soon as access.unionId is set. That correctly
   * hid the CLUB entry and then offered nothing in its place, so a union
   * operator had no Table Management door anywhere in the navigation. Owners
   * could still reach it through the union page; admins are bounced off that
   * page entirely, so for them the feature was unreachable from their account.
   */
  const [unionManageId, setUnionManageId] = useState<string | null>(null);
  const [gameAccessRevision, setGameAccessRevision] = useState(0);

  // Stripe returns to the route where the player opened Table Studio. The
  // command drawer is mounted globally even while closed, so it is the one
  // launcher that can reliably restore the Studio on tables, settings and club
  // pages alike. The modal revalidates the stored asset and live price.
  useEffect(() => {
    if (checkoutResumeHandledRef.current) return;
    const result = tableStudioCheckoutResult(location.search);
    if (!result || !user?.id) return;
    checkoutResumeHandledRef.current = true;
    if (!readTableStudioCheckoutIntent(user.id)) {
      clearTableStudioCheckoutReturnUrl();
      toast.error('Your Previous Design Could Not Be Restored. Choose It Again To Continue.');
      return;
    }
    setShowThemeSettings(true);
  }, [location.search, toast, user?.id]);
  const recentStorageKey = `club_arena_nav_recents_v1:${user?.id || 'signed-out'}`;
  const pinStorageKey = `club_arena_nav_pins_v1:${user?.id || 'signed-out'}`;
  const [recentPaths, setRecentPaths] = useState<string[]>(() => {
    try {
      return JSON.parse(localStorage.getItem(recentStorageKey) || '[]');
    } catch {
      return [];
    }
  });
  const [pinnedPaths, setPinnedPaths] = useState<string[]>(() => {
    try {
      return JSON.parse(localStorage.getItem(pinStorageKey) || '[]');
    } catch {
      return [];
    }
  });

  /* ── THE MENU STAYS INSIDE THE CLUB YOU ARE INSIDE ────────────────────────
     Dan, 2026-09-02: "IF YOU ARE A PART OF MULTIPLE CLUBS (OR UNIONS) IT
     SHOULD ALWAYS BE OPEN TO THAT SPECIFIC CLUB."

     This read `location.pathname` alone, so the drawer only knew which club
     it was in while standing on a `/clubs/…` URL. The moment you took one
     club-scoped link — Leaderboards, Wallet, Marketplace, all of which live
     at global paths — `clubId` went null, every subsequent link in the drawer
     was rebuilt without a club, and the context select and staff sections
     disappeared. The club survived exactly one hop.

     `workspace.routeClubId` is the existing reader that already looks at BOTH
     the path and `?club=` (ClubWorkspaceContext.getRouteClubId), and the
     provider is mounted above this component. Using it means the drawer holds
     the club across every page in the club-scoped set, and the identifier it
     hands to `getClubArenaNavigation` is the same string the URL is carrying
     — slug stays slug, which is Dan's "THE SLUGS MUST MATCH". */
  const clubId = workspace.routeClubId;
  const clubRole = workspace.clubRole;
  /* EITHER READER MAY SAY YES; NEITHER MAY VETO. This was
     `clubId ? workspace.isPlatformStaff : isPlatformStaff`, which was safe
     only while `clubId` meant "on a /clubs/… path". Now that it is also true
     on `/leaderboard?club=…`, that ternary would hand the whole decision to
     the workspace on ordinary global pages — and the workspace reports
     `isPlatformStaff: false` while it is still loading, and again if its
     authorization read fails. An admin would have watched Platform Operations
     blink out of their drawer on every club-scoped page, and lose it outright
     on a network stumble.

     The two are independent reads of the same `profiles.role` column, so OR
     is not a widening of trust: it is two witnesses to one fact, and this
     drawer is navigation rather than an authorization boundary (the route and
     API guards are what actually enforce /admin). */
  const effectivePlatformStaff = workspace.isPlatformStaff || isPlatformStaff;
  const navigationGroups = getClubArenaNavigation({
    clubId,
    clubRole,
    isPlatformStaff: effectivePlatformStaff,
    canManageGames,
    canOperateUnionNetwork,
  });
  const allNavigationItems = useMemo(
    () => navigationGroups.flatMap((group) => group.items),
    [navigationGroups]
  );
  const filteredNavigationGroups = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();
    if (!query) return navigationGroups;
    return navigationGroups
      .map((group) => ({
        ...group,
        items: group.items.filter((item) =>
          `${item.label} ${item.description}`.toLowerCase().includes(query)
        ),
      }))
      .filter((group) => group.items.length > 0);
  }, [navigationGroups, searchQuery]);
  const recentItems = recentPaths
    .map((path) => allNavigationItems.find((item) => item.path === path))
    .filter((item): item is (typeof allNavigationItems)[number] => Boolean(item))
    .slice(0, 3);
  const pinnedItems = pinnedPaths
    .map((path) => allNavigationItems.find((item) => item.path === path))
    .filter((item): item is (typeof allNavigationItems)[number] => Boolean(item));
  const rewardToolMatchesSearch = matchesRewardToolSearch(searchQuery);

  useEffect(() => {
    try {
      setRecentPaths(JSON.parse(localStorage.getItem(recentStorageKey) || '[]'));
      setPinnedPaths(JSON.parse(localStorage.getItem(pinStorageKey) || '[]'));
    } catch {
      setRecentPaths([]);
      setPinnedPaths([]);
    }
  }, [pinStorageKey, recentStorageKey]);

  const isActivePath = (path: string) => {
    const current = location.pathname.replace(/\/+$/, '') || '/';
    const target = path.split('?')[0].replace(/\/+$/, '') || '/';
    return target === '/'
      ? current === '/'
      : current === target || current.startsWith(`${target}/`);
  };

  useEffect(() => {
    if (!isOpen || !workspace.clubUUID) {
      setCanManageGames(false);
      setUnionManageId(null);
      return;
    }
    let cancelled = false;
    void fetchGameCreationAccess(workspace.clubUUID).then(async (access) => {
      if (cancelled) return;
      setCanManageGames(access.allowed && !access.unionId);
      if (!access.unionId || !user?.id) {
        setUnionManageId(null);
        return;
      }
      // Owner or union_admin - the same test the union board itself applies,
      // so the menu never offers a door the page would refuse.
      const operator = await unionService.isUnionAdmin(access.unionId, user.id);
      if (!cancelled) setUnionManageId(operator ? access.unionId : null);
    });
    return () => {
      cancelled = true;
    };
  }, [gameAccessRevision, isOpen, user?.id, workspace.clubUUID]);

  useMasterBusSubscription('GAME_MANAGEMENT_ACCESS_CHANGED', (payload) => {
    if (!payload.clubId || payload.clubId === workspace.clubUUID) {
      setGameAccessRevision((value) => value + 1);
    }
  });

  useEffect(() => {
    if (!isOpen || !clubId) {
      if (!clubId) {
        setClubLevelInfo(null);
      }
      return;
    }
    let isMounted = true;
    const fetchClubLevel = async () => {
      try {
        const resolvedId = await resolveClubUUID(clubId!);
        if (!isMounted) return;
        const { data } = await supabase
          .from('clubs')
          .select(
            'member_count, level, hierarchy_units_rounded_up, player_threshold_current, player_threshold_next, hierarchy_threshold_current, hierarchy_threshold_next'
          )
          .eq('id', resolvedId)
          .maybeSingle();

        if (data && isMounted) {
          setClubLevelInfo(
            getClubLevel({
              level: data.level || 1,
              playerCount: data.member_count || 0,
              hierarchyUnits: data.hierarchy_units_rounded_up || 0,
              playerThresholdCurrent: data.player_threshold_current || 0,
              playerThresholdNext: data.player_threshold_next || 0,
              hierarchyThresholdCurrent: data.hierarchy_threshold_current || 0,
              hierarchyThresholdNext: data.hierarchy_threshold_next || 0,
            })
          );
        }
      } catch {
        /* club-level fetch is best-effort; silent fallback to defaults above */
      }
    };
    fetchClubLevel();
    return () => {
      isMounted = false;
    };
  }, [isOpen, clubId, user?.id]);

  useEffect(() => {
    if (!isOpen) return;
    capture('club_arena_menu_opened', {
      route: location.pathname,
      club_id: workspace.clubUUID,
      club_role: clubRole,
      offline: workspace.isOffline,
    });
  }, [clubRole, isOpen, location.pathname, workspace.clubUUID, workspace.isOffline]);

  useEffect(() => {
    if (!isOpen || !user?.id) return;
    void fetchQuickLinkClubs(user.id).then(setClubChoices);
  }, [isOpen, user?.id]);

  useEffect(() => {
    if (!isOpen || !user?.id) {
      if (!user?.id) {
        setRewardContexts([]);
        setRewardContextClubId('');
      }
      return;
    }
    let cancelled = false;
    void LeaderboardService.getManageableRewardContexts(true)
      .then((contexts) => {
        if (cancelled) return;
        setRewardContexts(contexts);
        setRewardContextClubId((current) => {
          if (contexts.some((context) => context.club_id === current)) return current;
          const routeContext = contexts.find((context) => context.club_id === workspace.clubUUID);
          return routeContext?.club_id || contexts[0]?.club_id || '';
        });
      })
      .catch((error) => {
        if (cancelled) return;
        reportError(error, 'HamburgerMenu.Leaderboard_reward_contexts_failed');
        setRewardContexts([]);
        setRewardContextClubId('');
      });
    return () => {
      cancelled = true;
    };
  }, [isOpen, user?.id, workspace.clubUUID]);

  useEffect(() => {
    if (!isOpen || !workspace.clubUUID || !workspace.isClubStaff) {
      setAttentionCount(0);
      return;
    }
    let cancelled = false;
    void supabase
      .from('disputes')
      .select('id', { count: 'exact', head: true })
      .eq('club_id', workspace.clubUUID)
      .in('status', ['open', 'under_review', 'escalated'])
      .then(({ count, error }) => {
        if (error) {
          reportError(error, 'HamburgerMenu.Attention_count_failed');
          return;
        }
        if (!cancelled) setAttentionCount(count || 0);
      });
    return () => {
      cancelled = true;
    };
  }, [isOpen, workspace.clubUUID, workspace.isClubStaff]);

  const drawerRef = useRef<HTMLDivElement>(null);

  // Lock background scroll, contain keyboard focus, and restore the opener.
  useEffect(() => {
    if (!isOpen) return;

    previousFocusRef.current = document.activeElement as HTMLElement | null;
    previousBodyOverflowRef.current = document.body.style.overflow;
    navigatingRef.current = false;
    document.body.style.overflow = 'hidden';

    const drawer = drawerRef.current;
    if (!drawer) return;

    const getFocusable = () =>
      Array.from(
        drawer.querySelectorAll<HTMLElement>(
          'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
        )
      ).filter((element) => element.offsetParent !== null);

    const containFocus = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key !== 'Tab') return;

      const focusable = getFocusable();
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (!first || !last) {
        event.preventDefault();
        drawer.focus();
        return;
      }
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    drawer.addEventListener('keydown', containFocus);
    requestAnimationFrame(() => getFocusable()[0]?.focus());

    return () => {
      document.body.style.overflow = previousBodyOverflowRef.current;
      drawer.removeEventListener('keydown', containFocus);
      if (!navigatingRef.current && previousFocusRef.current?.isConnected) {
        previousFocusRef.current.focus();
      }
    };
  }, [isOpen, onClose]);

  // Load user data and settings
  useEffect(() => {
    /* ── THE GATES, NOT ONE OF THEIR TWO KEYS ────────────────────────────
       This read `STORAGE_KEYS.SOUNDS` ('club_arena_sounds') and
       `STORAGE_KEYS.VIBRATIONS` ('vibrationsEnabled') RAW and unconditionally
       — so it overwrote the gate-derived seed above one render later, and
       undid the fix that seed exists to be. In the exact case that fix names
       (`ca_sound_enabled='false'`, `club_arena_sounds='true'`) the switch went
       back to reading ON over a silent app.

       Both gates fail closed on EITHER of their two keys, so re-reading them
       here is the only answer that agrees with the seed AND with the engine.
       `useRealName` keeps its raw read: it has one key and no gate. */
    setSoundsEnabled(isSoundAllowed());
    setVibrationsEnabled(isVibrationPreferred());
    const useReal = localStorage.getItem(STORAGE_KEYS.USE_REAL_NAME);
    if (useReal !== null) setUseRealName(useReal === 'true');

    if (user?.id) {
      supabase
        .from('profiles')
        .select(
          `avatar_url:arena_avatar_url, ${PLAYER_NAME_COLUMNS}, sounds_enabled, vibrations_enabled, is_vip, tier, role`
        )
        .eq('id', user.id)
        .maybeSingle()
        .then(({ data, error }) => {
          if (error) {
            console.warn(
              '[HamburgerMenu] Profile load failed (using localStorage fallback):',
              error.message
            );
            return;
          }
          if (data) {
            // Avatar is consumed from useHeaderDataStore — no need to set locally
            /* Dan 2026-09-02: "THE CLUB ARENA SHOULD ALWAYS 100% OF THE TIME
               USE THE POKER ALIAS AND NOT THE REAL NAME." The header is an
               arena surface, so it no longer consults USE_REAL_NAME - that
               preference now governs social/World Hub display only, and the
               toggle below says so. */
            setUserName(playerDisplayName(data));
            // First-paint identity cache (2026-08-28 flash sweep): what the
            // database just said is what the header and hero seat should wear
            // on the NEXT cold open, before any round trip.
            persistIdentity(user.id, {
              displayName: playerDisplayName(data),
              avatarUrl: data.avatar_url || null,
            });
            /* ── `profiles.sounds_enabled` / `vibrations_enabled` ARE NO LONGER
                  READ BACK OVER THE GATES (2026-08-29) ──────────────────────
               This used to `setState` from the profile row AND write the gate's
               `club_arena_sounds` / `vibrationsEnabled` keys directly, bypassing
               `persistSoundPreference` and `setVibrationAllowed` (which write
               both of each gate's keys as a pair) and never calling
               `soundService.setEnabled`.

               That made `profiles` a SECOND DATABASE OWNER of "is sound on",
               alongside `user_table_settings.sound_enabled`, with nothing
               reconciling them — so muting at the table and then opening this
               menu re-asserted the stale profile value over the gate on every
               open. Only the gate's fail-closed rule stopped it actually
               un-muting anyone.

               The columns are still WRITTEN below (`updateSetting` mirrors to
               them for older surfaces). They are simply not an input any more:
               the gates are, and they are what the audio engine consults. */
            /* `profiles.show_stack_bb` is NOT read here any more — see the note
               where the second query used to be. */
            setIsVIP(data.is_vip || data.tier === 'vip' || false);
            setIsPlatformStaff(isPlatformStaffRole(data.role));
          }
        });

      /* ── WHY THERE IS NO show_stack_bb QUERY HERE ANY MORE (2026-08-29) ──
       *
       * Dan 2026-08-25 established the rule this still obeys: the felt reads
       * `user_table_settings.show_stack_in_bb`, `profiles.show_stack_bb` is a
       * legacy mirror, and whatever the table is actually obeying is what this
       * switch must display. No row means the user never chose, which is
       * chips, which is the default.
       *
       * The fix at the time added a SECOND query beside the profiles one, and
       * both wrote `setShowBBEnabled` and the same localStorage key from
       * unordered `.then()` callbacks. Whichever resolved last won, so the
       * legacy value could still land on top of the canonical one — the exact
       * disagreement the fix was written to end, now decided by network
       * timing rather than by a rule.
       *
       * Both queries are gone. `useUserTableSettings` is already mounted above
       * and already reads this column, on a request that is de-duplicated
       * across every consumer in the tab; the effect beside it mirrors its
       * value into state and into localStorage. One reader, one writer, no
       * race.
       *
       * The legacy `profiles.show_stack_bb` is now dead in BOTH directions: the
       * reads went with that fix, and `handleShowBBToggle` — the only thing
       * that ever wrote it — turned out to have had no caller since the day it
       * was added, and was deleted on 2026-08-29. An earlier version of this
       * comment claimed it was "still WRITTEN ... for older surfaces". It was
       * not. `user_table_settings.show_stack_in_bb` is the only copy.
       */
    }
  }, [user?.id]);

  // ── BUS LISTENER: Sync name when profile is updated elsewhere ──
  useMasterBusSubscription('USER_PROFILE_LOADED', (payload) => {
    // Avatar syncs automatically via useHeaderDataStore
    if (payload?.displayName) setUserName(payload.displayName);
  });

  // Swipe-to-close gesture
  const handleTouchStart = (e: React.TouchEvent) => {
    touchStartRef.current = e.touches[0].clientX;
  };

  const handleTouchEnd = (e: React.TouchEvent) => {
    if (touchStartRef.current === null) return;
    const touchEnd = e.changedTouches[0].clientX;
    const diff = touchStartRef.current - touchEnd;
    if (diff > 50) onClose();
    touchStartRef.current = null;
  };

  // Navigate and close
  const handleNavigate = (path: string) => {
    const nextRecentPaths = [path, ...recentPaths.filter((item) => item !== path)].slice(0, 5);
    setRecentPaths(nextRecentPaths);
    try {
      localStorage.setItem(recentStorageKey, JSON.stringify(nextRecentPaths));
    } catch {
      /* private mode */
    }
    capture('club_arena_navigation_selected', {
      route: path,
      from_route: location.pathname,
      club_id: workspace.clubUUID,
      source: 'hamburger',
    });
    navigatingRef.current = true;
    navigate(path);
    onClose();
  };

  /**
   * Switch club without losing the page you are on.
   *
   * This select used to be reachable only from a `/clubs/…` path, so sending
   * the player to that club's lobby was the whole of "switch club". Now that
   * the drawer keeps its club across `?club=`-scoped pages, the same control
   * appears on Leaderboards, Wallet and Marketplace — and jumping to the
   * lobby from there would answer "show me this in the other club" by
   * throwing away the page, which is the same class of fault as the bug this
   * branch fixes, just in the other direction.
   *
   * So: on a club-scoped global page, swap the club and STAY. Anywhere else,
   * the lobby remains the right destination.
   */
  const handleSwitchClub = (nextClubUUID: string) => {
    if (!nextClubUUID) return;
    const club = clubChoices.find((candidate) => candidate.id === nextClubUUID);
    handleNavigate(switchClubTarget(location, club ?? { id: nextClubUUID }));
  };

  // Table Studio is a modal destination, not content inside the command
  // drawer. Hand ownership to it in the same click: leaving the drawer open
  // puts its higher stacking layer and focus trap over the studio, so every
  // design tile looks visible but cannot be tapped on mobile or desktop.
  const handleOpenTableStudio = () => {
    setShowThemeSettings(true);
    onClose();
  };

  const togglePinnedPath = (path: string) => {
    const nextPinnedPaths = pinnedPaths.includes(path)
      ? pinnedPaths.filter((item) => item !== path)
      : [...pinnedPaths, path].slice(-6);
    setPinnedPaths(nextPinnedPaths);
    try {
      localStorage.setItem(pinStorageKey, JSON.stringify(nextPinnedPaths));
    } catch {
      /* private mode */
    }
  };

  // Prefetch page chunk on hover — so page loads instantly when clicked
  const handleItemHover = (path: string) => {
    preloadRoute(path);
  };

  // Settings update with optimistic rollback
  const updateSetting = async (
    localKey: string,
    dbKey: string,
    value: boolean,
    rollback: () => void
  ) => {
    try {
      localStorage.setItem(localKey, String(value));
    } catch (err) {
      reportError(err, 'HamburgerMenu.Error');
    }
    if (user?.id) {
      try {
        const { error: updateErr } = await supabase
          .from('profiles')
          .update({ [dbKey]: value })
          .eq('id', user.id);
        if (updateErr) {
          reportError(updateErr, 'HamburgerMenu.Setting_save_failed');
          toast.error('Setting could not be saved. Please try again.');
          rollback();
          try {
            localStorage.setItem(localKey, String(!value));
          } catch {
            /* */
          }
        }
      } catch (error) {
        reportError(error, 'HamburgerMenu.Error_updating_setting');
        toast.error('Setting could not be saved. Please try again.');
        rollback();
        try {
          localStorage.setItem(localKey, String(!value));
        } catch {
          /* */
        }
      }
    }
  };

  const handleSoundsToggle = () => {
    const newValue = !soundsEnabled;
    setSoundsEnabled(newValue);
    updateSetting(STORAGE_KEYS.SOUNDS, 'sounds_enabled', newValue, () =>
      setSoundsEnabled(!newValue)
    );
    // SOUND AUDIT 2026-08-27: this toggle wrote only STORAGE_KEYS.SOUNDS.
    // The shared gate fails closed on EITHER key, so a player who had muted
    // in-table ('ca_sound_enabled'='false') and then flipped this switch ON
    // got a switch reading ON with a still-silent app. setEnabled() persists
    // the choice to BOTH gate keys so the switches always agree.
    soundService.setEnabled(newValue);
    masterBus.emit('SETTINGS_CHANGED', { setting: 'isSoundEnabled', value: newValue });
  };

  const handleVibrationsToggle = () => {
    const newValue = !vibrationsEnabled;
    setVibrationsEnabled(newValue);
    updateSetting(STORAGE_KEYS.VIBRATIONS, 'vibrations_enabled', newValue, () =>
      setVibrationsEnabled(!newValue)
    );
    /* Through the GATE, which writes both of its keys. The sound sibling above
       got `soundService.setEnabled` on 2026-08-27 for precisely this reason and
       the haptic half was left behind: turning vibration ON here could not clear
       a mute set by the in-table switch, because the gate fails closed on
       `ca_vibration_enabled` and nothing here ever touched it. */
    setVibrationAllowed(newValue);
    /* 2026-08-26: the key was `vibrationsEnabled`, which is NOT a field of
       useTableSettings — the store calls it `isHapticEnabled` — so the
       whitelist at useTableSettings dropped this event silently and an open
       table never learned haptics had been turned off. (The localStorage
       write above still worked, which is why it half-functioned and was easy
       to miss.) The store's own name is what the bus must carry. */
    masterBus.emit('SETTINGS_CHANGED', { setting: 'isHapticEnabled', value: newValue });
  };

  /* ── `handleShowBBToggle` DELETED 2026-08-29 ────────────────────────────
     It had never had a caller. `git log -S` puts it back to the commit that
     added it: no `onClick`, no "Show Stack In Big Blinds" control anywhere in
     this component's JSX — that switch lives in the expandable
     `TableSettingsPanel`, which writes through `useUserTableSettings` on its
     own.

     It was left in place on 2026-08-29 alongside a fresh comment claiming
     "the legacy column is still WRITTEN by handleShowBBToggle for older
     surfaces, which is a mirror rather than a second opinion." That was false
     in both halves: the function wrote nothing because nothing called it, and
     the same commit had just deleted the two `.select()` calls that read
     `profiles.show_stack_bb`. The legacy column is dead in both directions.

     That is the more useful fact and it is why this note is here rather than
     nothing: a future reader looking for the legacy mirror will not find one,
     and should not add one back. `user_table_settings.show_stack_in_bb` is the
     only copy of this preference. */

  const handleResetTutorial = async () => {
    localStorage.removeItem(STORAGE_KEYS.INTRO_SHOWN);
    localStorage.removeItem(STORAGE_KEYS.TUTORIAL_COMPLETED);
    /**
     * There is no `profiles.tutorial_completed` column and nothing anywhere
     * reads one. This used to write it, which was rejected on every reset and
     * reported as a failure the user never saw - and had the column existed,
     * the reset would still have worked exactly as it does now, because
     * localStorage above is the only thing the intro gate consults. Removing
     * the write loses no behaviour; it removes a control that was never wired
     * to anything. Making it a real cross-device flag needs a reader first.
     */
    toast.info('Tutorial reset! Refresh the page to see the intro again.');
    onClose();
  };

  const handleUseRealNameToggle = () => {
    const newValue = !useRealName;
    setUseRealName(newValue);
    updateSetting(STORAGE_KEYS.USE_REAL_NAME, 'use_real_name', newValue, () =>
      setUseRealName(!newValue)
    );
    masterBus.emit('SETTINGS_CHANGED', { setting: 'useRealName', value: newValue });

    // Switch the local preview
    if (user?.id) {
      supabase
        .from('profiles')
        .select(PLAYER_NAME_COLUMNS)
        .eq('id', user.id)
        .maybeSingle()
        .then(({ data }) => {
          if (data) {
            /* The preference changed, but the arena name did not depend on it
               and still does not. Re-read so the header reflects any other
               edit, and resolve it the one way. */
            setUserName(playerDisplayName(data));
          }
        });
    }
  };

  /**
   * LOG OUT — leaves nothing to chance and nothing to another component.
   *
   * 2026-09-04: "click the hamburger, click Log Out, it silently fails."
   * Three ways this click could produce no visible effect, all closed here:
   *
   * 1. signOut FAILING SILENTLY. GoTrue resolves with { error } rather than
   *    throwing for anything that is not 401/403/404 (offline, 5xx, a 429), and
   *    on that path it returns BEFORE _removeSession() — so `smarter-poker-auth`
   *    survives in localStorage and no SIGNED_OUT event is ever emitted. The old
   *    catch block never fired. Worse, AuthGuard reads exactly that key and, on
   *    finding it, logs "re-hydrating instead of redirecting" and deliberately
   *    stays put. The user was signed back in by the safety net. We now clear
   *    the key ourselves, unconditionally, on every path.
   *
   * 2. NO AuthGuard MOUNTED. The redirect was delegated to AuthGuard, but the
   *    legal routes this very drawer links to (/legal, /legal/tos,
   *    /legal/privacy, /legal/fair-gaming, /legal/promotions) are declared
   *    without one. Signing out there succeeded and nothing moved. The redirect
   *    is now issued here, so it does not depend on who is mounted.
   *
   * 3. THE STALE BREADCRUMB. AuthGuard delays every real sign-out by 800ms
   *    because the sessionStorage breadcrumb still says "recently authenticated"
   *    — it was written on login and never cleared. We clear it before leaving.
   */
  const signingOutRef = useRef(false);
  const handleLogOut = async () => {
    if (signingOutRef.current) return; // second tap while the first is in flight
    signingOutRef.current = true;
    try {
      // identityDNA.logout() still owns the happy path: it triggers the auth
      // listener, which clears the Zustand store, destroys PostgresSyncHooks,
      // purges the per-user caches and emits AUTH_STATE_CHANGED.
      await identityDNA.logout();
    } catch (error) {
      reportError(error, 'HamburgerMenu.Error_logging_out');
      try {
        const { useUserStore } = await import('../../stores/useUserStore');
        useUserStore.getState().logout();
      } catch {
        /* store already gone */
      }
    } finally {
      // Everything below runs whether the server round-trip worked or not.
      // This is what makes the sign-out real and visible.
      try {
        localStorage.removeItem(AUTH_STORAGE_KEY);
      } catch {
        /* private mode */
      }
      try {
        sessionStorage.removeItem(SPA_AUTH_BREADCRUMB);
      } catch {
        /* private mode */
      }
      onClose();
      // Web: the World Hub login. Native: the in-app AuthPage (src/lib/signIn).
      window.location.href = signInUrl(location.pathname + location.search);
    }
  };

  // Shared styles
  const dividerStyle: React.CSSProperties = {
    height: 1,
    background: colors.divider,
    margin: '8px 16px',
  };

  // Do not leave an off-canvas tree full of focusable controls in the tab order.
  if (!isOpen) {
    return showThemeSettings ? (
      <ThemeSettingsModal
        isOpen
        onClose={() => setShowThemeSettings(false)}
        userId={user?.id || ''}
        isVip={isVIP}
        checkoutReturnResult={tableStudioCheckoutResult(location.search)}
      />
    ) : null;
  }

  return (
    <>
      {/* Animation keyframes */}
      <style>{`
                @keyframes slideInLeft {
                    from {
                        opacity: 0;
                        transform: translateX(-12px);
                    }
                    to {
                        opacity: 1;
                        transform: translateX(0);
                    }
                }
            `}</style>

      {/* Backdrop */}
      <div className={styles.backdrop} onClick={onClose} aria-hidden="true" />

      {/* Drawer */}
      <div
        ref={drawerRef}
        onTouchStart={handleTouchStart}
        onTouchEnd={handleTouchEnd}
        className={`${styles.drawer} ${styles.drawerOpen}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby={dialogTitleId}
        tabIndex={-1}
      >
        <div className={styles.utilityRail}>
          <div className={styles.brandLockup}>
            <img src={mediaUrl('images/diamond-icon.webp')} alt="" className={styles.brandMark} />
            <span>
              <span className={styles.brandEyebrow}>Smarter.Poker</span>
              <span className={styles.brandTitle} id={dialogTitleId}>
                Poker Arena
              </span>
            </span>
          </div>
          <button type="button" onClick={onClose} className={styles.closeButton}>
            Close
          </button>
        </div>

        {/* User Profile Card */}
        <button
          type="button"
          onClick={() => handleNavigate('/profile')}
          className={styles.profilePlate}
        >
          {/* Wrapped so the equipped frame/aura has a positioned, radius-owning
              parent to fill. The <img> itself cannot be that parent: an
              absolutely positioned child of an <img> is not a thing. */}
          <div
            style={{
              position: 'relative',
              width: 48,
              height: 48,
              borderRadius: '50%',
              flexShrink: 0,
              fontSize: 11,
            }}
          >
            <img
              loading="lazy"
              decoding="async"
              src={avatarUrl || generateDefaultAvatar()}
              alt=""
              style={{
                width: 48,
                height: 48,
                borderRadius: '50%',
                objectFit: 'cover',
                border: `2px solid ${colors.divider}`,
              }}
            />
            <AvatarCosmetics frame={equippedFrame} aura={equippedAura} />
          </div>
          <div>
            <div className={styles.profileName}>
              {userName || 'Player'}
              {isVIP && (
                <span className={styles.vipBadge} title="VIP Diamond Member">
                  VIP
                </span>
              )}
            </div>
            <div className={styles.profileMeta}>
              <span>View Profile</span>
              {diamondBalance > 0 && (
                <span className={styles.diamondBalance}>{diamondBalance.toLocaleString()} DIA</span>
              )}
            </div>
          </div>
          <span className={styles.navArrow}>›</span>
        </button>

        <div style={dividerStyle} />

        <section className={styles.contextDeck} aria-label="Current Arena Context">
          <div className={styles.contextStatus}>
            <span
              className={`${styles.statusLamp} ${workspace.isOffline ? styles.statusLampOffline : ''}`}
              aria-hidden="true"
            />
            <span>
              {workspace.isOffline
                ? 'Offline - Queued Actions Remain Protected'
                : workspace.isStale
                  ? 'Live Circuit - Refreshing Context'
                  : 'Live Circuit Connected'}
            </span>
            {clubRole && <strong>{tc(clubRole.replace(/_/g, ' '))}</strong>}
          </div>
          {clubId && clubChoices.length > 1 && (
            <label className={styles.contextSwitcher}>
              <span>Club Context</span>
              <select
                value={workspace.clubUUID || ''}
                onChange={(event) => handleSwitchClub(event.target.value)}
              >
                {clubChoices.map((club) => (
                  <option key={club.id} value={club.id}>
                    {club.name || club.club_id || 'Club'}
                  </option>
                ))}
              </select>
            </label>
          )}
          <form
            className={styles.menuSearch}
            role="search"
            onSubmit={(event) => {
              event.preventDefault();
              const query = searchQuery.trim();
              if (query) handleNavigate(`/search?q=${encodeURIComponent(query)}`);
            }}
          >
            <input
              type="search"
              value={searchQuery}
              onChange={(event) => setSearchQuery(event.target.value)}
              placeholder="Search Destinations Or The Arena"
              aria-label="Search Destinations Or The Arena"
            />
            <button type="submit" aria-label="Search All Players And Clubs">
              Search
            </button>
          </form>
        </section>

        {/* ═══════════════════════════════════════════════════════════════
                    CLUB LEVEL & PROGRESSION
                ═══════════════════════════════════════════════════════════════ */}
        {clubLevelInfo && (
          <>
            <div style={{ padding: '8px 16px 16px' }}>
              <div
                style={{
                  display: 'flex',
                  flexDirection: 'column',
                  gap: '10px',
                }}
              >
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    background:
                      clubLevelInfo.gradient || 'linear-gradient(to right, #4b5563, #374151)',
                    padding: '4px 10px',
                    borderRadius: '12px',
                    color: 'white',
                    fontWeight: 700,
                    width: 'fit-content',
                    boxShadow: '0 2px 8px rgba(0,0,0,0.4)',
                  }}
                >
                  <span style={{ fontSize: '13px', marginRight: '6px' }}>
                    Lv.{clubLevelInfo.level}
                  </span>
                  <span style={{ fontSize: '11px', opacity: 0.9 }}>{clubLevelInfo.tierLabel}</span>
                </div>
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: '10px',
                  }}
                >
                  <div
                    style={{
                      flex: 1,
                      height: '8px',
                      background: 'rgba(255,255,255,0.1)',
                      borderRadius: '4px',
                      overflow: 'hidden',
                      boxShadow: 'inset 0 1px 3px rgba(0,0,0,0.5)',
                    }}
                  >
                    <div
                      style={{
                        width: `${clubLevelInfo.progressPercent}%`,
                        height: '100%',
                        background:
                          clubLevelInfo.gradient || 'linear-gradient(to right, #4b5563, #374151)',
                        borderRadius: '4px',
                        boxShadow: '0 0 10px rgba(255,255,255,0.2)',
                      }}
                    />
                  </div>
                  <span style={{ fontSize: '12px', color: colors.textSecondary, fontWeight: 700 }}>
                    {clubLevelInfo.progressPercent}%
                  </span>
                </div>
              </div>
            </div>
            <div style={dividerStyle} />
          </>
        )}

        <div className={styles.quickActions} aria-label="Context Actions">
          {clubId && canManageGames ? (
            <button
              type="button"
              className={styles.quickAction}
              onClick={() => handleNavigate(`/clubs/${clubId}/table-management`)}
            >
              Table Management
            </button>
          ) : unionManageId ? (
            <button
              type="button"
              className={styles.quickAction}
              onClick={() => handleNavigate(`/unions/${unionManageId}/table-management`)}
            >
              Table Management
            </button>
          ) : (
            <button
              type="button"
              className={styles.quickAction}
              onClick={() => handleNavigate('/?create=club')}
            >
              Create Club
            </button>
          )}
          {clubId && workspace.canControlClub ? (
            <button
              type="button"
              className={styles.quickAction}
              onClick={() => handleNavigate(`/invite/${clubId}`)}
            >
              Invite Players
            </button>
          ) : canCreateUnion ? (
            <button
              type="button"
              className={styles.quickAction}
              onClick={() => handleNavigate('/unions/create')}
            >
              Create Union
            </button>
          ) : null}
          {clubId && workspace.canViewFinance && (
            <button
              type="button"
              className={`${styles.quickAction} ${styles.quickActionWide}`}
              onClick={() => handleNavigate(`/clubs/${clubId}/finance`)}
            >
              Open Finance & Risk
            </button>
          )}
        </div>

        {(pinnedItems.length > 0 || recentItems.length > 0) && !searchQuery && (
          <section className={styles.memoryRail} aria-label="Pinned And Recent Destinations">
            {pinnedItems.length > 0 && (
              <div>
                <h2 className={styles.sectionHeader}>Pinned</h2>
                <div className={styles.memoryLinks}>
                  {pinnedItems.map((item) => (
                    <button key={item.path} type="button" onClick={() => handleNavigate(item.path)}>
                      {tc(item.label)}
                    </button>
                  ))}
                </div>
              </div>
            )}
            {recentItems.length > 0 && (
              <div>
                <h2 className={styles.sectionHeader}>Recent</h2>
                <div className={styles.memoryLinks}>
                  {recentItems.map((item) => (
                    <button key={item.path} type="button" onClick={() => handleNavigate(item.path)}>
                      {tc(item.label)}
                    </button>
                  ))}
                </div>
              </div>
            )}
          </section>
        )}

        {filteredNavigationGroups.map((group) => (
          <section className={styles.navGroup} key={group.label} aria-label={group.label}>
            <h2 className={styles.sectionHeader}>{tc(group.label)}</h2>
            {group.items.map((item) => {
              const active = isActivePath(item.path);
              return (
                <div className={styles.navItemRow} key={item.path}>
                  <button
                    type="button"
                    className={`${styles.navItem} ${active ? styles.navItemActive : ''}`}
                    onClick={() => handleNavigate(item.path)}
                    onMouseEnter={() => handleItemHover(item.path)}
                    aria-current={active ? 'page' : undefined}
                  >
                    <span>
                      <span className={styles.navLabel}>{tc(item.label)}</span>
                      <span className={styles.navDescription}>{tc(item.description)}</span>
                    </span>
                    {attentionCount > 0 && item.path.endsWith('/disputes') && (
                      <span className={styles.attentionBadge}>{attentionCount}</span>
                    )}
                    <span className={styles.navArrow}>{item.external ? '↗' : '›'}</span>
                  </button>
                  <button
                    type="button"
                    className={`${styles.pinButton} ${pinnedPaths.includes(item.path) ? styles.pinButtonActive : ''}`}
                    onClick={() => togglePinnedPath(item.path)}
                    aria-label={`${pinnedPaths.includes(item.path) ? 'Unpin' : 'Pin'} ${item.label}`}
                    aria-pressed={pinnedPaths.includes(item.path)}
                  >
                    <span aria-hidden="true">◇</span>
                  </button>
                </div>
              );
            })}
          </section>
        ))}

        {rewardContexts.length > 0 && rewardToolMatchesSearch && (
          <section className={styles.navGroup} aria-label="Owner Prize Tools">
            <h2 className={styles.sectionHeader}>Owner Prize Tools</h2>
            {rewardContexts.length > 1 && (
              <label className={styles.contextSwitcher}>
                <span>Prize Club</span>
                <select
                  value={rewardContextClubId}
                  onChange={(event) => setRewardContextClubId(event.target.value)}
                >
                  {rewardContexts.map((context) => (
                    <option key={context.club_id} value={context.club_id}>
                      {context.club_name}
                      {context.union_name ? ` / ${context.union_name}` : ' / Standalone'}
                    </option>
                  ))}
                </select>
              </label>
            )}
            <div className={styles.navItemRow}>
              <button
                type="button"
                className={styles.navItem}
                onClick={() =>
                  handleNavigate(`/leaderboard?setup=prizes&club=${rewardContextClubId}`)
                }
                disabled={!rewardContextClubId}
              >
                <span>
                  <span className={styles.navLabel}>Leaderboard Prize Setup</span>
                  <span className={styles.navDescription}>
                    Configure Suggested Or Custom Promo Wallet Prize Plans
                  </span>
                </span>
                <span className={styles.navArrow}>›</span>
              </button>
            </div>
          </section>
        )}

        {searchQuery &&
          filteredNavigationGroups.length === 0 &&
          !(rewardContexts.length > 0 && rewardToolMatchesSearch) && (
            <div className={styles.noResults} role="status">
              <strong>No Menu Destination Matches.</strong>
              <span>Press Search To Look Across Players And Clubs.</span>
            </div>
          )}

        <button
          type="button"
          className={`${styles.quickAction} ${styles.quickActionFull}`}
          onClick={() => setShowAvatarGallery(true)}
        >
          Change Avatar
        </button>

        <div className={styles.divider} />

        {/* ═══════════════════════════════════════════════════════════════
                    SETTINGS
                ═══════════════════════════════════════════════════════════════ */}
        <section className={styles.settingsDeck} aria-label="Settings">
          <h2 className={styles.sectionHeader}>Settings & Appearance</h2>

          {/* Sounds Toggle */}
          <div className={styles.settingRow}>
            <span className={styles.settingLabel}>Sounds</span>
            <button
              type="button"
              onClick={handleSoundsToggle}
              aria-label="Sounds"
              aria-checked={soundsEnabled}
              role="switch"
              className={styles.toggleButton}
            >
              <span className={styles.toggleTrack} aria-hidden="true">
                <span className={styles.toggleThumb} />
              </span>
            </button>
          </div>

          {/* Vibrations Toggle */}
          <div className={styles.settingRow}>
            <span className={styles.settingLabel}>Vibrations</span>
            <button
              type="button"
              onClick={handleVibrationsToggle}
              aria-label="Vibrations"
              aria-checked={vibrationsEnabled}
              role="switch"
              className={styles.toggleButton}
            >
              <span className={styles.toggleTrack} aria-hidden="true">
                <span className={styles.toggleThumb} />
              </span>
            </button>
          </div>

          {/* Use Real Name Toggle */}
          <div className={styles.settingRow}>
            <span className={styles.settingLabel}>Show Real Name On Social</span>
            <button
              type="button"
              onClick={handleUseRealNameToggle}
              aria-label="Show Real Name On Social Surfaces"
              aria-checked={useRealName}
              role="switch"
              className={styles.toggleButton}
            >
              <span className={styles.toggleTrack} aria-hidden="true">
                <span className={styles.toggleThumb} />
              </span>
            </button>
          </div>

          <button
            type="button"
            className={styles.navItem}
            onClick={handleOpenTableStudio}
            aria-label="Open Table Studio"
          >
            <span>
              <span className={styles.navLabel}>Table Studio</span>
              <span className={styles.navDescription}>
                Themes, Tables, Buttons, Backgrounds, And Card Backs
              </span>
            </span>
            <span className={styles.navArrow} aria-hidden="true">
              ›
            </span>
          </button>

          {/* Bible V8 §11.1: Table Settings — 12 toggles (expandable) */}
          <button
            type="button"
            className={styles.settingsDisclosure}
            onClick={() => setShowTableSettings(!showTableSettings)}
            aria-expanded={showTableSettings}
            aria-controls={tableSettingsId}
          >
            <span className={styles.settingLabel}>Table Settings</span>
            <span
              aria-hidden="true"
              style={{
                color: colors.textSecondary,
                fontSize: 18,
                transform: showTableSettings ? 'rotate(90deg)' : 'rotate(0deg)',
                transition: 'transform 0.2s ease',
              }}
            >
              ›
            </span>
          </button>
          {showTableSettings && (
            <div id={tableSettingsId} style={{ padding: '0 0 8px' }}>
              <TableSettingsPanel
                settings={tableSettings}
                loading={tableSettingsLoading}
                onToggle={toggleTableSetting}
                mode="inline"
              />
            </div>
          )}

          {[
            {
              label: 'App Settings',
              path: '/settings',
              description: 'Audio, Gameplay, Privacy, And Account',
            },
            {
              label: 'Notifications',
              path: '/notifications',
              description: 'Alerts And Notification Preferences',
            },
          ].map((item) => {
            const active = isActivePath(item.path);
            return (
              <button
                type="button"
                key={item.path}
                className={`${styles.navItem} ${active ? styles.navItemActive : ''}`}
                onClick={() => handleNavigate(item.path)}
                onMouseEnter={() => handleItemHover(item.path)}
                aria-current={active ? 'page' : undefined}
              >
                <span>
                  <span className={styles.navLabel}>{tc(item.label)}</span>
                  <span className={styles.navDescription}>{tc(item.description)}</span>
                </span>
                <span className={styles.navArrow}>›</span>
              </button>
            );
          })}
        </section>

        <div className={styles.divider} />

        <section className={styles.navGroup} aria-label="Support And Legal">
          <h2 className={styles.sectionHeader}>Support & Legal</h2>
          {CLUB_ARENA_SUPPORT_NAV.map((item) => {
            const active = isActivePath(item.path);
            return (
              <button
                type="button"
                key={item.path}
                className={`${styles.navItem} ${active ? styles.navItemActive : ''}`}
                onClick={() => handleNavigate(item.path)}
                onMouseEnter={() => handleItemHover(item.path)}
                aria-current={active ? 'page' : undefined}
              >
                <span>
                  <span className={styles.navLabel}>{tc(item.label)}</span>
                  <span className={styles.navDescription}>{tc(item.description)}</span>
                </span>
                <span className={styles.navArrow}>›</span>
              </button>
            );
          })}
        </section>

        <div className={styles.quickActions}>
          <button type="button" className={styles.quickAction} onClick={handleResetTutorial}>
            Reset Tutorial
          </button>
          <button
            type="button"
            className={`${styles.quickAction} ${styles.quickActionDanger}`}
            onClick={handleLogOut}
          >
            Log Out
          </button>
        </div>

        <div className={styles.footer}>Poker Arena · Command Deck V1.12</div>
      </div>

      {/* Avatar Gallery Modal */}
      {user && (
        <AvatarGallery
          isOpen={showAvatarGallery}
          onClose={() => setShowAvatarGallery(false)}
          userId={user.id}
          currentAvatarUrl={avatarUrl || generateDefaultAvatar()}
          isVip={isVIP}
        />
      )}

      {/* Bible V8 §11.2: Theme Settings Modal */}
      <ThemeSettingsModal
        isOpen={showThemeSettings}
        onClose={() => setShowThemeSettings(false)}
        userId={user?.id || ''}
        isVip={isVIP}
        checkoutReturnResult={tableStudioCheckoutResult(location.search)}
      />
    </>
  );
}
