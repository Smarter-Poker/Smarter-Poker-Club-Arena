/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * CLUB HOME PAGE — Premium-Style Club Dashboard
 * ═══════════════════════════════════════════════════════════════════════════════
 * Main page after entering a club. Shows:
 * - Modified Club Arena header (No Search, Settings = Club Settings)
 * - Club card with avatar, name, ID, member count
 * - Wallet display (Gold + Diamond chips)
 * - Bad Beat Jackpot display
 * - Game type filters (ALL, Hold'em, Omaha, Mixed, MTT, SNG)
 * - "Create New Table" button for club owners
 * - Active tables/games grid
 */

import { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import type { ClubRole } from '../types/clubRoles';
import { isClubStaff } from '../types/clubRoles';
import { MEDIA_BASE } from '../utils/mediaBase';
import { useParams, Link, useSearchParams } from 'react-router-dom';
/* Dan 2026-08-28: NOT react-router's useNavigate. This page is also mounted
   INSIDE a MultiTablePage lobby tab (the in-table "+"), and there a
   /tournaments/:id destination must render in the tab rather than change the
   route - a route change hides the container and takes the action bar with it.
   Outside that tab this IS useNavigate, unchanged. See InTabLobbyContext.tsx. */
import { useAppNavigate } from '../context/InTabLobbyContext';
import { supabase, getAuthUser } from '../lib/supabase';
import { sizedStorageUrl } from '../utils/avatarGenerator';
import { masterBus } from '../core/MasterBus';
import { useMasterBusChannel } from '../hooks/useMasterBusChannel';
import haptic from '../services/HapticService';
import GameCreationActions, {
  type GameCreationTarget,
} from '../components/club/GameCreationActions';
import ClubLaunchProgress, { type ClubLaunchTask } from '../components/club/ClubLaunchProgress';
import ClubOpeningWizard from '../components/club/ClubOpeningWizard';
import { clubOpeningSetupService } from '../services/ClubOpeningSetupService';
import { hasNewClubOpeningChecklist } from '../utils/clubOpeningEligibility';
/* LOBBY V2 (Dan 2026-08-22): the large card grid (DynamicGameCard) is replaced
   by the dense line-based LobbyTable + the CasinoPlaque game lobby panel.
   Selecting a row NEVER joins or spends; every commit action goes through the
   panel, which reuses the existing flows (navigate-to-table seat+buy-in,
   WaitlistService, TournamentService, spinQuickJoin). */
import LobbyTable, {
  type LobbyCategory,
  type LobbyRowContext,
} from '../components/lobby/LobbyTable';
import GameLobbyPanel from '../components/lobby/GameLobbyPanel';
import {
  cashEntry,
  tournamentEntry,
  classifyTournament,
  type LobbyEntry,
  type LobbyTableRow,
  type LobbyTournamentRow,
  withClubLabel,
} from '../components/lobby/lobbyEntries';
import { tournamentService } from '../services/TournamentService';
import { tableService } from '../services/TableService';
import { getClubLevelInfoFromMembers, ClubLevelInfo } from '../utils/clubLevels';
import { useToast } from '../components/common/Toast';
import { applyClubScope, inClubScope, type ClubScope } from '../utils/clubScope';
import { waitlistService } from '../services/WaitlistService';
import ConfirmModal from '../components/common/ConfirmModal';
import { retryFetch } from '../utils/retryFetch';
import './ClubHomePage.css';
import '../components/lobby/ClubLobbyCommandTop.css';
import { isFixedLimitVariant } from '../lib/bettingStructure';

import { useVisibilityRefresh } from '../hooks/useVisibilityRefresh';
import { resolveClubIdFilter, resolveClubUUID, resolveClubUUIDSync } from '../utils/clubIdResolver';
import { useIsMounted } from '../hooks/useIsMounted';
import GlobalUXIndicators from '../components/common/GlobalUXIndicators';
import DynamicWallet from '../components/wallet/DynamicWallet';
import WalletCashierModal from '../components/wallet/WalletCashierModal';
import UnionWalletModal, { type UnionWalletKey } from '../components/union/UnionWalletModal';
import UnionTreasuryDetailModal, {
  type TreasuryDetailMode,
} from '../components/union/UnionTreasuryDetailModal';
import Modal from '../components/common/Modal';
import { RakeReports } from '../components/admin/RakeReports';
import SpinActivationPanel from '../components/club/SpinActivationPanel';
import { DEFAULT_CASHIER_WALLET } from '../components/wallet/cashierModes';
import PlayerWalletModal from '../components/wallet/PlayerWalletModal';
import DiamondWalletModal from '../components/wallet/DiamondWalletModal';
import BBJInfoModal from '../components/bbj/BBJInfoModal';
import { readLocalSession } from '../lib/authUtils';
import { reportError } from '../utils/errorReporter';
import { SHARK_CLUB_ID, QUERY_LIMITS } from '../lib/constants';
import { matchesVariant } from '../utils/tournamentFilters';
import { isWithinLobbyWindow, lobbyQueryHorizonIso } from '../utils/tournamentScheduleWindow';
import {
  loadViewPrefs,
  saveViewPrefs,
  sortForTab,
  EMPTY_VIEW_PREFS,
  type LobbyViewPrefs,
} from '../components/lobby/lobbyViewPrefs';
import { useUserStore } from '../stores/useUserStore';
import ClubLobbyCommandTop from '../components/lobby/ClubLobbyCommandTop';
import MaintenanceBreakBanner from '../components/common/MaintenanceBreakBanner';
import HouseAdCard from '../components/ads/HouseAdCard';
import { ClubBBJShell } from '../components/wallet/ClubWalletArtwork';
import { ClubIdentityCard } from '../components/club-buttons';
import ClubOwnerMessage from '../components/club/ClubOwnerMessage';
import AdvancedFilters, {
  loadFilters,
  saveFilters,
  type FilterStore,
} from '../components/lobby/AdvancedFilters';
import {
  FILTER_SPECS,
  emptyFilterValue,
  rowPassesFilter,
  isFilterActive,
  variantKey,
  type FilterGameType,
} from '../components/lobby/advancedFilterSpec';
import { IconShareLink, IconSort } from '../components/icons/LobbyIcons';
import { CLUB_HOME_CACHE_PREFIX } from '../utils/clearUserCaches';
import { useTournamentRegistration } from '../hooks/useTournamentRegistration';
import { preloadRoute } from '../utils/ChunkPreloader';
import { gameManagementService } from '../services/GameManagementService';

// Shark Club fallback logo — used when DB logo_url is null
/* Dan 2026-08-20: "replace the old logo image with the new one". v25 was a
   wide CARD graphic being cropped into a square avatar slot, so most of the
   art was thrown away by object-fit. shark-club-logo.jpg is the square
   emblem and fills the box as intended. */
const SHARK_CLUB_FALLBACK_LOGO = `${MEDIA_BASE}images/shark-club-logo.jpg`;

// Club Arena is deployed beneath /hub/club-arena/. Root-relative /assets URLs
// bypass Vite's configured base path in production and silently 404, leaving
// the live lobby DOM visible without its premium chassis or campaign artwork.
const CLUB_LOBBY_ASSET_ROOT = `${import.meta.env.BASE_URL}assets/club-buttons/lobby`;
/* ONE CROP, EVERY WIDTH (Dan 2026-09-01: "the 'dynamic ad image' is cut off,
   and it needs to scale to size. because when you 'shrink the page' it fits
   perfectly").

   There were two files of the same artwork: `-v2` at 2172 x 724 (3:1, the ad
   centred in a tall black field) served above 900px, and `-mobile-v4` at
   2172 x 302 (7.2:1, the identical ad cropped tight) served below it. The
   campaign bay is a short wide strip at EVERY width - roughly 11:1 on a 1440px
   desktop - so the 3:1 file could only ever be shown by cropping it, which is
   the top of the trophy and the whole buy-in line that Dan lost. The tight
   crop is not a phone variant, it is the shape this bay actually is, so it is
   what both regimes serve now and the bay's aspect-ratio matches it.

   The filename still says "mobile" because renaming a published asset breaks
   every cached service-worker entry pointing at it. */
const CLUB_LOBBY_CAMPAIGN = `${CLUB_LOBBY_ASSET_ROOT}/shark-club-championship-ad-mobile-v4.png`;

/**
 * The order the Omaha tab groups its variants in (Dan 2026-08-25). Four cards
 * first because it is the game most players mean by "PLO", then five, six, and
 * hi-lo last because it is a different game rather than a deeper one.
 *
 * A variant with no entry sorts after all of them rather than to the top: an
 * unrecognised game should be visible at the end of the list, never presented
 * as the headline.
 */
const VARIANT_GROUP_ORDER: Record<string, number> = {
  plo4: 0,
  plo5: 1,
  plo6: 2,
  plo8: 3,
};

// SWR cache helpers for instant club data display.
//
// PERF PASS 2026-08-22 (handoff item 7): moved from sessionStorage to
// localStorage. sessionStorage dies with the tab, so the one load that
// matters most — a returning player cold-opening their club — always sat
// on the skeleton while the heaviest screen in the app fetched from zero.
// localStorage gives that visit the same instant paint the in-session
// revisits already had; loadClubData still revalidates immediately after.
// Only public club metadata and the table list are cached — never wallet,
// role, or member data. Entries carry their own timestamp because the
// staleCacheReaper only sweeps sessionStorage: reads ignore anything older
// than the TTL, and a quota failure drops every club-home entry and retries
// once, so the cache can never wedge itself full.
/* v3 (2026-08-26): the cached payload is the whole club object, and the club
   object carries member_count. Every entry written before the member-count fix
   holds an RLS-FILTERED count - 0 for someone who had not joined the club, 593
   for a union admin who should have seen 1,172 - and the TTL below is SEVEN
   DAYS, so those wrong numbers would have kept painting on mount for a week
   after the fix shipped.

   It self-corrects once the RPC answers, which is not good enough: if that
   request drops mid-flight the guard at the await site sees `data == null`,
   declines to overwrite, and the stale wrong number stays on screen for the
   whole visit. A fix that needs the network to succeed in order to stop showing
   a wrong number is not a fix.

   Bumping the version changes the key, so every pre-fix entry becomes
   unreachable exactly once, for every user, with no migration pass and no
   cleanup code. The v2 entries expire on their own TTL and are never read.

   The unversioned sessionStorage read below is deliberately left alone: it
   serves the v2 transition from 2026-08-22, it is tab-scoped rather than
   persistent, and it dies when the tab closes. */
const CLUB_HOME_CACHE_VER = 'v3';
const CLUB_HOME_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

function getClubHomeCache(clubId: string) {
  try {
    const raw =
      localStorage.getItem(`${CLUB_HOME_CACHE_PREFIX}${CLUB_HOME_CACHE_VER}_${clubId}`) ??
      // Pre-v2 entries (unwrapped, sessionStorage) still hydrate one last
      // time during the transition; the next write lands in localStorage.
      sessionStorage.getItem(`${CLUB_HOME_CACHE_PREFIX}${clubId}`);
    // (Both reads are inside this function's try - Safari private mode and a
    //  sandboxed frame both THROW on storage access rather than returning
    //  null, and an uncaught throw here aborts the whole club load.)
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && 'at' in parsed && 'data' in parsed) {
      if (Date.now() - parsed.at > CLUB_HOME_CACHE_TTL_MS) return null;
      return parsed.data;
    }
    return parsed;
  } catch {
    return null;
  }
}
function setClubHomeCache(clubId: string, data: { club: any; tables: any[] }) {
  const key = `${CLUB_HOME_CACHE_PREFIX}${CLUB_HOME_CACHE_VER}_${clubId}`;
  const value = JSON.stringify({ at: Date.now(), data });
  try {
    localStorage.setItem(key, value);
  } catch {
    try {
      for (let i = localStorage.length - 1; i >= 0; i--) {
        const k = localStorage.key(i);
        if (k && k.startsWith(CLUB_HOME_CACHE_PREFIX)) localStorage.removeItem(k);
      }
      localStorage.setItem(key, value);
    } catch {
      /* storage unavailable — instant paint is best-effort */
    }
  }
}

const CLUB_LOBBY_MESSAGE_MAX_LENGTH = 72;

// Types
interface ClubData {
  id: string;
  club_id: number;
  name: string;
  slug?: string;
  description: string;
  tagline?: string | null;
  /* Dan 2026-09-01: the owner's custom / day's message, printed at the top of
     the lobby rail. Its own column so `tagline` stays the permanent identity
     line the opening checklist and the invite page depend on. */
  lobby_message?: string | null;
  avatar_url: string;
  logo_url?: string;
  banner_url?: string | null;
  member_count: number;
  online_count: number;
  owner_id: string;
  level: number;
  hierarchy_units_rounded_up: number;
  player_threshold_current: number;
  player_threshold_next: number;
  hierarchy_threshold_current: number;
  hierarchy_threshold_next: number;
  created_at: string;
  is_union: boolean;
  union_id?: string | null;
  opening_checklist_started_at?: string | null;
  chip_treasury?: number | null;
  spins_enabled?: boolean | null;
}

interface TableData {
  id: string;
  name: string;
  game_variant: string;
  stakes: string;
  current_players: number;
  max_players: number;
  status: string;
  small_blind: number;
  big_blind: number;
  min_buy_in: number;
  max_buy_in: number;
  settings?: string;
}

interface TournamentData {
  id: string;
  name: string;
  game_type: string;
  buy_in_amount: number;
  buy_in_fee: number;
  guaranteed_prize: number | null;
  start_time: string;
  status: string;
  current_players: number;
  max_players: number;
  starting_chips: number;
  /**
   * Dan 2026-08-19: late-registration state is derived from these, not from a
   * status string. No tournament has ever carried a 'LATE_REG' status, so the
   * Late Reg filter matched nothing at all until this was wired up.
   */
  late_reg_mins?: number | null;
  late_reg_levels?: number | null;
  started_at?: string | null;
  current_level?: number | null;
  variant?: string | null;
  /**
   * Dan 2026-08-24: the MTT title's late-reg countdown needs the level
   * window's real end, which only the blind structure can give.
   */
  blind_structure?: string | null;
  level_started_at?: string | null;
}

/**
 * ── GAME ACTION BAR (Dan 2026-08-20) ─────────────────────────────────────────
 *
 * The lobby used to filter through THREE stacked rows: a main tab
 * (ALL / CASH GAMES / TOURNAMENTS), then a variant row whose contents changed
 * depending on the tab, then a status row. Finding Omaha took two taps through
 * a control that rearranged itself between them, and the two rows appeared and
 * vanished as the tab changed, so the grid jumped up and down the page.
 *
 * One bar now lists every game type the platform runs, flat. Status is a
 * refinement of a chosen type, so that row appears only once a type is picked,
 * and ordering moved to an explicit sort control instead of being implied by
 * whichever tab happened to be selected.
 */
type GameType = 'ALL' | 'HOLDEM' | 'OMAHA' | 'LIMIT' | 'MIXED' | 'MTT' | 'SNG' | 'SPIN';
type SortKey = 'recommended' | 'stakes_high' | 'stakes_low' | 'players' | 'starting_soon';
type TournVariant = 'ALL' | 'MTT' | 'Spin-It' | 'SN';
type AllStatusFilter = 'ALL' | 'RUNNING' | 'OPEN_REGISTRATION' | 'LATE_REG' | 'STARTING_SOON';

const ALL_STATUS_FILTERS: ReadonlyArray<{ key: AllStatusFilter; label: string }> = [
  { key: 'ALL', label: 'All' },
  { key: 'RUNNING', label: 'Running' },
  { key: 'OPEN_REGISTRATION', label: 'Open Registration' },
  { key: 'LATE_REG', label: 'Late Reg' },
  { key: 'STARTING_SOON', label: 'Starting Soon' },
];
/* The CashSubFilter / TournamentSubFilter types went with the state they
   described (see the note further down). Status is one mechanism now:
   GameFilterValue.statuses, defined per game type in advancedFilterSpec. */

/** ALL shows the ten soonest MTTs a player can still enter. Cash is uncapped
    (Dan 2026-08-25: "the cap is 10 for MTT only"). */
const ALL_TAB_MTT_CAP = 10;

/**
 * THE ONE LIST OF STATUSES THIS LOBBY SHOWS (2026-08-28 audit).
 *
 * The fetch and the realtime admission test are two halves of the same rule
 * and they had drifted: the fetch admitted LATE_REG and STARTING_SOON, the
 * realtime `belongsInTournamentList` re-typed a shorter `['REGISTERING',
 * 'RUNNING']` beside a comment saying it must mirror the fetch. So a
 * tournament that arrived in the page under either of the two extra statuses
 * would be DELETED from the board by its own next UPDATE — the row vanishes
 * while the player is looking at it, and only a reload brings it back. That
 * is exactly the shape of "every single one disappears from the spins lobby",
 * so it is fixed whether or not a writer sets those statuses today.
 *
 * One array, both consumers. Adding a status here can no longer half-land.
 */
const LOBBY_TOURNAMENT_STATUSES = ['REGISTERING', 'RUNNING', 'LATE_REG', 'STARTING_SOON'];

const CASH_TYPES: GameType[] = ['HOLDEM', 'OMAHA', 'LIMIT', 'MIXED'];
const TOURNAMENT_TYPES: GameType[] = ['MTT', 'SNG', 'SPIN'];

/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  A NARROWER ROW MAY NEVER ERASE A WIDER ONE
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Dan 2026-08-25, with a screen recording: "whatever is causing the MTT cards
 * to MOVE AND CHANGE needs to stop, I don't want them moving and adjusting
 * once they are set."
 *
 * THE BUG, root-caused rather than papered over. `get_club_home` is the
 * one-round-trip fast path that paints the lobby five round trips early, and
 * it deliberately selects FEWER columns than the authoritative chain. Verified
 * against production (`pg_get_functiondef`), its tournament rows carry no
 *
 *     blind_structure, level_started_at, spin_multiplier, is_bounty, prize_pool
 *
 * Those five are exactly what an MTT card renders: the blinds sub-line under
 * Current Level, the Blind Levels chip, the Format chip (Turbo / Deepstack,
 * derived from level duration), the late-registration countdown, and the Spin
 * and bounty badges.
 *
 * `lobbyPainted` was believed to make the fast path harmless - the comment at
 * its declaration still says it "guarantees the fast path can only ever paint
 * BEFORE the authoritative data, never over it". That is true within ONE load.
 * It is a local of that invocation, so every RELOAD - the 90s timer, a
 * visibilitychange, TOURNAMENT_UPDATED, WAITLIST_PROMOTED - starts a fresh one
 * at false while full-fidelity rows are already on screen. The fast path then
 * wins its race against the new chain and REPLACES them with the narrow rows.
 *
 * On screen: every card loses its blinds line, its Blind Levels chip and its
 * Format chip, the late-reg countdown collapses to 0:00, the card shrinks by
 * roughly 40px, and everything below it jumps up. ~200-400ms later the chain
 * lands and it all grows back. That is the whole of the reported glitch, and it
 * repeats on every reload for as long as the lobby is open.
 *
 * THE FIX. Merge by id and never delete a key. A fast row may only ADD fields
 * or update ones it actually carries; a field it does not carry keeps the value
 * already on screen. `undefined` is treated as absent, so a column the RPC
 * omits cannot blank a column the chain fetched.
 *
 * Why merge rather than just skipping the fast path on a warm reload (which is
 * also done, at the call site): merging is the property that must hold. Any
 * future partial source - a slimmer RPC, a realtime patch, a cached snapshot -
 * gets the same protection without having to remember this incident.
 *
 * Ordering follows the fast rows, because that is the freshly sorted answer;
 * rows only the previous list knew about are kept and appended rather than
 * vanishing, so a row the RPC's own limit clipped does not blink out.
 */
export function mergeFastRows<T extends { id?: string | number }>(
  previous: readonly T[],
  incoming: readonly T[]
): T[] {
  if (!Array.isArray(incoming) || incoming.length === 0) return previous as T[];
  if (!Array.isArray(previous) || previous.length === 0) return incoming as T[];

  const before = new Map<string, T>();
  for (const row of previous) {
    if (row && row.id != null) before.set(String(row.id), row);
  }

  const seen = new Set<string>();
  const merged = incoming.map((row) => {
    if (!row || row.id == null) return row;
    const key = String(row.id);
    seen.add(key);
    const old = before.get(key);
    if (!old) return row;

    // Overlay only the keys this row actually carries. `undefined` means the
    // source never selected the column - not that the value became empty.
    const next: Record<string, unknown> = { ...(old as Record<string, unknown>) };
    for (const [k, v] of Object.entries(row as Record<string, unknown>)) {
      if (v !== undefined) next[k] = v;
    }
    return next as T;
  });

  // A row the incoming answer did not mention is not proof it is gone - the
  // fast path applies its own limit. Keep it rather than blinking it out; the
  // authoritative chain, and the DELETE branch of the realtime handler, are
  // what remove a row.
  for (const row of previous) {
    if (row && row.id != null && !seen.has(String(row.id))) merged.push(row);
  }
  return merged;
}

/**
 * Dan 2026-08-20: "remove Mixed games from the action bar."
 * Dan 2026-08-25: "WE DON'T HAVE MIXED CASH GAMES."
 *
 * MIXED stays in the GameType union as cashKind's LAST RESORT - the bucket a
 * variant nobody has classified falls into - and it has no tab, so a table
 * that reaches it is reachable only from ALL. That makes it a diagnostic, not
 * a category: every variant this platform actually deals (nlh, plo4/5/6/8,
 * short_deck, pineapple) is classified above it, and anything landing here is
 * a variant someone shipped without telling the lobby about it.
 */
const GAME_TYPE_TABS: { key: GameType; label: string }[] = [
  /* LOBBY V2: All Games is a real tab now — the line-based table renders a
     combined column set for it, so it no longer needs to be hidden. */
  { key: 'ALL', label: 'ALL' },
  { key: 'MTT', label: 'MTT' },
  { key: 'HOLDEM', label: 'NLH' },
  { key: 'OMAHA', label: 'PLO' },
  { key: 'LIMIT', label: 'LIMIT' },
  { key: 'SPIN', label: 'SPINS' },
  { key: 'SNG', label: 'HEADS UP' },
];

/**
 * THE CREATE BUTTON BELONGS TO THE TAB YOU ARE LOOKING AT (Dan 2026-09-02).
 *
 * "THE ADD TABLE BUTTONS SHOULD NEVER DISPLAY ON THE ALL FIELD AND THERE
 * SHOULD ONLY BE ONE BUTTON, AND THEY SHOULD BE INDEPENDENT TO THE FIELD. MTT
 * RECEIVES THE + EVENT BUTTON. NLH RECEIVES THE + ADD TABLE BUTTON, PLO
 * RECEIVES THE + ADD TABLE BUTTON, SPINS RECEIVES THE + SPINS BUTTON AND HEADS
 * UP RECEIVES THE + SIT N GO BUTTON."
 *
 * LIMIT is the one tab Dan did not name. It is a cash board - it lists the
 * same `tables` rows NLH and PLO do, and `table-management?create=table` is
 * the screen that builds them - so Add Table is the only creation it could
 * mean, and giving it nothing would be the one tab with a missing control.
 * Named explicitly rather than caught by a default so that a game type added
 * later shows NO button until somebody decides which one it earns, instead of
 * silently inheriting a cash table.
 */
const CREATE_TARGET_FOR_TAB: Record<GameType, GameCreationTarget | null> = {
  ALL: null,
  MTT: 'event',
  HOLDEM: 'table',
  OMAHA: 'table',
  LIMIT: 'table',
  SPIN: 'spin',
  SNG: 'sng',
  /* MIXED is in the GameType union but has no tab in GAME_TYPE_TABS, so this
     entry is unreachable today. It is written as null rather than 'table'
     because if a Mixed board is ever surfaced, no button is the honest
     starting point - somebody chooses what it creates, deliberately. */
  MIXED: null,
};

const SORT_OPTIONS: { key: SortKey; label: string }[] = [
  { key: 'recommended', label: 'Recommended' },
  { key: 'stakes_high', label: 'Stakes: High To Low' },
  { key: 'stakes_low', label: 'Stakes: Low To High' },
  { key: 'players', label: 'Most Players' },
  { key: 'starting_soon', label: 'Starting Time' },
];

/** Which tournament tab a GameType maps onto, for the shared variant matcher. */
const TOURN_VARIANT_FOR: Partial<Record<GameType, TournVariant>> = {
  MTT: 'MTT',
  SNG: 'SN',
  SPIN: 'Spin-It',
};

/** Classify a cash table into the bar's three cash types. */
function cashKind(t: { game_variant?: string }): 'HOLDEM' | 'OMAHA' | 'LIMIT' | 'MIXED' {
  const v = (t.game_variant || '').toLowerCase();
  // 'short' is Short Deck, which is a Hold'em variant — it belongs with NLH,
  // not in the Mixed bucket where an unlisted string falls.
  //
  // 2026-08-23: ask BettingStructure FIRST. The substring tests below catch
  // `flh` and anything spelled `limit_*`, but not `flo8` — that string contains
  // no "flh", no "limit", and no "plo" either, so Fixed Limit Omaha fell all
  // the way through to MIXED and would have been missing from the very tab it
  // belongs in. The substring tests stay underneath as the fallback for legacy
  // `limit_holdem` / `limit_omaha` rows, which are not in the variant union and
  // so are invisible to bettingStructureFor().
  if (isFixedLimitVariant(v)) return 'LIMIT';
  if (v.includes('flh') || (v.includes('limit') && !v.includes('no') && !v.includes('pot')))
    return 'LIMIT';
  /* Pineapple is Hold'em. The platform's own type says so - club.types.ts
     declares `'pineapple' // Pineapple Hold'em` - it deals a community board
     and bets like Hold'em, and it differs only by dealing three hole cards
     and discarding one. Without this it fell through to MIXED, which is the
     unrecognised-variant bucket: production is running five pineapple tables
     that appeared on NO tab in the app, because ALL dropped the MIXED bucket
     and there is no Mixed tab to drop to. Short Deck sits here for exactly
     the same reason. */
  if (
    v.includes('nlh') ||
    v.includes('holdem') ||
    v.includes("hold'em") ||
    v.includes('short') ||
    v.includes('pineapple')
  )
    return 'HOLDEM';
  if (v.includes('plo') || v.includes('omaha')) return 'OMAHA';
  return 'MIXED';
}

/* `cashRank` used to sit here - a comparator for a Hold'em/Omaha/Limit/Mixed
   ordering that nothing has called since the ALL view was rebuilt around
   per-section lists. */
// Tournaments open for registration (or not past late-reg) come first, soonest first.
function tournamentOpenFirst(
  a: { status?: string; start_time: string },
  b: { status?: string; start_time: string }
): number {
  const rank = (s?: string) => {
    const u = (s || '').toUpperCase();
    if (
      ['REGISTERING', 'OPEN', 'PENDING', 'ANNOUNCED', 'LATE_REG', 'LATE_REGISTRATION'].includes(u)
    )
      return 0;
    if (u === 'RUNNING' || u === 'IN_PROGRESS') return 1;
    return 2;
  };
  const r = rank(a.status) - rank(b.status);
  if (r !== 0) return r;
  return new Date(a.start_time).getTime() - new Date(b.start_time).getTime();
}

/**
 * Dan 2026-08-19: `clubIdOverride` lets the club lobby render OUTSIDE its own
 * route — specifically inside a Club Arena lobby tab after a player leaves a
 * table. Without it this page could only read clubId from useParams, so the
 * in-tab lobby fell back to the pre-lobby landing page instead of the actual
 * club lobby the player came from.
 */
import PageErrorBoundary from '../components/common/PageErrorBoundary';

export default function ClubHomePage({ clubIdOverride }: { clubIdOverride?: string } = {}) {
  return (
    <PageErrorBoundary pageName="ClubHomePage">
      <ClubHomePageContent clubIdOverride={clubIdOverride} />
    </PageErrorBoundary>
  );
}

function ClubHomePageContent({ clubIdOverride }: { clubIdOverride?: string } = {}) {
  const { register: registerMtt, isRegistering: isRegisteringMtt } = useTournamentRegistration();

  const { clubId: routeClubId } = useParams<{ clubId: string }>();
  const clubId = clubIdOverride || routeClubId;
  useVisibilityRefresh(() => loadClubData());
  const navigate = useAppNavigate();
  const isMountedRef = useIsMounted();
  /**
   * ─── NOT A MEMBER, WITHOUT LEAVING THE TABLE (Dan 2026-08-28 round 2) ─────
   *
   * `/invite/:clubId` is a route outside /table/:tableId, so navigating to it
   * from the in-tab lobby collapses MultiTablePage — action bar, tab strip,
   * Take Seat button, all of it — while the player's other tables keep
   * dealing. That is the exact failure this whole body of work exists to stop,
   * and it fires from a LOAD EFFECT rather than a click, so the player cannot
   * even connect it to something they did.
   *
   * Embedded, the honest answer is to say so IN THE TAB and leave the felt
   * alone; the player can then decide to go and join. On its own route the
   * redirect is unchanged.
   */
  const [notAMember, setNotAMember] = useState(false);
  const bounceToInvite = useCallback(
    (playerRequestedExit = false) => {
      if (clubIdOverride && !playerRequestedExit) {
        setNotAMember(true);
        return;
      }
      navigate(`/invite/${clubId}`);
    },
    [clubIdOverride, clubId, navigate]
  );
  /* THE LATEST loadClubData, ALWAYS.
     `loadClubData` is redefined every render and closes over that render's
     clubId. The bus effect below and the realtime member handler both have []
     deps, so they froze render 0's copy: after /clubs/a -> /clubs/b (React
     Router reuses this component), a CLUB_JOINED event, a club_members
     realtime tick or the 90-second fallback would refetch club A and paint it
     over club B. Kept current by an effect - never assigned during render,
     which would be a side effect in the render body. */
  const loadClubDataRef = useRef<(getIsMounted?: () => boolean) => void>(() => {});
  /** Bumped by every club load and on unmount; a late response compares. */
  const loadTokenRef = useRef(0);
  /** The resolved UUID, for comparing bus payloads that name the club by it. */
  const resolvedClubIdRef = useRef<string | null>(null);

  // Refs to avoid stale closures in realtime subscriptions
  const clubIdRef = useRef(clubId);

  /**
   * ALWAYS-ON (Dan, 2026-08-24): seed from the device cache DURING the first
   * render, not in an effect afterwards.
   *
   * The SWR restore further down does exactly this - reads getClubHomeCache and
   * calls setClub/setTables/setLoading(false) - but it lives in a useEffect, and
   * effects run AFTER paint. So entering a club ALWAYS rendered one frame of
   * skeleton first, even when the full club and its table list were sitting in
   * localStorage the whole time. That single frame is the flicker that reads as
   * "the lobby reloads every time".
   *
   * A lazy useState initialiser runs during render, so the first painted frame
   * already has the club. The effect below is kept: it re-seeds on a genuine
   * clubId CHANGE (React keeps this component mounted across /clubs/a ->
   * /clubs/b), where a lazy initialiser cannot help because it only ever runs
   * once per mount.
   */
  const bootCache = useState(() => (clubId ? getClubHomeCache(clubId) : null))[0];
  const [club, setClub] = useState<ClubData | null>(bootCache?.club ?? null);
  const [tables, setTables] = useState<TableData[]>(bootCache?.tables ?? []);
  const [tournaments, setTournaments] = useState<TournamentData[]>([]);
  const [jackpotAmount, setJackpotAmount] = useState(0);
  // Tapping the lobby jackpot opens the SAME view as tapping it at a table:
  // last 5 hits, qualifying hands per game, payout % per stakes (Dan 2026-08-18).
  const [bbjPoolId, setBbjPoolId] = useState<string | null>(null);
  const [showBBJInfo, setShowBBJInfo] = useState(false);
  // Dan 2026-08-23: the Club Bank row opens the Club Bank Cashier - send outs
  // to agent wallets, the full chip ledger, and (standalone clubs only) the
  // Chip Mint, which used to be a "+" on the wallet panel itself.
  const [activeCashier, setActiveCashier] = useState<
    'club_bank' | 'promo_wallet' | 'agent_wallet' | null
  >(null);
  const [unionWalletModal, setUnionWalletModal] = useState<{
    key: UnionWalletKey;
    label: string;
    balance: number;
  } | null>(null);
  const [unionTreasuryModal, setUnionTreasuryModal] = useState<TreasuryDetailMode | null>(null);
  const [standaloneRakeModal, setStandaloneRakeModal] = useState(false);
  const [standaloneSpinsModal, setStandaloneSpinsModal] = useState(false);
  // Dan 2026-08-24: "PLAYER WALLET NEEDS TO BE FULLY CLICKABLE AND OPEN TO SEE
  // ALL TRANSACTIONS AND OTHER AVAILABLE DATA WHEN CLICKED." The row opens the
  // member's own statement - a read-only view, so it is not an activeCashier.
  const [showPlayerWallet, setShowPlayerWallet] = useState(false);
  const [showDiamondWallet, setShowDiamondWallet] = useState(false);
  /* LOBBY V2 follow-up (Dan's QA, 2026-08-22): the lobby landed on the MTT
     tab, a leftover from before All Games was a real tab. A club with no open
     MTTs therefore opened onto an empty screen blaming "filters" - every
     single visit. All Games is the landing view of a dense lobby. */
  const [gameType, setGameType] = useState<GameType>('ALL');
  const [sortKey, setSortKey] = useState<SortKey>('starting_soon');
  const [allStatusFilter, setAllStatusFilter] = useState<AllStatusFilter>('ALL');
  /* `sortOpen` used to live here. It was assigned false in three places,
     never assigned true, and read nowhere - the exact dead wiring the comment
     below says had already been removed once. */
  /* Advanced Filters (Dan 2026-08-20). Loaded lazily from localStorage on
     first render so a returning player's preferences apply to the FIRST
     paint of the lobby rather than flashing an unfiltered list first. */
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [advFilters, setAdvFilters] = useState<FilterStore>({});
  /* THE TAB, THE SORT AND THE FAVORITES CHIP ARE PREFERENCES TOO
     (Dan 2026-08-26: "they should auto save until changed"). The saved
     Advanced Filters beside this have persisted since 2026-08-20; these three
     never did, which is why the lobby read as "nothing was remembered" even
     while the filters underneath were intact. See lobbyViewPrefs.ts. */
  const [viewPrefs, setViewPrefs] = useState<LobbyViewPrefs>(EMPTY_VIEW_PREFS);
  /* WHICH CLUB THE PREFS IN STATE BELONG TO. Not a hydration marker: an
     OWNERSHIP marker, because `viewPrefs` and `resolvedClubId` update on
     different ticks and the gap between them is a cross-club leak (see the
     persistence effect). */
  const viewPrefsOwner = useRef<string | null>(null);
  /* Has the player changed anything since the prefs in state were loaded.
     resolvedClubId arrives after first paint, so without this a tab tapped
     during those few hundred milliseconds would be silently undone by the
     restore that follows it. Reset on a club switch: a choice made in one club
     is not a choice in the next one. */
  const viewPrefsTouched = useRef(false);
  // LOBBY V2: show only starred cash tables. Declared here (not with the rest
  // of the V2 state) because `narrowing` and `clearAllNarrowing` read it.
  const [favoritesOnly, setFavoritesOnly] = useState(false);
  const [isEditingNotice, setIsEditingNotice] = useState(false);
  const [noticeDraft, setNoticeDraft] = useState('');
  const [walletsExpanded, setWalletsExpanded] = useState(false);
  const [visibleWalletCount, setVisibleWalletCount] = useState(0);
  // Status defaults are 'all' on BOTH axes now. They used to be 'live' and
  // 'running', which was invisible: picking a game type silently hid every
  // empty table and every tournament still taking registrations, so a club
  // with 30 open games could look empty the moment a player filtered. A filter
  // the player did not choose must not remove rows.
  /* AUDIT 2026-08-21: cashSubFilter / tournamentSubFilter are GONE.
     The quick-preference chips used to drive them; they now write
     `statuses` on the saved filter, which is the same mechanism the Advanced
     Filters sheet uses. Keeping both meant two status systems on one screen,
     and after the quick row was rewired the setters were never called at all -
     the state sat permanently on its default while the filter code below still
     branched on it. One mechanism, no dead state. */
  const [isOwner, setIsOwner] = useState(false);
  // Only start in the loading state when there is genuinely nothing to show.
  // Starting at `true` unconditionally guaranteed a skeleton frame on every
  // entry, including the very common case of returning to a club whose data is
  // already cached (see the bootCache note above). hasDataRef is seeded to
  // match so the watchdog and the reset guard agree with what is on screen.
  const [loading, setLoading] = useState(!bootCache?.club);
  const [userRole, setUserRole] = useState<ClubRole>('player');
  const [deletingTableId, setDeletingTableId] = useState<string | null>(null);
  const [, setIsInUnion] = useState(false);
  const [, setUnionName] = useState<string | null>(null);
  /** Live seat count from get_club_home. Null until it answers; see the note
      where it is set - the stale clubs.online_count is never used. */
  const [playersPlaying, setPlayersPlaying] = useState<number | null>(null);
  const [unionIdForCreate, setUnionIdForCreate] = useState<string | undefined>(undefined);
  /** Owning-club names for a union board. Empty for a club that is in no union. */
  const [clubNames, setClubNames] = useState<Record<string, string>>({});
  const [showOpeningWizard, setShowOpeningWizard] = useState(false);
  const [openingSetupComplete, setOpeningSetupComplete] = useState(false);
  const [configuredAgentUserId, setConfiguredAgentUserId] = useState<string | null>(null);
  const [agentSetupRevision, setAgentSetupRevision] = useState(0);
  const [clubLevel, setClubLevel] = useState<ClubLevelInfo | null>(null);
  /* The last COMMITTED club level. The level-up celebration compares against
     this rather than against the `prev` handed to a state updater, because an
     updater can be called more than once for one real change. */
  const clubLevelRef = useRef<typeof clubLevel>(null);
  useEffect(() => {
    clubLevelRef.current = clubLevel;
  }, [clubLevel]);
  // Synchronous from the user store (Dan 2026-08-24: "when you leave a game
  // and go back to the lobby, the wallet is never there and has to load
  // again"). This used to start null and hydrate from an ASYNC auth call —
  // so on every navigation the wallet mounted with no userId, its device
  // cache was unreachable (keys embed the user id), and the panel sat on a
  // skeleton for a full roundtrip it did not need. The store survives route
  // changes; the async path below still confirms it.
  const currentUser = useUserStore((state) => state.user);
  const [currentUserId, setCurrentUserId] = useState<string | null>(
    () => useUserStore.getState().user?.id ?? null
  );
  const openingChecklistEligible = hasNewClubOpeningChecklist(club);
  const toast = useToast();
  useEffect(() => {
    if (
      !club?.id ||
      !currentUserId ||
      club.owner_id !== currentUserId ||
      !openingChecklistEligible
    ) {
      setOpeningSetupComplete(false);
      return;
    }
    let cancelled = false;
    void clubOpeningSetupService
      .getState(club.id)
      .then((setup) => {
        if (!cancelled) setOpeningSetupComplete(Boolean(setup?.completed_at));
      })
      .catch((error) => {
        if (!cancelled) setOpeningSetupComplete(false);
        reportError(error, 'ClubHomePage.Opening_setup_state');
      });
    return () => {
      cancelled = true;
    };
  }, [club?.id, club?.owner_id, currentUserId, openingChecklistEligible]);
  useEffect(() => {
    if (!club?.id || !currentUserId || club.owner_id !== currentUserId) {
      setConfiguredAgentUserId(null);
      return;
    }

    let cancelled = false;
    void supabase
      .from('agents')
      .select('user_id, is_prepaid, credit_limit, player_rakeback_rate')
      .eq('club_id', club.id)
      .eq('status', 'active')
      .in('role', ['super_agent', 'agent', 'sub_agent'])
      .order('created_at', { ascending: true })
      .limit(25)
      .then(({ data, error }) => {
        if (cancelled) return;
        if (error) {
          setConfiguredAgentUserId(null);
          reportError(error, 'ClubHomePage.Agent_setup_state');
          return;
        }

        // Promotion is the authoritative write: it refuses to create an agent
        // until Prepaid Or Credit, the Credit Limit, and Rakeback have all been
        // explicitly supplied. A credit LIMIT is permission to borrow; it does
        // not transfer chips. Funding remains a separate, audited club-bank send.
        const configured = data?.find((agent) => {
          const prepaid = agent.is_prepaid === true && Number(agent.credit_limit || 0) === 0;
          const credit = agent.is_prepaid === false && Number(agent.credit_limit || 0) > 0;
          return (prepaid || credit) && agent.player_rakeback_rate != null;
        });
        setConfiguredAgentUserId(configured?.user_id ?? null);
      });

    return () => {
      cancelled = true;
    };
  }, [club?.id, club?.owner_id, currentUserId, agentSetupRevision]);
  // Seeded from the boot cache: if the first painted frame already shows a club
  // (see bootCache above), then data IS on screen, and the stall watchdog and
  // the per-club reset guard must both agree with that. Leaving it false while
  // a cached club renders would let the watchdog declare a stall over a lobby
  // the player is looking at.
  const hasDataRef = useRef(Boolean(bootCache?.club));

  /**
   * Has the AUTHORITATIVE chain painted the game LISTS for this club yet?
   *
   * Deliberately NOT `hasDataRef`, and the difference is a real bug I nearly
   * shipped. `hasDataRef` is seeded from the boot cache, and that cache holds
   * `{ club, tables }` and NO tournaments (see setClubHomeCache). So a
   * returning player - the commonest visit there is - mounts with hasDataRef
   * already true and an EMPTY tournament list. Gating the fast path on it
   * would skip the one call that fills that list, and the MTT board would sit
   * empty until the slow chain landed. That trades a flicker for a blank.
   *
   * This ref means what the guard actually needs to ask: are there real,
   * chain-fetched rows on screen that a narrower answer could damage? It is
   * false on a cached boot (so the fast path still runs and still paints) and
   * true only from the moment the chain has answered, which is exactly when
   * the fast path has nothing left to contribute. Cleared per club by the
   * reset effect below.
   */
  const listsPaintedRef = useRef(false);
  const loadingRef = useRef(false);
  const [wsConnected, setWsConnected] = useState(true);

  // ── CRITICAL: Reset per-club state when navigating between clubs ──
  // React Router reuses the component when only the clubId param changes.
  //
  // ALWAYS-ON (Dan, 2026-08-24): this must fire on an actual club CHANGE and
  // nowhere else. A `useEffect(..., [clubId])` also runs on FIRST MOUNT, so
  // every entry into a club - including re-entering the club you were already
  // looking at - zeroed the wallet to {gold:0, diamonds:0}, dropped clubLevel
  // to null and cleared hasDataRef, which re-armed the loading skeleton. That
  // is the "wallet reloads when I change pages" behaviour, and it was
  // self-inflicted: the data was correct and got thrown away before the refetch
  // that would replace it.
  //
  // Comparing against a ref makes it a true transition guard: on first mount
  // the ref is seeded and nothing is cleared, so a cached wallet stays on
  // screen; on a genuine club switch the stale club's values still get wiped,
  // which is the case this reset exists for.
  const prevClubIdRef = useRef<string | undefined>(undefined);
  useEffect(() => {
    const previous = prevClubIdRef.current;
    prevClubIdRef.current = clubId;
    if (previous === undefined || previous === clubId) return;

    setIsOwner(false);
    setUserRole('player');
    setIsInUnion(false);
    setUnionName(null);
    setUnionIdForCreate(undefined);
    setDeletingTableId(null);
    setShowOpeningWizard(false);
    setOpeningSetupComplete(false);
    setDeleteTableConfirm({ show: false, tableId: null, tableName: null });
    setClubLevel(null);
    setJackpotAmount(0);
    /* A playing count belongs to exactly one club scope. Leaving this state
       intact during a route-param switch painted the previous club's live
       number over a brand-new empty club until the next RPC completed. */
    setPlayersPlaying(null);
    /* THE LISTS TOO. This reset cleared the viewer's role, level and jackpot
       but left `club`, `tables` and `tournaments` - the three things actually
       on screen - holding the previous club. Entering a club with no cached
       payload therefore showed the PREVIOUS club's name, member count and
       table rows, as live joinable games, for the whole length of the fetch.
       Clearing them re-arms the skeleton; the SWR effect immediately below
       repaints from the new club's cache in the same commit when it has one,
       so a cached club still opens without a flash. */
    setClub(null);
    setTables([]);
    setTournaments([]);
    setLoading(true);
    loadingRef.current = false;
    hasDataRef.current = false;
    listsPaintedRef.current = false;
  }, [clubId]);

  // ── Watchdog: a hung fetch must never strand the skeleton forever ──
  // Dan 2026-08-20 (real-browser E2E finding): entering a club intermittently
  // sat on the loading skeleton for 60s+ — a supabase fetch in loadClubData
  // stalled without resolving OR rejecting, so the finally{} that clears
  // `loading` never ran. Classic house bug shape: silent hang, no error, no
  // retry path. If the load is still pending after 15s, report it, unstick
  // the dedup ref so a retry can actually run, and drop `loading` — with no
  // club data that renders the existing "Club Not Found / Retry" panel; with
  // cached data it simply ends a background refresh that was going nowhere.
  const [loadStalled, setLoadStalled] = useState(false);
  /** Why the club read came back empty, shown on the error panel (2026-08-23). */
  const [loadFailure, setLoadFailure] = useState<string | null>(null);
  useEffect(() => {
    if (!loading) return;
    const watchdog = setTimeout(() => {
      reportError(
        new Error('club home initial load exceeded 15s (stalled fetch)'),
        'ClubHomePage.load_watchdog_timeout'
      );
      loadingRef.current = false;
      setLoadStalled(true);
      setLoading(false);
    }, 15000);
    return () => clearTimeout(watchdog);
  }, [loading]);

  // Any successful club load clears the stall state, so a slow-but-working
  // connection that finishes after the watchdog fired snaps back to normal.
  useEffect(() => {
    if (club) setLoadStalled(false);
  }, [club]);

  // SWR: show cached club data instantly on mount
  useEffect(() => {
    if (!clubId) return;
    const cached = getClubHomeCache(clubId);
    if (cached && cached.club) {
      setClub(cached.club);
      if (cached.tables?.length) setTables(cached.tables);
      hasDataRef.current = true;
      setLoading(false);
    }
  }, [clubId]);

  // Confirm modal state for table deletion
  const [deleteTableConfirm, setDeleteTableConfirm] = useState<{
    show: boolean;
    tableId: string | null;
    tableName: string | null;
  }>({ show: false, tableId: null, tableName: null });

  useEffect(() => {
    if (clubId) {
      clubIdRef.current = clubId;
      let isMounted = true;
      loadClubData(() => isMounted);
      return () => {
        isMounted = false;
        // Any answer still in flight belongs to the club being left.
        // eslint-disable-next-line react-hooks/exhaustive-deps
        loadTokenRef.current++;
      };
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clubId]);

  // ── Realtime subscription: live table updates (player counts, status) ──
  useEffect(() => {
    if (!clubId) return;
    let isMounted = true;
    let playingRefreshTimer: ReturnType<typeof setTimeout> | null = null;
    let occupancyTimer: ReturnType<typeof setInterval> | null = null;

    const setupRealtime = async () => {
      const resolvedId = await resolveClubUUID(clubId);
      // UNION LAW (Dan 2026-08-20): remember the club the player entered
      // through. Buy-ins draw chips from THIS club and rake is earned for it,
      // so the club context must survive the hop into a union table.
      try {
        useUserStore.getState().setCurrentClub(resolvedId);
      } catch {
        /* non-fatal */
      }
      if (!isMounted) return;

      // Check if this club is in a union — if so, listen on union_id in addition to club_id
      let unionId: string | null = null;
      try {
        const { data: ucCheck, error: ucError } = await supabase
          .from('union_clubs')
          .select('union_id')
          .eq('club_id', resolvedId)
          .limit(1)
          .maybeSingle();
        /* FAILURE IS NOT ABSENCE - the same law loadClubData spends forty
           lines honouring, which this path did not. The error was destructured
           away and the catch below is commented "standalone club", so an RLS
           blip or a timeout was silently read as "this club is not in a union".
           Everything downstream then diverges from the fetch: the two union
           channels are never subscribed (union tables and tournaments stop
           arriving live), belongsInTableList admits foreign rows, and the
           BBJ subscription binds to the retired
           club-level pool instead of the union pool that actually grows, and
           the table-delete scoping narrows to club_id. Fall back to the same
           cached answer loadClubData uses rather than guessing. */
        if (ucError) throw ucError;
        if (ucCheck?.union_id) {
          unionId = ucCheck.union_id;
        }
      } catch (e) {
        reportError(e, 'ClubHomePage.setupRealtime');
        // Last known good, written by loadClubData's own union resolution
        // under the same key (sessionStorage — see `unionCacheKey` there).
        try {
          const cached = sessionStorage.getItem(`ca_union_of_${resolvedId}`);
          if (cached) unionId = cached;
        } catch {
          /* storage disabled */
        }
      }

      if (!isMounted) return;

      const channelKey = `club-tables-${clubId}`;
      /**
       * A CHANNEL WITH NO FACTORY IS A CHANNEL THAT NEVER COMES BACK.
       *
       * MasterBus's health monitor reaps a dead channel and then looks for a
       * factory to rebuild it; with none registered it logs
       * `No factory for "<key>" -- removed only` and stops. isCriticalChannelKey
       * protects `table-cards-secure-*` and nothing else, so after the first
       * CHANNEL_ERROR or TIMED_OUT on this key the lobby lost live tables,
       * tournaments AND the BBJ ticker for the rest of the visit - while
       * `wsConnected` kept its last value, so GlobalUXIndicators still said
       * connected. The only recovery was the 90s poll, which is itself
       * visibility-gated.
       *
       * setupRealtime is idempotent (getOrCreateChannel returns the existing
       * channel, and the cleanup below removes it), so it is safe as the
       * factory. Registered BEFORE the handlers so a reap that lands mid-setup
       * still has something to call.
       */
      masterBus.registerChannelFactory(channelKey, () => {
        setupRealtime().catch((e) =>
          console.warn('[ClubHomePage] realtime auto-recovery failed:', e)
        );
      });
      let channel = masterBus.getOrCreateChannel(channelKey);

      // Realtime admission rules — these MUST mirror the fetch queries below
      // (the cash-table query and the tournament queries). Realtime `filter:`
      // only supports single-column equality, so anything more expressive than
      // that has to be re-checked here or the live list and the fetched list
      // diverge until the next reload.
      /**
       * The scope these admission rules judge by is THE SAME OBJECT the
       * fetches below are scoped with. It used to be re-typed here with a
       * comment saying it "MUST mirror the fetch queries" - which is how it
       * drifted. See src/utils/clubScope.ts.
       */
      const rtScope: ClubScope = { clubId: resolvedId, unionId };

      const belongsInTableList = (row: any): boolean => {
        if (!row) return false;
        if (row.tournament_id) return false; // tournament sub-table, not a cash game
        if (row.is_deleted === true) return false;
        if (row.status === 'closed' || row.status === 'deleted') return false;
        return inClubScope(row, rtScope);
      };

      const belongsInTournamentList = (row: any): boolean => {
        if (!row) return false;
        // Same array the fetch uses — see LOBBY_TOURNAMENT_STATUSES.
        if (!LOBBY_TOURNAMENT_STATUSES.includes(String(row.status))) return false;
        return inClubScope(row, rtScope);
      };

      /* `tables.current_players` changes on every live seat transition. Use
         that scoped realtime event as the trigger, but re-read the count from
         get_club_home instead of adding deltas in the browser: distinct users,
         union visibility and tournament seats are database rules and must not
         be approximated by whichever card happened to update. Bursts (a table
         opening or balancing several seats) collapse to one authoritative
         recount. */
      /* ONE NUMBER, ONE LIGHT CALL (2026-09-02). This re-called get_club_home -
         the entire lobby payload, 1.8 s mean under RLS - every 250 ms of table
         churn, just to read `players_playing`. With 1,131 open cash tables
         changing on every seat transition that was ~70 calls a minute around
         the clock and 26% of all database time on the platform, and the
         database it saturated is the one every hand and buy-in queues behind.
         get_club_players_playing answers the same question in ~50 ms, and two
         seconds of debounce turns a burst of seat events into one recount. */
      const refreshScopedPlaying = () => {
        if (playingRefreshTimer) clearTimeout(playingRefreshTimer);
        playingRefreshTimer = setTimeout(async () => {
          const { data, error } = await supabase.rpc('get_club_players_playing', {
            p_club_key: resolvedId,
          });
          if (!isMounted) return;
          if (error) {
            reportError(error, 'ClubHomePage.players_playing_realtime_refresh_failed');
            return;
          }
          const next = Number(data);
          if (Number.isFinite(next)) setPlayersPlaying(next);
        }, 2_000);
      };

      const handleTableChange = (payload: any) => {
        if (!isMounted) return;
        if (payload.eventType === 'UPDATE' && payload.new) {
          const updated = payload.new as any;
          // P2-2: closeTable/deleteTable flip status='closed'/'deleted' or
          // is_deleted=true and arrive here as UPDATE events. Merging kept the
          // row as a clickable card (filteredTables doesn't exclude by status),
          // so drop it from the list instead of merging when it goes dead.
          if (
            updated.is_deleted === true ||
            updated.status === 'closed' ||
            updated.status === 'deleted'
          ) {
            setTables((prev) => prev.filter((t) => t.id !== updated.id));
          } else {
            setTables((prev) => prev.map((t) => (t.id === updated.id ? { ...t, ...updated } : t)));
          }
        } else if (payload.eventType === 'INSERT' && payload.new) {
          // 2026-08-19: the INSERT branch checked nothing, so rows the fetch
          // deliberately excludes appeared live and stayed until a reload —
          // tournament sub-tables shown as joinable cash games, and (for a
          // union club) the club's own NON-private tables, which this lobby
          // must not list. Realtime `filter:` is single-column equality and
          // cannot express that rule, so it is enforced here instead.
          if (!belongsInTableList(payload.new)) return;
          setTables((prev) => {
            if (prev.some((t) => t.id === payload.new.id)) return prev;
            return [payload.new as any, ...prev];
          });
        } else if (payload.eventType === 'DELETE' && payload.old) {
          setTables((prev) => prev.filter((t) => t.id !== (payload.old as any).id));
        }
        refreshScopedPlaying();
      };

      const handleTournamentChange = (payload: any) => {
        if (!isMounted) return;
        if (payload.eventType === 'UPDATE' && payload.new) {
          const updated = payload.new as any;
          // A tournament leaving a joinable state (CANCELLED/COMPLETED) used to
          // be merged and left on screen as a clickable card — re-opening the
          // silent-join bug live, without a refresh. Drop it instead, mirroring
          // the table handler.
          if (!belongsInTournamentList(updated)) {
            setTournaments((prev) => prev.filter((t) => t.id !== updated.id));
          } else {
            setTournaments((prev) =>
              prev.map((t) => (t.id === updated.id ? { ...t, ...updated } : t))
            );
          }
        } else if (payload.eventType === 'INSERT' && payload.new) {
          if (!belongsInTournamentList(payload.new)) return;
          setTournaments((prev) => {
            if (prev.some((t) => t.id === payload.new.id)) return prev;
            return [payload.new as any, ...prev];
          });
        } else if (payload.eventType === 'DELETE' && payload.old) {
          setTournaments((prev) => prev.filter((t) => t.id !== (payload.old as any).id));
        }
      };

      // 1. Subscribe to Club Tables
      channel = channel.on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'tables', filter: `club_id=eq.${resolvedId}` },
        handleTableChange
      );

      // 2. Subscribe to Club Tournaments
      channel = channel.on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'tournaments', filter: `club_id=eq.${resolvedId}` },
        handleTournamentChange
      );

      // 3. Dual-Channel: Subscribe to Union Tables and Tournaments if applicable
      if (unionId) {
        channel = channel.on(
          'postgres_changes',
          { event: '*', schema: 'public', table: 'tables', filter: `union_id=eq.${unionId}` },
          handleTableChange
        );
        channel = channel.on(
          'postgres_changes',
          { event: '*', schema: 'public', table: 'tournaments', filter: `union_id=eq.${unionId}` },
          handleTournamentChange
        );
      }

      // 4. Live BBJ — subscribe to the CORRECT bbj_pools row (union pool for union
      // clubs, else club pool) so the header jackpot ticks up in real time as rake
      // funds it, instead of showing a value frozen at fetch time.
      const handleBBJChange = (payload: any) => {
        if (!isMounted) return;
        const row = (payload?.new ?? payload?.old) as
          | { main_balance?: number | string }
          | undefined;
        // main_balance is numeric(14,2), and PostgREST/Realtime deliver
        // numerics as STRINGS ("350.40"). The old guard was
        // `typeof row.main_balance === 'number'`, which is therefore NEVER
        // true - every live tick was silently dropped and the banner only
        // ever showed the value fetched at mount. Coerce first, then check.
        const next = Number(row?.main_balance);
        if (Number.isFinite(next)) setJackpotAmount(next);
      };
      channel = channel.on(
        'postgres_changes',
        unionId
          ? { event: '*', schema: 'public', table: 'bbj_pools', filter: `union_id=eq.${unionId}` }
          : {
              event: '*',
              schema: 'public',
              table: 'bbj_pools',
              filter: `club_id=eq.${resolvedId}`,
            },
        handleBBJChange
      );

      /**
       * A DROPPED SOCKET USED TO MEAN A STALE LOBBY UNTIL THE NEXT RELOAD.
       *
       * Dan 2026-08-23: "ANY TIME THE UNION CREATES NEW TABLES, THEY MUST BE
       * DISPLAYED INSIDE THEIR ATTACHED CLUBS RIGHT AWAY."
       *
       * That held only while the websocket stayed up. This callback set a
       * flag and logged; nothing re-read the lists. Every game the union
       * opened while the connection was down - and CHANNEL_ERROR and
       * TIMED_OUT are both handled here, so it does go down - stayed
       * invisible to that club until the player happened to reload.
       *
       * Realtime gives no backlog on resubscribe: the events fired during the
       * gap are simply gone. The only way to close it is to re-read once the
       * channel is live again. `firstSubscribe` keeps the initial SUBSCRIBED
       * from firing a second fetch on top of the one already in flight.
       */
      /* THE LOBBY DOES NOT DEPEND ON REALTIME TO BE RIGHT (Dan 2026-09-02:
         "FIX THE REAL TIME CONNECTION FOR THE MIDWAY UNION, CLUB JAQK AND
         SHARK CLUB ... ANY AND ALL NEW CLUBS ... MUST HAVE ALL REAL TIME
         CHANNELS AND FUNCTIONALITY WIRED INTO THEM FROM THE START").

         The postgres_changes stream above is one decoder reading every byte of
         WAL this platform writes - measured 2.1 MB/s, ~180 GB a day at 220k
         hands - and its replication slot was 46 MB behind and growing (124 MB
         four minutes later). Every seat-count tick the lobby receives through
         it arrives a minute or more late, for every club alike, and there is
         no per-club switch anywhere that could make one club's stream fresher
         than another's. So the cards stop trusting the stream for occupancy:
         every 20 seconds, while the tab is visible, the page re-reads the four
         columns that change - id, current_players, status, max_players - for
         the same scope the fetch uses (one indexed query, ~100 ms), patches
         them onto the rows on screen, and asks for a full reload only when an
         OCCUPIED table it has never seen turns up (a new game) or a known one
         has closed. The stream still delivers the instant case when it is
         healthy; this is the floor under it, and it is wired into every club
         by construction because it is the lobby's own behaviour, not a
         per-club setting. */
      const pollOccupancy = async () => {
        if (!isMounted) return;
        if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
        const q = supabase
          .from('tables')
          .select('id, current_players, status, max_players, club_id, union_id, is_private');
        applyClubScope(q, rtScope);
        const { data, error } = await q
          .eq('is_deleted', false)
          .not('status', 'in', '("closed","deleted")')
          .is('tournament_id', null)
          .order('current_players', { ascending: false })
          .order('created_at', { ascending: false })
          .limit(QUERY_LIMITS.LIST);
        if (!isMounted) return;
        if (error) {
          reportError(error, 'ClubHomePage.occupancy_poll_failed');
          return;
        }
        const rows = (data ?? []) as Array<{
          id: string;
          current_players: number | null;
          status: string | null;
          max_players: number | null;
        }>;
        const fresh = new Map(rows.map((r) => [String(r.id), r]));
        let needsReload = false;
        setTables((prev) => {
          const known = new Set(prev.map((t) => String(t.id)));
          for (const r of rows) {
            if (!known.has(String(r.id)) && Number(r.current_players ?? 0) > 0) needsReload = true;
          }
          let changed = false;
          const next = prev.map((t) => {
            const r = fresh.get(String(t.id));
            if (!r) return t;
            const cp = Number(r.current_players ?? 0);
            if (
              Number((t as any).current_players ?? 0) === cp &&
              (t as any).status === r.status &&
              Number((t as any).max_players ?? 0) === Number(r.max_players ?? 0)
            ) {
              return t;
            }
            changed = true;
            return { ...t, current_players: cp, status: r.status, max_players: r.max_players };
          });
          return changed ? (next as typeof prev) : prev;
        });
        if (needsReload) void loadClubData(() => isMounted);
        refreshScopedPlaying();
      };
      occupancyTimer = setInterval(() => {
        void pollOccupancy();
      }, 20_000);

      let firstSubscribe = true;
      channel.subscribe((status: string, err?: Error) => {
        /* Every other handler in this effect checks isMounted; this one did
           not, so a late CHANNEL_ERROR or TIMED_OUT arriving after the page
           unmounted set state on a torn-down component. */
        if (!isMounted) return;
        setWsConnected(status === 'SUBSCRIBED');
        if (status === 'SUBSCRIBED') {
          if (firstSubscribe) {
            firstSubscribe = false;
          } else {
            // Re-armed after a drop: whatever happened in the gap is missing.
            void loadClubData(() => isMounted);
          }
          return;
        }
        if (status === 'CHANNEL_ERROR') {
          if (err) reportError(err?.message || err, 'ClubHomePage._Tables_RT_channel_error');
        } else if (status === 'TIMED_OUT') {
          console.warn('[ClubHomePage] Tables RT channel timed out');
        }
      });
    };

    setupRealtime().catch((e) => console.warn('[ClubHomePage] Table realtime setup failed:', e));

    return () => {
      isMounted = false;
      if (playingRefreshTimer) clearTimeout(playingRefreshTimer);
      if (occupancyTimer) clearInterval(occupancyTimer);
      // Drop the factory FIRST. Removing the channel while its factory is
      // still registered is an invitation for the health monitor to rebuild
      // the one we are deliberately tearing down.
      masterBus.removeChannelFactory(`club-tables-${clubId}`);
      masterBus.removeRegisteredChannel(`club-tables-${clubId}`);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clubId]);

  // ── Realtime subscription: club member count updates ──
  // Synchronous when the club-code -> UUID mapping is already persisted on
  // the device (clubIdResolver) — the wallet and every realtime filter that
  // keys on this can bind in the first render instead of one roundtrip later.
  const [resolvedClubId, setResolvedClubId] = useState<string | null>(() =>
    clubId ? resolveClubUUIDSync(clubId) : null
  );

  useEffect(() => {
    setWalletsExpanded(false);
    setVisibleWalletCount(0);
  }, [resolvedClubId]);
  useEffect(() => {
    resolvedClubIdRef.current = resolvedClubId;
  }, [resolvedClubId]);

  // ── SPIN QUICK-JOIN (Dan 2026-08-20: "there is 'no lobby' for a spin, you
  // just start on a table") ──────────────────────────────────────────────────
  // Tap a spin tile -> register (hopping to an open sibling spin of the same
  // buy-in if this one is full or closed) -> the engine starts the game the
  // moment the held seat is taken (start-when-full, 5s discovery) -> poll for
  // our seat -> land on the table. The overlay covers the wait; Cancel backs
  // out of the WAIT (the registration stands — the game still starts).
  const [spinJoin, setSpinJoin] = useState<{ name: string; stage: string } | null>(null);
  const spinJoinCancelRef = useRef(false);
  /* `spinJoin` is state, so two taps landing in the same tick both read the
     stale null and both proceed. A ref flips synchronously, which is what
     "one join at a time" actually requires. */
  const spinJoinBusyRef = useRef(false);

  const spinQuickJoin = useCallback(
    async (
      t: { id: string; name: string; buy_in_amount: number },
      variant: 'spin' | 'sng' = 'spin'
    ) => {
      if (spinJoin || spinJoinBusyRef.current) return; // one join at a time
      spinJoinBusyRef.current = true;
      spinJoinCancelRef.current = false;
      setSpinJoin({ name: t.name, stage: 'Opening The Table' });
      const fail = (msg: string) => {
        setSpinJoin(null);
        toast?.error?.(msg);
      };
      try {
        const { data: authData } = await getAuthUser();
        const uid = authData?.user?.id;
        if (!uid) return fail('Sign In To Play');

        // ── SEAT-FIRST (Dan 2026-08-21) ──────────────────────────────────
        // "A PLAYER SITS DOWN AT A TABLE AND BUYS INTO THE SPIN OR HEADS UP,
        // LIKE A CASH GAME." So a tile does NOT register anybody. It opens
        // the TABLE, where the seats are visible and one tap buys the seat
        // the player chose. Registering here instead would put them in the
        // game without a seat — the MTT shape Dan is replacing.
        //
        // Dan 2026-08-23, verbatim: "it needs to take you to the table showing
        // the 3 seats, the user should then select which seat they want ... (it
        // currently now only gives you this generic 'dealing you in' pop up)".
        // That pop-up was this function's legacy fallback: when no open table
        // was found it called fn_register_for_tournament, which TAKES THE
        // BUY-IN before the player has picked a seat, then polled for a seat
        // the engine might never hand out. It is gone. A tile now either opens
        // a live table or fails loudly — it never charges anyone.
        //
        // Spin tables are recycled continuously (the lobby churns roughly ten
        // tables a minute), so a tile's table can be mid-swap on the exact
        // tick the player taps. Re-read a few times before giving up rather
        // than punting them into a registration they never asked for.
        let tableId: string | null = null;
        for (let attempt = 0; attempt < 4 && !tableId; attempt++) {
          if (spinJoinCancelRef.current) return;
          if (attempt > 0) await new Promise((r) => setTimeout(r, 700));
          /* The DATABASE's own primary-table election (occupancy first,
             oldest to break the tie — identical to the engine's choice), so
             a duplicate's empty NEWER table can never outrank the one the
             players are sitting on. See resolveTournamentLiveTable. */
          const resolved = await tableService.resolveTournamentLiveTable(t.id);
          /* Cancel is checked AFTER the await as well as before it. Checking
             only at the top of the iteration meant a Cancel pressed while a
             lookup was in flight closed the overlay and then navigated anyway
             — the player was dropped at a table they had just backed out of. */
          if (spinJoinCancelRef.current) return;
          tableId = resolved;
        }

        if (tableId) {
          if (spinJoinCancelRef.current) return;
          setSpinJoin(null);
          navigate(`/table/${tableId}`);
          return;
        }

        // ── HOP TO THE SIBLING (Dan 2026-08-28: "THIS TABLE IS NO LONGER
        // OPEN" dead ends) ────────────────────────────────────────────────
        // The fleet recycles these games continuously: when one completes,
        // its REPLACEMENT is a brand-new tournament id under the same name
        // and buy-in, and the tile the player tapped still holds the old id.
        // The header comment above always promised the hop to an open
        // sibling; this is it. Identity is name + buy-in + variant, which is
        // exactly what the tile showed the player, so the game they land in
        // is the game they chose — just the running edition of it.
        /* ── THE HOP MUST NOT LEAVE THIS CLUB (2026-08-28, audit) ──────────
           The identity above is name + buy-in + variant, and on this platform
           those three are IDENTICAL ON EVERY BOARD by construction — the
           recurring service builds "10 Chip Spin PLO4" from the ladder, and
           its own code comments that "`10 Chip Spin PLO4` is the same string
           on every board", which is why the SERVER-side equivalent is
           owner-scoped. This query was not scoped at all, so a recycled tile
           could resolve ANOTHER CLUB'S spin, navigate the player into it, and
           let the seat sheet charge that club's wallet at that club's rake —
           with nothing on screen saying they had changed clubs.

           Latent rather than live today (one club currently runs the ladder,
           and all 33 open keys are distinct), which is exactly why it had to
           be fixed before a second board makes it real. Scoped through the
           same `applyClubScope` every other lobby query in this file uses, so
           the hop can only ever land on a game this club is entitled to see. */
        /* Scoped to the ORIGINAL game's own club — the tightest rule there
           is, and it needs no component state (this callback is defined
           before the club data loads). The replacement for a recycled board
           is created by the same club that ran the original, so requiring an
           exact club_id match is both correct and impossible to widen by
           accident. `buy_in_amount` is read from the row rather than from the
           tile: a heads-up SNG's tile value is buy_in + 5% fee, which would
           match no row at all. If the original row cannot be read we do NOT
           guess — we fall through to the honest "no longer open" message. */
        const { data: originRow, error: originErr } = await supabase
          .from('tournaments')
          .select('club_id, buy_in_amount')
          .eq('id', t.id)
          .maybeSingle();
        if (originErr) {
          reportError?.(originErr, 'ClubHomePage.spinQuickJoin_origin_lookup', {
            tournamentId: t.id,
          });
        }
        const originClubId = (originRow as { club_id?: string } | null)?.club_id;
        const originBuyIn = Number((originRow as { buy_in_amount?: number } | null)?.buy_in_amount);

        const { data: sibs, error: sibErr } = originClubId
          ? await supabase
              .from('tournaments')
              .select('id')
              .eq('status', 'REGISTERING')
              .eq('variant', variant === 'sng' ? 'sng' : 'spin')
              .eq('club_id', originClubId)
              .eq('name', t.name)
              .eq('buy_in_amount', Number.isFinite(originBuyIn) ? originBuyIn : t.buy_in_amount)
              .neq('id', t.id)
              .order('created_at', { ascending: false })
              .limit(1)
          : { data: null, error: null };
        if (sibErr) {
          reportError?.(sibErr, 'ClubHomePage.spinQuickJoin_sibling_lookup');
        }
        const sibId = (sibs || [])[0]?.id as string | undefined;
        if (sibId && !spinJoinCancelRef.current) {
          const sibTableId = await tableService.resolveTournamentLiveTable(sibId);
          if (spinJoinCancelRef.current) return;
          if (sibTableId) {
            setSpinJoin(null);
            navigate(`/table/${sibTableId}`);
            return;
          }
        }

        // Still nothing open: this game has finished or is being rebuilt. Say
        // so plainly instead of sending the player at a table that is not there.
        return fail(
          variant === 'sng'
            ? 'That Sit N Go Is No Longer Open, Pick Another'
            : 'That Spin Is No Longer Open, Pick Another'
        );
      } catch (err: unknown) {
        reportError?.(err as Error, 'ClubHomePage.spinQuickJoin');
        fail('Could Not Open That Game, Please Try Again');
      } finally {
        /* Every path above returns early — cancel, success, four flavours of
           failure. Releasing the guard anywhere but here leaves a tile that
           can never be tapped again after one unlucky exit. */
        spinJoinBusyRef.current = false;
      }
    },
    [spinJoin, navigate, toast]
  );

  useEffect(() => {
    if (!clubId) {
      setResolvedClubId(null);
      return;
    }
    resolveClubUUID(clubId)
      .then(setResolvedClubId)
      .catch((e) => console.warn('[ClubHomePage] Failed to resolve clubId:', e));
  }, [clubId]);

  /* Saved Advanced Filters are keyed per club, so they can only be read once
     the UUID is known. Re-runs on a club switch: one club's "Bomb Pot only"
     must never silently apply to another club's lobby. */
  useEffect(() => {
    if (!resolvedClubId) {
      setAdvFilters({});
      return;
    }
    setAdvFilters(loadFilters(resolvedClubId));
  }, [resolvedClubId]);

  /* The same rule for the tab / sort / Favorites triple, keyed the same way.
     `viewPrefsTouched` is the guard described where the ref is declared: if
     the player has already picked a tab in this visit, their pick wins over
     whatever the last visit left behind. */
  useEffect(() => {
    if (!resolvedClubId) return;
    if (viewPrefsOwner.current === resolvedClubId) return;

    /* A SWITCH IS NOT A FIRST LOAD. Going from club A to club B must clear
       "the player already chose" -- that choice was about A. Leaving it set
       would (a) suppress B's own saved view and (b) leave A's values in state
       looking like B's, which is what the persistence effect below would then
       write into B's key. On a FIRST load there is no previous club, so the
       flag survives and a tab tapped before resolution still wins. */
    const switchingClubs = viewPrefsOwner.current !== null;
    viewPrefsOwner.current = resolvedClubId;
    if (switchingClubs) viewPrefsTouched.current = false;

    const saved = loadViewPrefs(resolvedClubId);
    setViewPrefs(saved);
    if (viewPrefsTouched.current) return;

    const tab = saved.tab ?? 'ALL';
    setGameType(tab);
    setSortKey(sortForTab(saved, tab));
    setFavoritesOnly(saved.favoritesOnly);
  }, [resolvedClubId]);

  /**
   * Record a preference and write it through in the same breath.
   *
   * ONE DOOR. Every control that changes the tab, the sort or the Favorites
   * chip goes through here, so there is no path that updates the screen and
   * forgets to persist — which is exactly how the column sort in LobbyTable
   * stayed saved while the sort control above it did not.
   */
  const updateViewPrefs = useCallback((patch: Partial<LobbyViewPrefs>) => {
    viewPrefsTouched.current = true;
    /* PURE UPDATER. The write used to happen INSIDE this callback, which is a
       side effect in a place React is explicitly allowed to run twice (it does
       exactly that under StrictMode, and reserves the right to in any
       concurrent render). Persisting from an effect keyed on the value means
       the write happens once per settled state, not once per attempted one. */
    setViewPrefs((prev) => ({
      ...prev,
      ...patch,
      sortByTab: { ...prev.sortByTab, ...(patch.sortByTab ?? {}) },
    }));
  }, []);

  /**
   * One writer, watching the value.
   *
   * THE ORDERING HAZARD THIS GUARDS. `resolvedClubId` and `viewPrefs` change
   * on different ticks. When the player moves from club A to club B, this
   * effect runs in the SAME commit as the hydration above -- and at that
   * moment `resolvedClubId` is already B while `viewPrefs` still holds A's
   * values, because `setViewPrefs` has not landed yet. Writing there would put
   * club A's tab, sort and Favorites into club B's storage key: exactly the
   * cross-club leak `lobbyViewPrefs` is keyed per club to prevent, reintroduced
   * one layer up.
   *
   * Two conditions close it. `viewPrefsOwner` proves the prefs in hand belong
   * to the club being written to, and `viewPrefsTouched` (cleared on a switch)
   * proves the player actually changed something rather than this being a
   * hydration echoing back what it just read.
   */
  useEffect(() => {
    if (!resolvedClubId) return;
    if (viewPrefsOwner.current !== resolvedClubId) return;
    if (!viewPrefsTouched.current) return;
    saveViewPrefs(resolvedClubId, viewPrefs);
  }, [resolvedClubId, viewPrefs]);

  /** Pick a tab: remember it, and restore that tab's own last sort. */
  const selectGameType = useCallback(
    (tab: GameType) => {
      setGameType(tab);
      /* The tab buttons used to force a default sort here unconditionally,
         which meant a player's Sort By choice could not survive a single tab
         change. sortForTab keeps those defaults for a tab never sorted by
         hand and honours the choice everywhere else. */
      setSortKey(sortForTab(viewPrefs, tab));
      updateViewPrefs({ tab });
    },
    [viewPrefs, updateViewPrefs]
  );

  /** Pick a sort: it belongs to the tab it was chosen on. */
  const selectSortKey = useCallback(
    (key: SortKey) => {
      setSortKey(key);
      updateViewPrefs({ sortByTab: { [gameType]: key } });
    },
    [gameType, updateViewPrefs]
  );

  /** Toggle Favorites: remembered like everything else on this bar. */
  const selectFavoritesOnly = useCallback(
    (on: boolean) => {
      setFavoritesOnly(on);
      updateViewPrefs({ favoritesOnly: on });
    },
    [updateViewPrefs]
  );

  const handleMemberUpdate = useCallback(() => {
    setAgentSetupRevision((revision) => revision + 1);
    loadClubDataRef.current();
  }, []);

  useMasterBusChannel({
    channelName: clubId ? `club-members-${clubId}` : null,
    table: 'club_members',
    filter: resolvedClubId ? `club_id=eq.${resolvedClubId}` : null,
    event: '*',
    onPayload: handleMemberUpdate,
    enabled: !!resolvedClubId,
  });

  useMasterBusChannel({
    channelName: clubId ? `club-agents-${clubId}` : null,
    table: 'agents',
    filter: resolvedClubId ? `club_id=eq.${resolvedClubId}` : null,
    event: '*',
    onPayload: () => setAgentSetupRevision((revision) => revision + 1),
    enabled: !!resolvedClubId && isOwner,
  });

  // ── Bus Listeners: cross-page event reactivity (subscribeDebounced) ──
  useEffect(() => {
    let isMounted = true;
    const reload = () => {
      if (isMounted) loadClubDataRef.current(() => isMounted);
    };

    /* A club event may name the club by its UUID or by the id in the URL -
       the two are different strings on a slug route. ClubsService emits the
       resolved UUID now, but this page can be mounted under either, so match
       against both rather than against whichever one happens to be in the ref.
       Comparing only the URL id is how a CLUB_UPDATED for the club on screen
       could arrive and be ignored. */
    const matchesThisClub = (id: unknown) => {
      if (!id || typeof id !== 'string') return true; // no id: refresh anyway
      return id === clubIdRef.current || id === resolvedClubIdRef.current;
    };

    const unsubs = [
      masterBus.subscribeDebounced('CLUB_JOINED', reload, 300),
      masterBus.subscribeDebounced('CLUB_LEFT', reload, 300),
      masterBus.subscribeDebounced('ANNOUNCEMENT_CHANGED', reload, 300),
      // Phase 11: Only reload for OUR club's updates (not every club in the platform)
      masterBus.subscribeDebounced(
        'CLUB_UPDATED',
        (event) => {
          if (matchesThisClub(event.payload?.clubId)) {
            reload();
          }
        },
        300
      ),
      masterBus.subscribeDebounced(
        'CLUB_SETTINGS_UPDATED',
        (event) => {
          if (matchesThisClub(event.payload?.clubId)) {
            reload();
          }
        },
        300
      ),
    ];

    // 90-second fallback interval to ensure the page data doesn't get completely
    // stale when real-time events are missed.
    //
    // PERF 2026-08-24: gated on visibility. This is the club lobby - the most
    // visited screen in the app - and `reload()` is a full loadClubData(), so an
    // ungated timer kept re-running the whole lobby query set forever in every
    // backgrounded tab. It refreshes once on return instead, which is also more
    // correct: a player coming back wants current data immediately, not up to
    // 90 seconds later.
    const runFallback = () => {
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
      reload();
    };
    const fallbackInterval = setInterval(runFallback, 90_000);
    /* The visibilitychange listener that used to sit here was the SECOND one
       on this page - useVisibilityRefresh registers the other, higher up -
       and the two raced through loadClubData's own loadingRef dedupe, so
       whichever fired first won. This one held the stale render-0 closure, so
       on a returning tab the previous club could win that race and repaint
       over the current one. One listener, and it is the hook's. */

    return () => {
      isMounted = false;
      clearInterval(fallbackInterval);
      unsubs.forEach((u) => u());
    };
  }, []);

  /* Assigned in an effect with no dep array, so it re-runs after EVERY
     commit and the ref always holds the function from the render that is
     actually on screen. */
  useEffect(() => {
    loadClubDataRef.current = loadClubData;
  });

  const loadClubData = async (getIsMounted?: () => boolean) => {
    if (!clubId) return;
    // Request deduplication — skip if already loading
    if (loadingRef.current) return;
    loadingRef.current = true;
    // Only show loading spinner on initial load (no cached data), not background refreshes
    if (!hasDataRef.current && (!getIsMounted || getIsMounted())) setLoading(true);

    try {
      if (getIsMounted && !getIsMounted()) return;

      // Load club info — smart resolve: clubId may be UUID or integer club_id
      const { column: clubCol, value: clubVal } = resolveClubIdFilter(clubId);
      const { data: clubData, error: clubError } = await retryFetch(
        () =>
          supabase
            .from('clubs')
            .select(
              'id, club_id, name, slug, description, tagline, lobby_message, avatar_url, logo_url, banner_url, member_count, online_count, owner_id, level, hierarchy_units_rounded_up, player_threshold_current, player_threshold_next, hierarchy_threshold_current, hierarchy_threshold_next, chip_treasury, spins_enabled, created_at, is_union, union_id, opening_checklist_started_at'
            )
            .eq(clubCol, clubVal)
            .maybeSingle()
            .then((r) => r),
        { maxRetries: 4, baseDelayMs: 500, isMountedRef }
      );

      if (clubError || !clubData) {
        /* reportError only for an ACTUAL error - "no row matched" arrives as
           `clubError === null` and was being reported as a fault every time.
           And the toast only when there is nothing on screen: this same path
           runs on the 90-second background refresh and on every bus event, so
           a player sitting on a working, populated lobby with a flaky
           connection was getting a red toast every 90 seconds over data that
           was still perfectly good. */
        if (clubError) reportError(clubError, 'ClubHomePage.Failed_to_load_club');
        if (!hasDataRef.current) toast.error('Could Not Load Club Details');
        /* Dan 2026-08-23 reported this panel appearing every time on his phone,
           and it could not be reproduced from a clean session on any of his
           three clubs, by either entry path. The reason is that this state
           throws away the only fact that matters: WHY the read came back
           empty. A refused row (RLS), a malformed id (PostgREST 400) and a
           dropped connection all render the identical "moved or deleted"
           sentence, which is also a lie in two of those three cases.
           Keep the cause so the panel can show it and the next report carries
           its own diagnosis. */
        if (!getIsMounted || getIsMounted()) {
          setLoadFailure(
            clubError
              ? `${clubError.code ? clubError.code + ': ' : ''}${clubError.message || 'request failed'}`
              : `no club matched ${String(clubId).slice(0, 40)}`
          );
          setLoading(false);
        }
        return;
      }

      if (getIsMounted && !getIsMounted()) return;
      setClub(clubData);

      // ── ONE ROUND TRIP FOR THE WHOLE VISIBLE LOBBY ────────────────────────
      //
      // PERF 2026-08-23. Painting this page took SIX sequential round trips:
      // club row, membership+wallet, union row, union club ids, member count,
      // then finally tables+tournaments+BBJ. Measured against production the
      // queries cost ~9ms server-side; the wait is network latency, 150-250ms
      // per trip wired and 250-400ms on mobile - 1-1.5s, or 2-3s on a phone,
      // of watching a skeleton.
      //
      // public.get_club_home() returns all of it in ONE call (38ms measured on
      // the largest club: 1,172 members, 42 tables). It is SECURITY INVOKER,
      // so every RLS policy still applies and it can return only what this
      // browser could already fetch for itself - a latency fix, not a
      // permissions change.
      //
      // It runs ALONGSIDE the existing chain rather than replacing it: the
      // chain below still fills in diamonds, club level, XMTT tournaments and
      // the rest, and remains authoritative. This just gets the tables on
      // screen five round trips earlier.
      //
      // `lobbyPainted` arbitrates the fast path against the chain WITHIN one
      // load. It is a local of this invocation, so it says NOTHING about a
      // reload: the 90s timer, a visibilitychange and every bus event start a
      // fresh one at false while full rows are already on screen. That is what
      // let the narrow RPC rows repaint over good ones and made the cards jump
      // (see mergeFastRows). Two independent guards now, because either alone
      // would leave a hole:
      //   1. `lobbyAlreadyHasRows` - the fast path has no job on a warm reload.
      //      Its entire purpose is first paint; running it later can only
      //      downgrade what is already correct.
      //   2. mergeFastRows at the call site - a narrower row can never erase a
      //      wider one even if it does paint, which covers first paint racing a
      //      realtime patch, and any future partial source.
      let lobbyPainted = false;
      /* A per-load token. `lobbyPainted` is a local of THIS invocation, so it
         can arbitrate between the fast path and the chain WITHIN one load but
         cannot say anything about a different load: club A's in-flight RPC
         landing after the user has moved to club B still painted A's tables,
         A's role and A's jackpot over B. The token is bumped by every new
         load and by unmount, so a late answer knows it is stale. */
      const loadToken = ++loadTokenRef.current;
      const stale = () => loadToken !== loadTokenRef.current;
      Promise.resolve(supabase.rpc('get_club_home', { p_club_key: clubId }))
        .then(async ({ data: home, error: homeErr }) => {
          if (homeErr || !home || home.found !== true) return;
          if (stale() || (getIsMounted && !getIsMounted())) return;

          /**
           * PLAYERS CURRENTLY PLAYING.
           *
           * clubs.online_count is a denormalised column nothing keeps current,
           * so get_club_home counts occupied live seats directly. The RPC now
           * applies the same club/union visibility scope as the two game lists:
           * a standalone club sees only its own players, and a union-attached
           * club sees the players in the games available from that lobby.
           * No club may inherit the platform-wide total from another room.
           *
           * SET BEFORE THE lobbyPainted GUARD, deliberately. That guard exists
           * to stop a stale SNAPSHOT OF THE LISTS painting over fresher rows;
           * this number is not in the lists and has no fresher writer. Behind
           * the guard it was skipped on every warm load where the chain won
           * the race, and the header fell back to the stale 12 - which is
           * precisely the flapping being fixed here.
           */
          if (typeof home.players_playing === 'number') {
            setPlayersPlaying(home.players_playing);
          }

          if (lobbyPainted) return; // the real chain already answered

          /* WARM RELOAD: the authoritative chain has already painted this
             club's lists, and its rows carry five columns this RPC does not
             select. Painting now can only take information away, which is the
             card-jumping Dan recorded. The fast path exists to remove
             first-paint latency and there is none left to remove here.

             NOT `hasDataRef` - that is seeded from a boot cache holding no
             tournaments, so gating on it would skip the fast path on exactly
             the visit that needs it and leave the MTT board blank. See the
             declaration of listsPaintedRef. Cleared per club by the reset
             effect, so switching clubs still gets the speed-up. */
          if (listsPaintedRef.current) return;

          if (stale() || (getIsMounted && !getIsMounted())) return;
          lobbyPainted = true;
          try {
            if (home.club) {
              setClub((prev) => ({
                ...(prev || {}),
                ...home.club,
                member_count: home.member_count ?? home.club.member_count,
              }));
            }
            if (Array.isArray(home.tables)) setTables((prev) => mergeFastRows(prev, home.tables));
            if (Array.isArray(home.tournaments))
              setTournaments((prev) => mergeFastRows(prev, home.tournaments));
            if (home.union_id) {
              setIsInUnion(true);
              setUnionIdForCreate(home.union_id);
            }
            /* id -> name for every club whose games can land on this board.
               A union lobby lists games from several clubs side by side and
               had no way to say whose was whose. */
            if (home.club_names && typeof home.club_names === 'object') {
              setClubNames(home.club_names as Record<string, string>);
            }
            // Force a status check to ensure non-members and pending members get sent to the Invite page.
            let localSession = readLocalSession();
            if (!localSession?.userId) {
              const authRes = await getAuthUser();
              if (authRes?.data?.user?.id) {
                localSession = { userId: authRes.data.user.id } as any;
              }
            }
            if (localSession?.userId) {
              const { data: memStat, error: memErr } = await supabase
                .from('club_members')
                .select('status')
                .eq('club_id', home.club.id)
                .eq('user_id', localSession.userId)
                .maybeSingle();
              /* A FAILED READ IS NOT "NOT A MEMBER" (2026-08-28 audit).
                 `error` was discarded here, and Supabase resolves
                 `{ data: null, error }` on a query-level failure — so a
                 timeout, a 500 or an RLS hiccup was indistinguishable from a
                 stranger, and a paid-up member on a flaky connection was
                 ejected from their own club onto the invite screen with no
                 explanation. That is the exact anti-pattern this file's own
                 doctrine forbids a hundred lines below ("the database has
                 been timing statements out under load all day"), and which
                 loadMyGameStates already handles correctly.

                 Eviction now requires PROOF: a successful read that says the
                 viewer is not active/approved. An unreadable answer leaves
                 them where they are — the club's own RLS is the real gate,
                 so a genuine non-member still sees nothing.

                 The EVICTION ITSELF goes through `bounceToInvite` (in-tab
                 lobby round 2): on the club's own route that is the same
                 redirect as before, but embedded in a table tab it renders a
                 panel instead of navigating, because a route change there
                 collapses MultiTablePage and takes the action bar with it
                 while the player's other tables are still dealing. */
              if (memErr) {
                reportError(memErr, 'ClubHomePage.fastPath.membership_unreadable', {
                  clubId: home.club.id,
                });
              } else if (!memStat || !['active', 'approved'].includes(memStat.status)) {
                bounceToInvite();
                return;
              }
            } else {
              /* No local session AND the auth read did not produce a user. On
                 the fast path that is genuinely "signed out" — `readLocalSession`
                 is a synchronous localStorage read, so there is no timeout to
                 confuse it with. */
              bounceToInvite();
              return;
            }

            if (home.membership) {
              setUserRole((home.membership.role as ClubRole) || 'player');
            }
            const bal = Number(home.bbj?.main_balance);
            if (Number.isFinite(bal)) setJackpotAmount(bal);
            if (home.bbj?.id) setBbjPoolId(home.bbj.id);
            hasDataRef.current = true;
            setLoading(false);
          } catch (e) {
            reportError(e, 'ClubHomePage.fastPath');
          }
        })
        .catch(() => {
          // Best effort only. The authoritative chain below is untouched, so a
          // failure here costs the speed-up and nothing else.
        });

      // Use resolved UUID for all downstream FK queries
      const resolvedId = clubData.id;

      // ── START THE resolvedId-ONLY QUERIES NOW, AWAIT THEM WHERE THEY WERE ──
      //
      // PERF 2026-08-23. Getting the table list on screen took SIX sequential
      // round trips after the club row: member+diamonds, union row, union
      // clubs, member count, live count, then finally tables. Measured against
      // production the queries themselves are ~9ms; the wait is almost
      // entirely network latency, ~150-250ms per trip wired and 250-400ms on
      // mobile. That is 1-1.5s wired and 2-3s on mobile of pure waiting, more
      // than every remaining byte on the boot path combined.
      //
      // Neither of these two depends on the auth/membership chain they were
      // queued behind - both need only resolvedId - so they are started here
      // and awaited unchanged below. Nothing about the order of state updates
      // moves; only the network overlaps.
      //
      // The rejection handlers matter: a hoisted promise that rejects before
      // its await would otherwise surface as an unhandled rejection. Shaping
      // the failure as { data|count: null, error } keeps the existing
      // fail-open handling at each await site exactly as it was.
      const unionRowPromise = supabase
        .from('union_clubs')
        .select('union_id')
        .eq('club_id', resolvedId)
        .limit(1)
        .maybeSingle()
        .then(
          (r) => r,
          (error) => ({ data: null, error })
        );

      /* Standalone clubs need a live member count (clubs.member_count is
         denormalised and goes stale).

         THIS USED TO BE A DIRECT club_members COUNT, described here as "one
         cheap indexed count". It was neither cheap nor correct.

         NOT CORRECT: club_members has four permissive SELECT policies, and a
         viewer who is not a member, admin, owner or union overseer of this club
         matches none of them. So the count they got back was 0 - for a club
         with 588 active members. That is the same defect ClubsService.ts
         records on 2026-07-24 ("the featured Shark Club card showed 1 member
         for a 578-member club"); it was fixed for the featured card and left
         here. The `liveCount > 0` guard below is what stopped it being visible
         as a literal zero - a stale number was shown instead - so it degraded
         quietly rather than loudly, which is why it survived.

         NOT CHEAP: measured on production as the club owner, who can see all
         588 rows, the RLS filter evaluates a SECURITY DEFINER function per row:

           direct count ................. 204.61 ms
           fn_get_club_member_count ......  0.55 ms

         and pg_stat_statements had that statement shape at a 253 ms mean over
         591 calls, 1,882 ms at worst.

         fn_get_club_member_count is SECURITY DEFINER with a pinned search_path,
         so it answers the question the page is actually asking - how many
         members does this club have - rather than how many of them this viewer
         is allowed to enumerate. */
      const liveMemberCountPromise = supabase
        .rpc('fn_get_club_realtime_member_count', { p_club_id: resolvedId })
        .then(
          (r) => r,
          (error) => ({ data: null, error })
        );

      /* Not destructured. `getAuthUser()` resolving to undefined - which it
         does on an auth error - made this a TypeError ("Cannot destructure
         property 'user' of undefined"), caught by the outer try AFTER the
         club had been set but BEFORE tables and tournaments were, so a
         perfectly healthy club rendered empty behind a "Failed To Load Club
         Data" toast. */
      const authRes = await getAuthUser();
      const authUser = authRes?.data?.user ?? null;
      if (!authUser) {
        if (getIsMounted && !getIsMounted()) return;
        /**
         * ONLY ON POSITIVE EVIDENCE (Dan 2026-08-28 round 2) — the same rule
         * the union cascade below already follows, applied to the two checks
         * that were still bouncing on failure.
         *
         * `failed` means the auth read TIMED OUT or threw; it does not mean
         * there is no user. `loadClubData` re-runs on tab refocus, on a
         * realtime resubscribe and on a 90-second interval, and this page
         * stays mounted in a parked lobby tab for the whole session — so a
         * single blip while the player was heads-up in a hand navigated the
         * whole app to /invite, collapsed MultiTablePage to display:none, and
         * left them staring at a "Join This Club" page while their tables
         * dealt on invisibly behind it. Nobody clicked anything.
         *
         * Do nothing and let the next scheduled load answer the question.
         */
        if ((authRes as { failed?: boolean } | null)?.failed) return;
        bounceToInvite();
        return;
      }
      if (authUser) {
        if (getIsMounted && !getIsMounted()) return;
        setCurrentUserId(authUser.id);
        setIsOwner(clubData.owner_id === authUser.id);

        /* The viewer's ROLE is the only thing this read is for. It used to
           also fetch a chip balance and a diamond balance into a `wallet`
           state that nothing in this file ever read - DynamicWallet fetches
           its own - so every club load paid for a DiamondService round trip
           whose answer went straight into the bin. */
        const memberResult = await supabase
          .from('club_members')
          .select('role, status')
          .eq('club_id', resolvedId)
          .eq('user_id', authUser.id)
          .maybeSingle();

        /* Same rule as the fast path above: eviction requires PROOF, never a
           failed read. `memberResult.error` was discarded here, so any
           query-level failure read as "not a member" and bounced a real
           member to the invite screen mid-session (2026-08-28 audit).

           This load is not mount-only — it re-runs on tab refocus, on a
           realtime resubscribe and on a 90-second interval, and in the in-tab
           lobby this page never unmounts. So the failure window was the whole
           session, including while the player was seated: one blip and the
           app navigated to /invite, collapsing the table container mid-hand.
           `bounceToInvite` is the embedded-aware exit; see its definition. */
        if (memberResult.error) {
          reportError(memberResult.error, 'ClubHomePage.membership_unreadable', {
            clubId: resolvedId,
          });
        } else if (
          !memberResult.data ||
          !['active', 'approved'].includes((memberResult.data as any).status)
        ) {
          if (getIsMounted && !getIsMounted()) return;
          bounceToInvite();
          return;
        }

        if (memberResult.data) {
          if (getIsMounted && !getIsMounted()) return;
          setUserRole(memberResult.data.role || 'member');
        }
      }

      /**
       * THE UNION -> CLUB CASCADE (rebuilt 2026-08-23)
       *
       * Dan: "the mtt, spins and heads up tournaments keep breaking and not
       * displaying correctly. Sometimes it displays, then it disappears."
       *
       * Everything below forks on `unionId`. With it, a union club lists its
       * own private games PLUS every union game (138 games, 35 of them MTTs).
       * Without it, the same club lists only what it owns - and a union club
       * owns almost nothing, so the MTT tab reads "Nothing Here On This Tab"
       * while 138 games are running one join away.
       *
       * That fork hung on ONE `union_clubs` read whose catch treated FAILURE
       * exactly like ABSENCE. A timeout, a 500, an RLS hiccup - any of them
       * silently demoted the club to standalone and emptied the lobby. The
       * database has been timing statements out under load all day, so this
       * fired often enough for Dan to watch the board appear and vanish.
       *
       * A club's union membership changes approximately never, so the answer
       * is resolved from three independent sources and only ever downgraded
       * on POSITIVE evidence of absence:
       *
       *   1. the union_clubs row          (authoritative)
       *   2. clubs.union_id               (already on the row we just fetched
       *                                    - no extra round trip)
       *   3. the last answer we cached    (survives a blip entirely)
       *
       * Standalone is concluded only when a query SUCCEEDS and returns
       * nothing, and nothing is cached. Anything else keeps the last known
       * good scope, because showing a union club its union is right far more
       * often than showing it an empty room.
       */
      const unionCacheKey = `ca_union_of_${resolvedId}`;
      const readCachedUnion = (): string | null => {
        try {
          return sessionStorage.getItem(unionCacheKey) || null;
        } catch {
          return null;
        }
      };
      const cacheUnion = (id: string | null) => {
        try {
          if (id) sessionStorage.setItem(unionCacheKey, id);
          else sessionStorage.removeItem(unionCacheKey);
        } catch {
          /* storage unavailable */
        }
      };

      // Check if this club is inside a union
      let unionId: string | null = null;
      let unionClubIds: string[] = [resolvedId];
      try {
        const { data: ucRow, error: ucErr } = await unionRowPromise;
        if (ucErr) {
          // FAILURE IS NOT ABSENCE. Fall back, in order, to the club row we
          // already hold and then to the last good answer.
          const fallback =
            (clubData as { union_id?: string | null } | null)?.union_id || readCachedUnion();
          if (fallback) {
            unionId = fallback;
            if (getIsMounted && !getIsMounted()) return;
            setIsInUnion(true);
            setUnionIdForCreate(fallback);
            // Deliberately NOT re-querying union_clubs for the sibling ids:
            // clubHomeWaterfall.test.ts forbids an inline read here and is
            // right to - that is how this page got its waterfall back last
            // time. unionClubIds only widens the CASH-table filter; the
            // tournament fork that empties the MTT tab keys on unionId alone.
            // A rare fallback showing club-scoped cash tables is a far smaller
            // wrong than an empty lobby.
          }
        }
        if (!ucErr && !ucRow) {
          // A clean answer of "no row" is still only half the story: the club
          // row itself may name a union (they are written by different paths).
          /**
           * ...AND THE CACHE, which this branch used to ignore.
           *
           * The error branch above falls back to `clubs.union_id` and then to
           * the last good answer. This one stopped at the club row, so a
           * union_clubs read that came back 200 WITH ZERO ROWS demoted a union
           * club to standalone even though the browser was holding the right
           * answer from a minute ago. A clean answer of "no row" is not an
           * error, so nothing else treats it as one.
           *
           * Same rule in both branches now: conclude standalone only on
           * positive evidence from every source, not on the first silent one.
           */
          const fromClubRow =
            (clubData as { union_id?: string | null } | null)?.union_id || readCachedUnion();
          if (fromClubRow) {
            unionId = fromClubRow;
            if (getIsMounted && !getIsMounted()) return;
            setIsInUnion(true);
            setUnionIdForCreate(fromClubRow);
            // Same reasoning as the error branch above: no inline read here.
          } else {
            cacheUnion(null); // genuinely standalone, on positive evidence
          }
        }
        if (!ucErr && ucRow) {
          if (getIsMounted && !getIsMounted()) return;
          setIsInUnion(true);
          unionId = ucRow.union_id;
          setUnionIdForCreate(ucRow.union_id);
          // Remember it: the next load survives a timeout without emptying.
          cacheUnion(ucRow.union_id);

          // Get ALL club IDs in this union + member count in parallel
          const [allUcResult, memberCountResult] = await Promise.all([
            supabase.from('union_clubs').select('club_id').eq('union_id', unionId),
            // A CLUB's own count. Unions re-query below. Same RPC as the
            // standalone path above, for the same two reasons: a direct count
            // is RLS-filtered (0 for a non-member) and ~370x slower.
            supabase.rpc('fn_get_club_realtime_member_count', { p_club_id: resolvedId }),
          ]);

          // Do NOT throw on allUcResult or memberCountResult error.
          // A silent failure here degrades gracefully: unionClubIds defaults
          // to [resolvedId] (showing only club tables) and member_count defaults
          // to the stale DB row value. A throw here crashes the entire lobby!
          if (!allUcResult.error && allUcResult.data && allUcResult.data.length > 0) {
            unionClubIds = allUcResult.data.map((r) => r.club_id);
          }

          /**
           * ...AND A UNION'S MEMBER COUNT IS EVERY CLUB'S, ADDED UP.
           *
           * Dan 2026-08-24: "how can the union only have 328 players but 551
           * players currently playing. The union total is the total of all
           * members in all clubs = total members in the union, even if the
           * same player is in multiple clubs they get counted twice, 3x etc."
           *
           * This page renders unions as well as clubs — `clubs` carries a row
           * with is_union true whose id IS the union id (Midway Union, club_id
           * 55555). The 2026-08-23 fix above made every page count
           * `resolvedId`'s own members, which is right for a club and wrong
           * for a union: it counted the union's own house-club roster, 328,
           * and published it as the whole union. Less than the 551 people
           * playing in it at the time, which is how Dan spotted it.
           *
           * Summed WITHOUT de-duplication, exactly as specified: a player in
           * two clubs is two memberships. That is also what unions.member_count
           * holds (1,172 here = 584 Club JAQK + 588 Shark), so the header and
           * the union record now agree instead of contradicting each other.
           *
           * The union's own house-club row is not in union_clubs and is
           * therefore not counted — it is the union, not a club inside it, and
           * 327 of its 328 members already hold a membership in one of the two
           * real clubs.
           *
           * Fired as its own await AFTER unionClubIds is known, deliberately
           * not blocking the tables/tournaments queries below.
           */
          if (clubData.is_union && unionClubIds.length > 0) {
            /* SUMMED FROM THE SECURITY DEFINER RPC, not counted off the table.
               A direct count here is RLS-filtered, and the filter does not
               remove a club from the sum - it removes ROWS, so the union total
               silently becomes "members of this union that I personally may
               enumerate". Measured for a real admin of one of the two clubs,
               who can see both rows in union_clubs and therefore reaches this
               block:

                 union header showed ....... 593
                 truth ..................... 1,172   (584 JAQK + 588 Shark)
                 fn_batch_club_member_counts 1,172

               That is the same number Dan caught being wrong on 2026-08-23
               ("less than the 551 people playing in it at the time"). The fix
               then corrected WHICH clubs get counted; it could not have fixed
               this, because the count itself was never the union's - it was
               the viewer's view of it.

               Still summed WITHOUT de-duplication, exactly as specified above:
               the RPC returns one row per club and a player in two clubs is two
               memberships, which is what unions.member_count holds. */
            const { data: perClub, error: perClubErr } = await supabase.rpc(
              'fn_batch_club_realtime_member_counts',
              {
                p_club_ids: unionClubIds,
              }
            );
            // ROUND 9 (2026-08-29): keeping the previous count on a failed
            // read is the right fallback; doing it silently is not. The
            // header quietly showing a stale union total is the exact shape
            // Dan caught on 2026-08-23.
            if (perClubErr) {
              reportError(perClubErr, 'ClubHomePage.union_member_counts_read_failed');
            }
            const unionMembers = Array.isArray(perClub)
              ? perClub.reduce(
                  (sum: number, row: { member_count: number | string }) =>
                    sum + Number(row.member_count ?? 0),
                  0
                )
              : null;
            if (getIsMounted && !getIsMounted()) return;
            if (unionMembers != null && Number.isFinite(unionMembers)) {
              setClub((prev) => (prev ? { ...prev, member_count: unionMembers } : prev));
              // The level badge is derived from clubData further down; keep the
              // two from disagreeing the way the header and the record did.
              clubData.member_count = unionMembers;
            }
          }

          /**
           * A CLUB'S MEMBER COUNT IS ITS OWN (Dan, 2026-08-23).
           *
           * "club jaqk doesn't have 1172 players" - and it does not: it has
           * 584. 1,172 was Club JAQK plus Shark Club, because a union club
           * used to be shown the whole union's membership. Shark then read
           * 1,172 as well, and the two clubs were indistinguishable.
           *
           * It also FLIPPED. Dan: "bounces back and forth from 1172 players to
           * 588." get_club_home answered with one number and this block with
           * the other, and whichever landed last won - the same two-writers,
           * one-rule shape as the lobby scope bug earlier today. There is one
           * rule now, stated in both places: count this club's members.
           *
           * The union-wide re-query that used to sit here was also AWAITED IN
           * SERIES, ahead of the tables and tournaments queries, so the games
           * waited on a number nobody wanted.
           */
          const unionPathCount =
            memberCountResult.data == null ? null : Number(memberCountResult.data);
          if (unionPathCount != null && Number.isFinite(unionPathCount) && !clubData.is_union) {
            if (getIsMounted && !getIsMounted()) return;
            setClub((prev) => (prev ? { ...prev, member_count: unionPathCount } : prev));
          }
        }
      } catch (e) {
        reportError(e, 'ClubHomePage.setClub');
        // Query error — fail-open for standalone clubs
      }

      // ── Fix: Live member count for standalone clubs (not in a union) ──
      // Without this, standalone clubs display the stale clubs.member_count value
      if (!unionId) {
        try {
          const { data: liveCountRaw } = await liveMemberCountPromise;
          // bigint over PostgREST can arrive as a JSON number or a string.
          const liveCount = liveCountRaw == null ? null : Number(liveCountRaw);

          if (liveCount != null && Number.isFinite(liveCount) && liveCount > 0) {
            if (getIsMounted && !getIsMounted()) return;
            setClub((prev) => (prev ? { ...prev, member_count: liveCount } : prev));
            // Also update clubData so the level calculation below uses the live count
            clubData.member_count = liveCount;
          }
        } catch (e) {
          reportError(e, 'ClubHomePage.setClub');
          // Fall back to denormalized clubs.member_count
        }
      }

      // ── Batch: tables + tournaments + BBJ in parallel ──
      // Build table query: use union_id for union clubs, club_id for standalone
      const tableQuery = supabase
        .from('tables')
        .select(
          'id, name, game_variant, stakes, current_players, max_players, status, small_blind, big_blind, min_buy_in, max_buy_in, settings, created_at, run_it_twice, run_it_twice_enabled, allow_run_it_twice, insurance_enabled, straddle_enabled, straddle_type, auto_utg_straddle, bomb_pot_enabled, bomb_pot_frequency, bomb_pot_double_board, bomb_pot_board_count, bomb_pot_trigger_mode, bomb_pot_interval_seconds, bomb_pot_variant, bomb_pot_ante_multiplier, bomb_pot_ante_fixed, ante_enabled, ante, seven_deuce_enabled, seven_deuce_amount, time_bank_enabled, all_in_or_fold, club_id, is_featured, is_vip_only, label_as_new, hide_club_name, cap_enabled, cap_bb, no_rathole, pineapple_holdem, is_anonymous, restrict_observers, nit_game, career_percent_min, maintain_percent_min, maintain_hands'
        );
      // ONE rule, applied. Union clubs see the UNION's tables plus their OWN
      // private games; another club's private game is never visible.
      applyClubScope(tableQuery, {
        clubId: resolvedId,
        unionId,
        siblingClubIds: unionClubIds,
      });
      // P1-1: mirror TableService cash-lobby filters on BOTH branches (chained
      // on the shared builder). Without status/tournament filters and a limit,
      // this pulled tens of thousands of closed/tournament rows and buried the
      // real cash tables. Exclude closed + tournament tables and cap the result.
      tableQuery
        .eq('is_deleted', false)
        /* belongsInTableList (the realtime admission rule above) drops BOTH
           'closed' and 'deleted'. The fetch only dropped 'closed', so a
           status='deleted' row would load on first paint and then be refused
           by realtime - the two lists disagreeing, which is precisely what
           that rule exists to prevent. No such row exists today; this keeps
           it that way. */
        /* THE VALUE IS A POSTGREST GROUP, NOT A JS ARRAY (Dan 2026-08-23).
           `.not(col, 'in', value)` interpolates the value straight into
           `not.in.<value>`, so an array stringifies to `not.in.closed,deleted`
           and PostgREST answers PGRST100 -- "failed to parse filter". A 400
           here is total: the whole cash list comes back null, so EVERY club
           lobby, union or standalone, shows zero tables while dozens are
           running. Measured on production 2026-08-23 from Club JAQK: 400 with
           the array, 200 with 44 tables the moment the filter was rewritten.
           The group form below is what `.in()` builds for itself. */
        .not('status', 'in', '("closed","deleted")')
        .is('tournament_id', null)
        /* A LIVE GAME MUST NEVER BE TRUNCATED AWAY (2026-09-02). See the note
           on TableService.getClubTables: ordering by created_at alone under
           the 200-row cap hid 41 of Deep Stack Society's 51 running tables,
           and this page then ran every filter tab client-side over the
           truncated list, so PLO/NLH/etc each read as an empty club. */
        .order('current_players', { ascending: false })
        .order('created_at', { ascending: false })
        .limit(QUERY_LIMITS.LIST);

      // Union governance (2026-08-19): for union clubs the club-scoped query
      // returns ONLY the club's own PRIVATE tournaments; every union-visible
      // tournament comes from the union-scoped query below. Standalone clubs
      // keep the original club_id scoping.
      const clubTournamentQuery = supabase
        .from('tournaments')
        .select(
          'id, name, game_type, buy_in_amount, buy_in_fee, guaranteed_prize, start_time, status, current_players, max_players, starting_chips, club_id, variant, table_size, late_reg_mins, late_reg_levels, started_at, current_level, blind_structure, level_started_at, spin_multiplier, prize_pool, is_bounty, bounty_amount, is_pko, is_mystery_bounty, is_pinned, is_vip_only, label_as_new, hide_club_name'
        )
        // Joinable-only (Dan 2026-08-15, round 2 of the silent-join fix): the
        // COMPLETED-only exclusion let all 6,669 CANCELLED tournaments
        // through, and this page -- /clubs/:clubId, the one the featured
        // club card opens -- kept serving a cancelled April Sit&Go as a
        // joinable 6/6 card after TournamentService was fixed, because it
        // runs its own query rather than the service. Same rule as the
        // service now: a lobby lists what can be ENTERED.
        .in('status', LOBBY_TOURNAMENT_STATUSES)
        /* THE BOARD IS A WINDOW, AND THE CAP IS NOT A WINDOW (Dan 2026-08-26).
           This query had no time bound at all, so the only thing deciding what
           reached the lobby was `.limit(200)` ordered by start_time ASCENDING
           -- and a RUNNING event's start_time is in the PAST, so it sorts
           FIRST. With 93 running spins on this club the cap was already eating
           into the future card, and publishing 48 hours of MTTs instead of 24
           would have made that the normal state: the fix for "not enough
           events" would have quietly deleted the ones furthest out. Bounding
           the query by the longest window the rules allow (6 days) means the
           cap now only ever trims things nothing was going to show anyway. */
        .lte('start_time', lobbyQueryHorizonIso())
        .order('start_time', { ascending: true })
        /* The tables query has been capped since P1-1; these two were not
           capped at all. An unbounded list query is the shape that pulled
           tens of thousands of rows into this page once already. */
        .limit(QUERY_LIMITS.MODERATE);
      // THE SAME rule, THE SAME shape as the cash-table query above.
      //
      // This used to be two queries: one for the club's own private games and
      // a second, conditional one for the union's. That asymmetry is how both
      // of this lobby's scope bugs hid - the tournament path simply looked
      // different enough from the table path that a fix to one did not
      // obviously apply to the other, and on 2026-08-23 the union branch was
      // found missing from the tournament side of get_club_home while the
      // table side had been fixed. One query now, one rule, one shape.
      applyClubScope(clubTournamentQuery, {
        clubId: resolvedId,
        unionId,
        siblingClubIds: unionClubIds,
      });

      const [tableResult, clubTournamentResult, bbjResult] = await Promise.all([
        tableQuery,
        clubTournamentQuery,
        (async () => {
          try {
            // BUGFIX: resolve the CORRECT BBJ pool. Union clubs contribute to the
            // UNION pool (that's the one that grows); a club-level pool row may exist
            // but is stale. Fetch by union_id when in a union, else club_id.
            const q = supabase.from('bbj_pools').select('id, main_balance');
            if (unionId) {
              return await q.eq('union_id', unionId).eq('status', 'active').limit(1).maybeSingle();
            } else {
              return await q
                .eq('club_id', resolvedId)
                .eq('status', 'active')
                .limit(1)
                .maybeSingle();
            }
          } catch (e) {
            reportError(e, 'ClubHomePage.async');
            return { data: null, error: null };
          }
        })(),
        // The separate union tournament query is GONE: applyClubScope above
        // already returns union-owned games and this club's private ones in a
        // single round trip. Two queries meant two failure modes, and the one
        // that mattered - the union query timing out - emptied every
        // tournament tab while the club query quietly succeeded with nothing.
      ]);

      if (getIsMounted && !getIsMounted()) return;

      // From here the authoritative data is in hand; the fast path above must
      // not paint after this point (it would replace fresher rows with the
      // snapshot it fetched a moment earlier).
      lobbyPainted = true;

      const tableData = tableResult.data;
      /* Keep the last good list when the query fails rather than blanking the
         lobby -- but SAY SO. The malformed filter above 400'd on every load
         for hours and nothing anywhere reported it, because a swallowed error
         and an empty club look identical on screen. */
      if (tableResult.error) {
        reportError(tableResult.error, 'ClubHomePage.tablesQueryFailed');
      } else if (tableData) {
        setTables(tableData);
      }
      const tableCapped = (tableData?.length ?? 0) >= QUERY_LIMITS.LIST;

      // SWR: cache club + tables for instant display on revisit
      if (clubId && clubData) {
        setClubHomeCache(clubId, { club: clubData, tables: tableData || [] });
      }
      hasDataRef.current = true;

      // Merge club tournaments + XMTT tournaments (now just club tournaments due to scope rule)
      if (clubTournamentResult.error)
        reportError(clubTournamentResult.error, 'ClubHomePage.Club_tournaments_failed');

      if (!clubTournamentResult.error) {
        const allTournaments: TournamentData[] = clubTournamentResult.data
          ? [...clubTournamentResult.data]
          : [];

        /**
         * AN EMPTY ANSWER NEVER ERASES A FULL ONE.
         *
         * Two writers fill this list: the get_club_home fast path, which is
         * union-scoped in SQL and cannot get the scope wrong, and this chain,
         * whose scope depends on `unionId` resolving from a separate read.
         * When that read comes back empty the chain narrows to the club's own
         * PRIVATE tournaments -- of which a union club has none -- and then
         * overwrites a good list with zero.
         *
         * Measured live 2026-08-24: get_club_home returned 161 tournaments and
         * the lobby showed none, with "44 Games Are Open In This Club"
         * underneath, 44 being the table count on its own.
         *
         * So the chain may replace this list with anything it actually found,
         * and may not replace it with nothing. A genuinely empty club paints
         * empty from the fast path, which had the same answer; the only case
         * this changes is where the two disagree and one is a degraded read.
         */
        /* The chain has answered with real rows. From here the fast path has
           nothing to add and could only narrow them (see listsPaintedRef). */
        listsPaintedRef.current = true;
        if (allTournaments.length > 0) {
          setTournaments(allTournaments);
        } else {
          setTournaments((prev) => {
            if (prev.length > 0) {
              reportError(
                new Error(
                  `[ClubHomePage] chain found 0 tournaments while ${prev.length} were painted - keeping them (unionId=${unionId ?? 'null'})`
                ),
                'ClubHomePage.emptyTournamentOverwrite'
              );
              return prev;
            }
            return allTournaments;
          });
        }
      }
      setCountsCapped(tableCapped || (clubTournamentResult.data?.length ?? 0) >= QUERY_LIMITS.LIST);

      // BBJ jackpot. Number() is load-bearing, not cosmetic: main_balance is
      // numeric(14,2) and arrives as the STRING "10500.67". Assigning it raw
      // put a string into a number-typed state, which then failed BBJTicker's
      // `typeof poolAmount === 'number'` ownership check and left the ticker
      // and the page disagreeing about who owns the value.
      if (bbjResult?.data && !(bbjResult as any).error) {
        if (Array.isArray(bbjResult.data)) {
          let sum = 0;
          let unionPoolId = null;
          for (const row of bbjResult.data) {
            const bal = Number(row.main_balance);
            if (Number.isFinite(bal)) sum += bal;
            // Prefer the first pool ID we find (or we could specifically find the union's)
            if (!unionPoolId) unionPoolId = row.id;
          }
          setJackpotAmount(sum);
          setBbjPoolId(unionPoolId);
        } else {
          const initial = Number((bbjResult.data as any)?.main_balance);
          setJackpotAmount(Number.isFinite(initial) ? initial : 0);
          setBbjPoolId((bbjResult.data as any)?.id || null);
        }
      }

      /* An `activeTables` count was computed here on every load and passed to
         nothing - the club level below is derived server-side from the
         hierarchy thresholds on the club row. */

      // Club Level Is A Pure Member-Count Fact. Never call the legacy dual-axis
      // recompute here: that formula can level up a one-member club from its
      // owner/admin hierarchy and produce a false celebration.
      const levelInfo = getClubLevelInfoFromMembers(clubData.member_count || 0);
      if (getIsMounted && !getIsMounted()) return;

      /* Level-up celebration, decided OUTSIDE the updater.
         A state updater must be pure. React 19 double-invokes updaters in
         StrictMode and may replay them on a discarded render, so the toast
         and the haptic fired twice - and the celebration is also exactly the
         kind of side effect that must not depend on how many times React
         chooses to call a reducer. `clubLevelRef` holds the last COMMITTED
         level, which is the honest thing to compare against.
         Title Case and no em dash, per the popup rule. */
      const previousLevel = clubLevelRef.current;
      if (previousLevel && previousLevel.level > 0 && levelInfo.level > previousLevel.level) {
        toast.success(`Level Up: Your Club Reached Lv.${levelInfo.level}, ${levelInfo.tierLabel}`);
        haptic.success();
      }
      setClubLevel(levelInfo);
    } catch (error: any) {
      reportError(error, 'ClubHomePage.Error_loading_club_data');
      /* error.message on a PostgREST failure is text like "JSON object
         requested, multiple (or no) rows returned" - Title-Cased by the toast
         layer and shown to a player. The raw text is on the reportError above,
         which is where it is useful. */
      toast.error('Failed to load club data');
    } finally {
      loadingRef.current = false;
      if (!getIsMounted || getIsMounted()) setLoading(false);
    }
  };

  // Which halves of the lobby the chosen type can produce. Derived once so the
  // filters, the status row and the empty state cannot disagree about it.
  const showsCash = gameType === 'ALL' || CASH_TYPES.includes(gameType);
  const showsTournaments = gameType === 'ALL' || TOURNAMENT_TYPES.includes(gameType);
  const showTournaments = TOURNAMENT_TYPES.includes(gameType);

  const filteredTables = useMemo(() => {
    if (!showsCash) return [];

    /* Advanced Filters apply to the tab they were saved on. On ALL there is no
       single tab to read, so they do not apply - ALL means "show me
       everything", and quietly narrowing it would make the tab a lie. */
    const advType = gameType === 'ALL' ? null : (gameType as FilterGameType);
    const advSpec = advType && advType !== 'ALL' ? FILTER_SPECS[advType] : undefined;
    const advValue = advType ? advFilters[advType] : undefined;

    const rows = tables.filter((table) => {
      if (gameType !== 'ALL' && cashKind(table) !== gameType) return false;

      if (gameType === 'ALL' && allStatusFilter !== 'ALL') {
        const status = String(table.status).toUpperCase();
        if (allStatusFilter !== 'RUNNING' || !['RUNNING', 'IN_PROGRESS'].includes(status)) {
          return false;
        }
      }

      if (advSpec && advValue) {
        /* ONE decision function for both halves of the lobby - see
           rowPassesFilter. Applying the fields inline here is what let games,
           format and statuses drift into being collected-but-ignored. */
        const settings =
          typeof table.settings === 'string'
            ? (() => {
                try {
                  return JSON.parse(table.settings) as Record<string, unknown>;
                } catch {
                  return {};
                }
              })()
            : ((table.settings as unknown as Record<string, unknown> | undefined) ?? {});
        if (
          !rowPassesFilter(advSpec, advValue, {
            variant: table.game_variant,
            price: Number(table.big_blind) || 0,
            seats: Number(table.max_players) || 0,
            seatsTaken: Number(table.current_players) || 0,
            name: table.name,
            row: table as unknown as Record<string, unknown>,
            settings,
          })
        ) {
          return false;
        }
      }

      return true;
    });

    const bb = (t: TableData) => Number(t.big_blind) || 0;
    const cmpStakes = (a: TableData, b: TableData) => bb(b) - bb(a);
    const cmpStakesLow = (a: TableData, b: TableData) => bb(a) - bb(b);
    const cmpPlayers = (a: TableData, b: TableData) =>
      (b.current_players || 0) - (a.current_players || 0);
    const cmpName = (a: TableData, b: TableData) => (a.name || '').localeCompare(b.name || '');
    /* Dan 2026-08-25: "GAMES NEED TO BE ORGANIZED BY TYPE ... SHOW ALL PLO 4
       CARDS GAMES AND STAKES, THEN BELOW IT PLO5, THEN PLO6 THEN PLO8."

       The tab was one undifferentiated list: a PLO6 5/10 sat between a PLO4
       2/4 and a PLO4 10/25, so a player who only plays four-card had to read
       every row to find their game. Variant leads every comparator now, and
       the chosen sort orders the stakes WITHIN each variant — which is what
       "and stakes" asks for. Keyed off the same variantKey the Omaha filter
       chips use, so the group a table lands in and the chip that hides it can
       never disagree.

       Only Omaha is grouped: the other tabs are a single variant, where a
       leading variant term is a comparator that always returns 0. */
    const cmpVariant = (a: TableData, b: TableData) =>
      gameType === 'OMAHA'
        ? (VARIANT_GROUP_ORDER[variantKey(a.game_variant)] ?? 99) -
          (VARIANT_GROUP_ORDER[variantKey(b.game_variant)] ?? 99)
        : 0;

    switch (sortKey) {
      case 'stakes_high':
        return rows.sort(
          (a, b) => cmpVariant(a, b) || cmpStakes(a, b) || cmpPlayers(a, b) || cmpName(a, b)
        );
      case 'stakes_low':
        return rows.sort(
          (a, b) => cmpVariant(a, b) || cmpStakesLow(a, b) || cmpPlayers(a, b) || cmpName(a, b)
        );
      case 'players':
      case 'starting_soon':
        return rows.sort(
          (a, b) => cmpVariant(a, b) || cmpPlayers(a, b) || cmpStakes(a, b) || cmpName(a, b)
        );
      case 'recommended':
      default:
        return rows.sort(
          (a, b) => cmpVariant(a, b) || cmpStakes(a, b) || cmpPlayers(a, b) || cmpName(a, b)
        );
    }
  }, [tables, gameType, showsCash, sortKey, advFilters, allStatusFilter]);

  /**
   * Is the lobby showing less than everything, and why.
   *
   * Three independent things narrow this list: the game-type tab, the search
   * box, and the saved Advanced Filters for that tab. The empty state already
   * had to work this out to explain itself; the result count needs exactly the
   * same answer, so it is computed once here rather than twice in the markup.
   */
  const narrowing = useMemo(() => {
    const fSpec = FILTER_SPECS[gameType as Exclude<FilterGameType, 'ALL'>];
    const fVal = advFilters[gameType as FilterGameType];
    const allStatusFiltered = gameType === 'ALL' && allStatusFilter !== 'ALL';
    const filtered = allStatusFiltered || Boolean(fSpec && fVal && isFilterActive(fSpec, fVal));
    return {
      fSpec,
      filtered,
      tabbed: gameType !== 'ALL',
      any: filtered || gameType !== 'ALL' || favoritesOnly,
    };
  }, [gameType, advFilters, favoritesOnly, allStatusFilter]);

  /**
   * Clear EVERY narrowing at once.
   *
   * Undoing them one at a time means guessing which one was responsible, and
   * the saved Advanced Filters are not visible from the lobby at all. Shared
   * by the result count and the empty state so the two cannot drift into
   * clearing different things.
   */
  const clearAllNarrowing = useCallback(() => {
    haptic.selection();
    /* CLEARING IS A CHOICE TOO, so it persists like every other one. Clearing
       through the in-memory setters alone would have put the board back to
       ALL and then restored the old tab and Favorites state on the next
       visit, which reads as the button not having worked. */
    selectFavoritesOnly(false);
    selectGameType('ALL');
    setAllStatusFilter('ALL');
    if (narrowing.fSpec) {
      const next: FilterStore = {
        ...advFilters,
        [gameType]: emptyFilterValue(narrowing.fSpec),
      };
      setAdvFilters(next);
      if (resolvedClubId) saveFilters(resolvedClubId, next);
    }
  }, [narrowing.fSpec, advFilters, gameType, resolvedClubId, selectFavoritesOnly, selectGameType]);

  /**
   * ═══════════════════════════════════════════════════════════════════════════
   *  A SAVED FILTER MAY NEVER EMPTY A LOBBY THAT HAS GAMES (2026-08-28)
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * Dan: "every single time i try to sit down at a spin, EVERY SINGLE ONE
   * disappears from the spins lobby. and you can't sit or register for one."
   *
   * Reproduced on this club: the SPINS tab rendered "Nothing Matches Your
   * Filters - 46 Games Are Open In This Club, But The Filters On This Tab
   * Hide Them All" over a board that had forty-odd joinable spins on it. The
   * filters were real and saved (`ca_advanced_filters_<club>` carried
   * statuses and buy-in bands for SPIN), and `saveFilters` persists them
   * per club per tab — so once a combination that matches nothing is stored,
   * EVERY later visit to that tab opens empty. Nothing about it says
   * "filter"; it just looks like the spins are gone, forever, which is
   * exactly the report.
   *
   * The empty state does offer "Show All Games", and that is the right
   * control to keep — but a remedy the player has to notice is not a fix for
   * a lobby that lies about being empty. A filter set that hides EVERY game
   * is not a preference, it is a dead end, so it is dropped automatically and
   * announced. One shot per tab per club: the guard ref stops this fighting a
   * player who is deliberately narrowing toward zero in the filter sheet,
   * because a deliberate narrowing they can see and undo is not a dead end.
   *
   * Deliberately narrow — it fires only when the tab's own filters are what
   * emptied it (`narrowing.filtered`), never for a genuinely empty club and
   * never for the tab or Favorites, which are one visible tap to undo.
   */
  const autoUnfilteredRef = useRef<string | null>(null);

  const filteredTournaments = useMemo(() => {
    if (!showsTournaments) return [];

    const variant: TournVariant = TOURN_VARIANT_FOR[gameType] ?? 'ALL';
    const advType = gameType === 'ALL' ? null : (gameType as FilterGameType);
    const advSpec = advType && advType !== 'ALL' ? FILTER_SPECS[advType] : undefined;
    const advValue = advType ? advFilters[advType] : undefined;

    const stillEnterable = (t: TournamentData) => {
      const status = String(t.status).toUpperCase();
      if (['REGISTERING', 'LATE_REG', 'LATE_REGISTRATION', 'STARTING_SOON'].includes(status))
        return true;
      if (status === 'RUNNING') {
        const levels = Number(t.late_reg_levels ?? 0);
        // 0-BASED (2026-08-23): current_level indexes blind_structure, so
        // "through level N" is indices 0..N-1 and N is the cutoff. `<=` kept
        // a closed tournament listed as enterable for one whole level after
        // the engine finalized its prize pool, so the lobby offered a seat the
        // RPC would refuse. Matches TournamentManagerBase.isLateRegClosed.
        if (levels > 0) return Number(t.current_level ?? 0) < levels;
        const mins = Number(t.late_reg_mins ?? 0);
        if (mins > 0 && t.started_at) {
          return Date.now() - new Date(t.started_at).getTime() <= mins * 60_000;
        }
      }
      return false;
    };

    /* Dan 2026-08-24: "WHEN A TOURNAMENT MOVES PAST THE REBUY/ADD-ON PHASE IT
       ENTERS RUNNING, WHERE IT SHOULD STILL DISPLAY AT THE BOTTOM OF THE MTT
       PAGE AS EVENTS THAT ARE RUNNING, WHERE PEOPLE CAN CLICK AND WATCH AND
       SEE THE EVENTS FINISH UP."

       The list used to drop a tournament the instant late registration closed,
       so a club's biggest event of the night vanished from its own lobby at
       the exact moment it got interesting. Being enterable and being worth
       showing are two different questions: this one decides what is LISTED,
       stillEnterable() above still decides what can be JOINED, and the card's
       buttons read that to offer Watch instead of Register.

       They sort to the bottom on their own — compareTournaments already ranks
       RUNNING below anything still open. */
    const isListable = (t: TournamentData) => {
      const status = String(t.status).toUpperCase();
      return [
        'REGISTERING',
        'LATE_REG',
        'LATE_REGISTRATION',
        'STARTING_SOON',
        'RUNNING',
        'IN_PROGRESS',
      ].includes(status);
    };

    const windowNow = Date.now();

    const rows = tournaments.filter((t) => {
      if (!isListable(t)) return false;
      /* 48 HOURS OF CARD, 6 DAYS FOR THE BIG ONES (Dan 2026-08-26). See
         src/utils/tournamentScheduleWindow.ts for the rule and why the server
         spawner had to move first. Anything already under way passes for free
         -- its start time is in the past. */
      if (!isWithinLobbyWindow(t, windowNow)) return false;
      if (!matchesVariant(t, variant)) return false;

      if (gameType === 'ALL' && allStatusFilter !== 'ALL') {
        const status = String(t.status).toUpperCase();
        const matchesAllStatus =
          (allStatusFilter === 'RUNNING' && ['RUNNING', 'IN_PROGRESS'].includes(status)) ||
          (allStatusFilter === 'OPEN_REGISTRATION' && status === 'REGISTERING') ||
          (allStatusFilter === 'LATE_REG' && ['LATE_REG', 'LATE_REGISTRATION'].includes(status)) ||
          (allStatusFilter === 'STARTING_SOON' && status === 'STARTING_SOON');
        if (!matchesAllStatus) return false;
      }

      if (advSpec && advValue) {
        // The tournament price is the TOTAL a player pays, not the prize half.
        const total = (Number(t.buy_in_amount) || 0) + (Number(t.buy_in_fee) || 0);
        if (
          !rowPassesFilter(advSpec, advValue, {
            variant: t.game_type,
            price: total,
            seats: Number(t.max_players) || 0,
            // The "Table Size" slider filters on seats at a TABLE, not on the
            // size of the field. Null when the row does not carry it, which
            // skips the range rather than measuring an MTT against 2-9.
            tableSeats: (t as unknown as { table_size?: number | null }).table_size ?? null,
            seatsTaken: Number(t.current_players) || 0,
            status: t.status,
            name: t.name,
            row: t as unknown as Record<string, unknown>,
            settings: {},
          })
        ) {
          return false;
        }
      }

      return true;
    });

    const buyIn = (t: TournamentData) =>
      (Number(t.buy_in_amount) || 0) + (Number(t.buy_in_fee) || 0);
    const cmpBuyIn = (a: TournamentData, b: TournamentData) => buyIn(b) - buyIn(a);
    const cmpBuyInLow = (a: TournamentData, b: TournamentData) => buyIn(a) - buyIn(b);
    const cmpPlayersTourn = (a: TournamentData, b: TournamentData) =>
      (b.current_players || 0) - (a.current_players || 0);
    const cmpNameTourn = (a: TournamentData, b: TournamentData) =>
      (a.name || '').localeCompare(b.name || '');

    switch (sortKey) {
      case 'stakes_high':
        return rows.sort((a, b) => cmpBuyIn(a, b) || cmpPlayersTourn(a, b) || cmpNameTourn(a, b));
      case 'stakes_low':
        return rows.sort(
          (a, b) => cmpBuyInLow(a, b) || cmpPlayersTourn(a, b) || cmpNameTourn(a, b)
        );
      case 'players':
        return rows.sort((a, b) => cmpPlayersTourn(a, b) || cmpBuyIn(a, b) || cmpNameTourn(a, b));
      case 'starting_soon': {
        const at = (t: TournamentData) => {
          const ms = new Date(t.start_time).getTime();
          return Number.isFinite(ms) ? ms : Number.MAX_SAFE_INTEGER;
        };
        return rows.sort((a, b) => {
          const ea = stillEnterable(a) ? 0 : 1;
          const eb = stillEnterable(b) ? 0 : 1;
          if (ea !== eb) return ea - eb;
          return at(a) - at(b) || cmpBuyIn(a, b) || cmpPlayersTourn(a, b) || cmpNameTourn(a, b);
        });
      }
      case 'recommended':
      default:
        return rows.sort(
          (a, b) =>
            tournamentOpenFirst(a, b) ||
            cmpBuyIn(a, b) ||
            cmpPlayersTourn(a, b) ||
            cmpNameTourn(a, b)
        );
    }
  }, [tournaments, gameType, showsTournaments, sortKey, advFilters, allStatusFilter]);

  /**
   * Tables this player already holds an active place in the queue for.
   *
   * Loaded once per club visit rather than per card: a lobby renders up to
   * ~170 cards, and asking each one whether it is waitlisted would be ~170
   * round trips to answer a question one query answers for all of them.
   */
  const [waitlistedTableIds, setWaitlistedTableIds] = useState<Set<string>>(new Set());
  const [waitlistActionBusy, setWaitlistActionBusy] = useState(false);
  const waitlistActionBusyRef = useRef(false);

  useEffect(() => {
    if (!currentUserId) {
      setWaitlistedTableIds(new Set());
      return;
    }
    let cancelled = false;
    const load = () => {
      waitlistService
        .myWaitlists()
        .then((rows) => {
          if (!cancelled) setWaitlistedTableIds(new Set(rows.map((r) => r.tableId)));
        })
        .catch((e) => reportError(e, 'ClubHomePage.loadMyWaitlists'));
    };

    load();

    const unsub = masterBus.subscribeDebounced('WAITLIST_CHANGED', load, 300);

    // Re-query when tab regains focus — a player seated from the waitlist while
    // browsing another tab sees stale badges until they switch back. This clears
    // them the moment the page becomes visible again.
    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible') load();
    };
    document.addEventListener('visibilitychange', onVisibilityChange);

    return () => {
      cancelled = true;
      unsub();
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, [currentUserId]);

  const handleWaitlistToggle = useCallback(
    async (tableId: string, joining: boolean) => {
      if (waitlistActionBusyRef.current) return;
      if (!currentUserId) {
        toast.error('Sign In To Join A Waitlist');
        return;
      }
      waitlistActionBusyRef.current = true;
      setWaitlistActionBusy(true);
      haptic.selection();
      /* Optimistic, then reconciled. The button is on a card in a long grid
         and the round trip is not instant; leaving it unchanged until the
         server answers reads as a dead tap and invites a second one, which
         would toggle it straight back. */
      setWaitlistedTableIds((prev) => {
        const next = new Set(prev);
        if (joining) next.add(tableId);
        else next.delete(tableId);
        return next;
      });

      try {
        if (joining) {
          const entry = await waitlistService.joinWaitlist(tableId);
          if (!entry) throw new Error('Could not join the waitlist');
          const pos = await waitlistService.getPosition(tableId);
          toast.success(
            pos && pos.position > 0
              ? `Added To The Waitlist. You Are Number ${pos.position} In Line.`
              : 'Added To The Waitlist.'
          );
        } else {
          const left = await waitlistService.leave(tableId);
          if (!left) throw new Error('Could not leave the waitlist');
          toast.success('Removed From The Waitlist.');
        }
      } catch (e) {
        // Put the button back where it was; the queue did not change.
        setWaitlistedTableIds((prev) => {
          const next = new Set(prev);
          if (joining) next.delete(tableId);
          else next.add(tableId);
          return next;
        });
        reportError(e, 'ClubHomePage.handleWaitlistToggle', { tableId, joining });
        toast.error(joining ? 'Could Not Join The Waitlist' : 'Could Not Leave The Waitlist');
      } finally {
        waitlistActionBusyRef.current = false;
        setWaitlistActionBusy(false);
      }
    },
    [currentUserId, toast]
  );

  // ═══════════════════════════════════════════════════════════════════════
  // LOBBY V2 — player relationship to games (seated / registered / favorite)
  // plus row selection + the game lobby panel.
  // ═══════════════════════════════════════════════════════════════════════
  /* True when a list query came back exactly full, i.e. the cap may have cut
     it. The lobby then reports its total as a floor ("200+ Games") instead of
     an exact number it cannot know. Counting for real would cost two extra
     round trips on every club load to answer a question that, at today's
     ceiling of 42 live tables in any club, nobody is asking. */
  const [countsCapped, setCountsCapped] = useState(false);
  const [seatedTableIds, setSeatedTableIds] = useState<Set<string>>(new Set());
  const [registeredTournamentIds, setRegisteredTournamentIds] = useState<Set<string>>(new Set());
  const [favoriteTableIds, setFavoriteTableIds] = useState<Set<string>>(new Set());
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [panelOpen, setPanelOpen] = useState(false);

  /* ── Selected game in the URL (?game=<id>) ──────────────────────────────
     A refresh or a shared link reopens the same game lobby. replace:true
     keeps history clean, so the back button still leaves the page rather
     than stepping through every row the player looked at. The MultiTablePage
     embed passes clubIdOverride and must never rewrite its host URL. */
  const [searchParams, setSearchParams] = useSearchParams();
  const urlSyncEnabled = !clubIdOverride;
  // Captured at first render, before the sync effect below can strip it.
  const pendingGameRef = useRef<string | null>(searchParams.get('game'));

  useEffect(() => {
    if (!urlSyncEnabled) return;
    setSearchParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        if (panelOpen && selectedId) next.set('game', selectedId);
        else next.delete('game');
        return next;
      },
      { replace: true }
    );
  }, [urlSyncEnabled, panelOpen, selectedId, setSearchParams]);
  const [actionBusy, setActionBusy] = useState(false);

  /* CANCELLABLE, AND BOUNDED.
     Three unlimited, unscoped reads with no cancellation: every seat, every
     registration and every favourite the player has ever held ANYWHERE on the
     platform, and a slow response landing after a club switch or an unmount
     wrote the previous club's seat set over the current screen - which is
     what marks a row "Return To Table" on a table the player is not at. The
     token below is the same shape used by the loaders above, and the row
     limit is the one every other list query here already uses. */
  const gameStatesTokenRef = useRef(0);
  const loadMyGameStates = useCallback(async () => {
    const token = ++gameStatesTokenRef.current;
    if (!currentUserId) {
      setSeatedTableIds(new Set());
      setRegisteredTournamentIds(new Set());
      setFavoriteTableIds(new Set());
      return;
    }
    try {
      const [seatsRes, regsRes, favsRes] = await Promise.all([
        supabase
          /* The TOURNAMENT id comes back with the table id (2026-08-28 audit).
             A Spin or Heads-Up row in this lobby is keyed by its TOURNAMENT
             id, so `seatedIds.has(entry.id)` — which playerStateOf checks
             first, precisely so a bought seat reads "You Are Seated" — could
             never match: this set held only table ids. Every seat-first
             holder fell through to the registeredIds branch and was told
             "You Are Registered", the same softer word as "Spectating" that
             Dan rejected on the table itself. Verified against production
             the same day: 41 of 41 live seat-first seats carry a
             tournament_players row, which is why the wrong label was the
             only symptom and nobody lost a seat over it. Putting both ids in
             the set makes the seated branch reachable for seat-first games
             and changes nothing for cash rows, which still key on table_id. */
          .from('table_seats')
          .select('table_id, tables(tournament_id)')
          .eq('user_id', currentUserId)
          .is('left_at', null)
          .limit(QUERY_LIMITS.LIST),
        supabase
          .from('tournament_players')
          .select('tournament_id')
          .eq('user_id', currentUserId)
          .in('status', ['registered', 'playing'])
          .limit(QUERY_LIMITS.LIST),
        supabase
          .from('favorite_tables')
          .select('table_id')
          .eq('user_id', currentUserId)
          .limit(QUERY_LIMITS.LIST),
      ]);
      if (token !== gameStatesTokenRef.current || !isMountedRef.current) return;
      /* ITEM E audit, 2026-08-26 — a failed read is not an empty answer.
         Supabase resolves `{ data: null, error }` on a query-level failure, so
         `data || []` turned "we could not find out" into "you are in
         nothing": the panel then offered Register / Join Table to a player
         who already holds the seat — a false negative on the buy-in surface,
         which is the expensive direction. Each set updates only from a read
         that actually worked; on failure the previous set stands (stale beats
         wrong-empty). */
      if (seatsRes.error) {
        reportError(seatsRes.error, 'ClubHomePage.loadMyGameStates.seats');
      } else {
        setSeatedTableIds(
          new Set(
            (seatsRes.data || []).flatMap((r: any) => {
              const tournamentId = Array.isArray(r.tables)
                ? r.tables[0]?.tournament_id
                : r.tables?.tournament_id;
              return tournamentId ? [r.table_id, tournamentId] : [r.table_id];
            })
          )
        );
      }
      if (regsRes.error) {
        reportError(regsRes.error, 'ClubHomePage.loadMyGameStates.registrations');
      } else {
        setRegisteredTournamentIds(new Set((regsRes.data || []).map((r) => r.tournament_id)));
      }
      if (favsRes.error) {
        reportError(favsRes.error, 'ClubHomePage.loadMyGameStates.favorites');
      } else {
        setFavoriteTableIds(new Set((favsRes.data || []).map((r) => r.table_id)));
      }
    } catch (e) {
      reportError(e, 'ClubHomePage.loadMyGameStates');
    }
  }, [currentUserId, isMountedRef]);

  useEffect(() => {
    loadMyGameStates();
    return () => {
      // Invalidate any in-flight read: its answer belongs to the club we are
      // leaving, not the one we are arriving at.
      // eslint-disable-next-line react-hooks/exhaustive-deps
      gameStatesTokenRef.current++;
    };
  }, [loadMyGameStates]);

  // Keep the seated / registered chips live: these events already fire on the
  // bus for the balance reload; they also change my relationship to the rows.
  useEffect(() => {
    const unsubs = [
      masterBus.subscribeDebounced('TABLE_SEATED', loadMyGameStates, 300),
      masterBus.subscribeDebounced('TABLE_LEFT', loadMyGameStates, 300),
      masterBus.subscribeDebounced('TOURNAMENT_REGISTERED', loadMyGameStates, 300),
      masterBus.subscribeDebounced('TOURNAMENT_UPDATED', loadMyGameStates, 300),
    ];
    return () => unsubs.forEach((u) => u());
  }, [loadMyGameStates]);

  /** Star / unstar a cash table. Reuses the favorite_tables infrastructure. */
  const handleToggleFavorite = useCallback(
    async (tableId: string, next: boolean) => {
      if (!currentUserId) {
        toast.error('Sign In To Save Favorites');
        return;
      }
      haptic.selection();
      setFavoriteTableIds((prev) => {
        const s = new Set(prev);
        if (next) s.add(tableId);
        else s.delete(tableId);
        return s;
      });
      try {
        if (next) {
          const { error } = await supabase
            .from('favorite_tables')
            .insert({ user_id: currentUserId, table_id: tableId });
          if (error) throw error;
        } else {
          const { error } = await supabase
            .from('favorite_tables')
            .delete()
            .eq('user_id', currentUserId)
            .eq('table_id', tableId);
          if (error) throw error;
        }
      } catch (e) {
        // Roll back the optimistic star; the row did not change.
        setFavoriteTableIds((prev) => {
          const s = new Set(prev);
          if (next) s.delete(tableId);
          else s.add(tableId);
          return s;
        });
        reportError(e, 'ClubHomePage.handleToggleFavorite', { tableId, next });
        toast.error(next ? 'Could Not Save Favorite' : 'Could Not Remove Favorite');
      }
    },
    [currentUserId, toast]
  );

  /** Row selection — opens the game lobby panel. NEVER joins or spends. */
  /**
   * THE single route into a tournament lobby. Dan 2026-08-25:
   * "when you click any of the MTT fields in the display inside of ALL or MTT,
   *  it should open to the tournament lobby."
   *
   * It used to be gated on status, so a RUNNING / LATE-REG / COMPLETED event
   * opened the lobby while a REGISTERING one opened the pre-commit drawer
   * instead. Same row, same tab, two different destinations depending on a
   * status the player cannot see — which is why it read as broken.
   *
   * The pathname guard makes this idempotent: LobbyTable fires onSelect on
   * click AND onActivate on double click, both wired here, so without it a
   * double tap pushes two identical history entries and Back appears dead.
   */
  const openTournamentLobby = useCallback(
    (tournamentId: string) => {
      const target = `/tournaments/${tournamentId}`;
      if (window.location.pathname.endsWith(target)) return;
      navigate(target);
    },
    [navigate]
  );

  const openEntry = useCallback(
    (entry: LobbyEntry) => {
      haptic.selection();
      // Kind alone decides, never status. Cash, Spin and Sit & Go keep the
      // pre-commit drawer: their buy-in is chosen there.
      if (entry.kind === 'mtt') {
        openTournamentLobby(entry.id);
        return;
      }
      setSelectedId(entry.id);
      setPanelOpen(true);
      // Perf pass 2026-08-24: opening the game lobby panel is the strongest
      // join signal there is — start downloading the TablePage chunk NOW so
      // the actual "Join" tap resolves from the module cache instead of
      // stalling on a network fetch. No-op when idle preload already ran.
      preloadRoute(`/table/${entry.id}`);
    },
    [openTournamentLobby]
  );

  /**
   * ── THE ROW MEMO WAS NEVER FIRING (2026-08-25) ──────────────────────────
   *
   * LobbyRow is memoised, and the comment above it says memoising "only pays
   * if the PROPS are stable, which is why `ctx` is now a useMemo in
   * ClubHomePage". It was a useMemo, and it still changed on every realtime
   * tick — because it depended on `filteredTournaments`, and on
   * `handleJoinTable`, which depended on `tables`. Both get a new array
   * identity whenever any seat count moves, so a single seat changing on one
   * table repainted all 111 rows: exactly the defect the memo was added to
   * stop.
   *
   * These two refs hold the moving lists so the callbacks that read them can
   * have empty-ish dependency arrays. A ref is right here and a state is not:
   * nothing renders from these, they are only read inside an event handler
   * that fires long after the render that set them.
   */
  const tablesRef = useRef<TableData[]>(tables);
  useEffect(() => {
    tablesRef.current = tables;
  }, [tables]);

  const handleJoinTable = useCallback(
    (tableId: string) => {
      haptic.medium();
      setPanelOpen(false);
      // Execute navigate in the next tick to ensure the panel unmounts safely
      // without interrupting React Router transition internals
      setTimeout(() => {
        const entry = tablesRef.current.find((t) => t.id === tableId);
        navigate(`/table/${tableId}`, {
          state: {
            initialTableState: entry
              ? {
                  tableId: entry.id,
                  tableName: entry.name || 'Loading...',
                  gameType: entry.game_variant || 'NLH',
                  maxPlayers: entry.max_players || 6,
                  currentPlayers: entry.current_players || 0,
                  buyInAmount: entry.small_blind,
                  buyInFee: entry.big_blind,
                }
              : undefined,
          },
        });
      }, 0);
    },
    [navigate]
  );

  const handleRegister = useCallback(
    (t: LobbyTournamentRow) => {
      /* THE LAST DOOR A SEAT-FIRST GAME COULD SNEAK THROUGH (Dan 2026-08-28).
         A Spin or Heads-Up must never reach the Sign Up dialog: it charges
         the buy-in with no seat attached, and Dan's binding rule is the seat
         IS the entry ("A PLAYER SITS DOWN AT A TABLE AND BUYS INTO THE SPIN
         OR HEADS UP, LIKE A CASH GAME"). Every surface routes these through
         spinQuickJoin now, but register paths have re-grown before — this
         gate makes the wrong wiring land on the right flow instead of on a
         charge. Same definition as fn_take_seat_and_buy_in: variant spin,
         or a 2-seat sng. */
      const variantWord = String((t as { variant?: unknown }).variant ?? '').toLowerCase();
      const seatFirst =
        variantWord === 'spin' ||
        (variantWord === 'sng' && Number(t.max_players) > 0 && Number(t.max_players) <= 2);
      if (seatFirst) {
        spinQuickJoin(
          { id: t.id, name: t.name, buy_in_amount: Number(t.buy_in_amount) || 0 },
          variantWord === 'sng' ? 'sng' : 'spin'
        );
        return;
      }
      registerMtt(
        {
          id: t.id,
          name: t.name,
          buy_in_amount: t.buy_in_amount,
          buy_in_fee: t.buy_in_fee,
          /* 2026-08-25 audit: this payload carried only the two money fields,
             so the ONE shared Sign Up card was materially shorter here than on
             the details page — no Bounty row, no Start Time — for the same
             tournament. "One dialog everywhere" has to mean the same dialog. */
          bounty_amount: (t as any).is_bounty ? (t as any).bounty_amount || 0 : 0,
          is_pko: !!(t as any).is_pko,
          is_mystery_bounty: !!(t as any).is_mystery_bounty,
          start_time: (t as any).start_time ?? null,
          club_id: (t as any).club_id ?? resolvedClubIdRef.current ?? null,
          status: (t as any).status ?? null,
        },
        () => {
          setRegisteredTournamentIds((prev) => new Set(prev).add(t.id));
          setPanelOpen(false);
          /* Dan 2026-08-24: "WHEN YOU CLICK REGISTER AND CONFIRM IT NEEDS TO
             AUTO OPEN YOUR TOURNAMENT TABLE AND SEAT YOU AS SOON AS YOU BUY
             IN." Registration used to end by closing a panel and leaving the
             player on the list they had just committed money from. The
             tournament's own screen is what owns seating — it holds you in
             the waiting room until the clock starts and moves you to your
             table when it does — so that is where a paid entry belongs.
             Deferred a tick for the same reason the join path defers: let the
             panel unmount before the router transition. */
          setTimeout(() => openTournamentLobby(t.id), 0);
        }
      );
    },
    // `navigate` is not used in this callback; `openTournamentLobby` is.
    [registerMtt, openTournamentLobby, spinQuickJoin]
  );

  const handleUnregister = useCallback(
    async (t: LobbyTournamentRow) => {
      if (!currentUserId || actionBusy) return;
      setActionBusy(true);
      try {
        await tournamentService.unregisterPlayer(t.id, currentUserId);
        setRegisteredTournamentIds((prev) => {
          const s = new Set(prev);
          s.delete(t.id);
          return s;
        });
        toast.success('You Are No Longer Registered');
      } catch (e) {
        reportError(e, 'ClubHomePage.handleUnregister', { tournamentId: t.id });
        toast.error(e instanceof Error ? e.message : 'Could Not Unregister, Please Try Again');
      } finally {
        setActionBusy(false);
      }
    },
    [currentUserId, actionBusy, toast]
  );

  // ── LOBBY V2 view models — the SAME filtered/sorted rows, normalized ──
  /**
   * The other half of the memo fix. Even with a stable `ctx`, LobbyRow's
   * primary prop is `entry`, and this memo rebuilt every LobbyEntry object
   * from scratch whenever the source arrays changed identity — which is every
   * realtime tick, whether or not any row's CONTENT moved. A new object is a
   * new prop, so every row re-rendered anyway.
   *
   * The cache returns the SAME entry object when the underlying row is
   * byte-identical to the one it was built from. JSON.stringify over ~250
   * small rows costs well under a millisecond; re-rendering 250 rows of a
   * dozen cells each costs a great deal more. Keyed by id, and rebuilt from
   * the current lists each pass so a departed row cannot leak.
   */
  /**
   * How many players are waiting at each FULL table, so the card can say
   * "Waitlist 3" instead of a flat "Full". One `in` query for the whole board,
   * refreshed when the list of full tables changes rather than on every tick —
   * a badge is not worth a request per row per second.
   */
  const [waitlistCounts, setWaitlistCounts] = useState<Map<string, number>>(new Map());
  const fullTableKey = useMemo(
    () =>
      tables
        .filter((t) => (t.max_players || 0) > 0 && (t.current_players || 0) >= (t.max_players || 0))
        .map((t) => t.id)
        .sort()
        .join(','),
    [tables]
  );
  useEffect(() => {
    const ids = fullTableKey ? fullTableKey.split(',') : [];
    if (!ids.length) {
      setWaitlistCounts((prev) => (prev.size === 0 ? prev : new Map()));
      return;
    }
    let cancelled = false;
    void waitlistService.countsFor(ids).then((counts) => {
      // null = the read FAILED. Keep the previous counts — stale beats
      // wrong-empty, which badged a queued-up full table as plain 'Full'
      // (ITEM E audit, 2026-08-26).
      if (!cancelled && counts !== null) setWaitlistCounts(counts);
    });
    return () => {
      cancelled = true;
    };
  }, [fullTableKey]);

  const entryCacheRef = useRef<Map<string, { sig: string; entry: LobbyEntry }>>(new Map());

  const lobbyEntries = useMemo<LobbyEntry[]>(() => {
    /* One token for "the club naming inputs changed", so the signature stays a
       string compare rather than a deep one. Both parts are stable for the
       lifetime of a board. */
    const clubKey = `${club?.id ?? ''}:${Object.keys(clubNames).length}`;
    const prev = entryCacheRef.current;
    const next = new Map<string, { sig: string; entry: LobbyEntry }>();
    const stable = <R extends { id: string }>(row: R, build: (r: R) => LobbyEntry): LobbyEntry => {
      /* The waitlist count is not on the row, so it has to be part of the
         signature or a card would keep a stale "Waitlist 2" after the third
         player joined. */
      const sig = `${JSON.stringify(row)}|${waitlistCounts.get(row.id) ?? 0}|${clubKey}`;
      const hit = prev.get(row.id);
      const entry =
        hit && hit.sig === sig ? hit.entry : withClubLabel(build(row), club?.id, clubNames);
      next.set(row.id, { sig, entry });
      return entry;
    };

    const tourns = filteredTournaments.map((t) =>
      stable(t as unknown as LobbyTournamentRow, (r) => tournamentEntry(r, classifyTournament(r)))
    );
    let cash = filteredTables.map((t) =>
      stable(t as unknown as LobbyTableRow, (r) => cashEntry(r, waitlistCounts.get(r.id) ?? 0))
    );
    entryCacheRef.current = next;
    /* The Favorites chip lives in the quick-prefs row, which ALL does not
       render - so leaving the filter applied there stripped the board to two
       tables with no control anywhere on screen to undo it, and only a reload
       cleared it. A filter with no switch is not a filter, it is a fault. */
    if (favoritesOnly && gameType !== 'ALL') cash = cash.filter((e) => favoriteTableIds.has(e.id));

    /* ── WHAT "ALL" MEANS (Dan, 2026-08-25) ────────────────────────────────
       "WE DON'T HAVE MIXED CASH GAMES, AND THE CAP IS 10 FOR MTT ONLY.
        SPINS AND HEADS UP (SNG) SHOULD NEVER BE ON THE ALL LIST."

       Three rules, and the code only had the third one right.

       EVERY CASH TABLE. The list used to be built as three buckets -
       cashKind() === HOLDEM, then OMAHA, then LIMIT - which silently dropped
       anything landing in the MIXED bucket. MIXED is not a game type this
       platform runs; it is the fallback cashKind() returns for a variant it
       does not recognise. Production is running five `pineapple` tables right
       now, and cashKind() has no test for that string, so those five tables
       were on no tab in the app: not on ALL, and there is no Mixed tab. Any
       future variant would have vanished the same way, silently. Filtering by
       an unrecognised-variant bucket is filtering by a bug.

       NO CAP ON CASH. Each of those three buckets was also capped at 10, so a
       club with 42 NLH tables showed ten of them with nothing saying so. The
       cap is the MTT one.

       ORDER COMES FROM THE SORT CONTROL. Bucketing by game kind overrode
       whatever the player had chosen in Sort By; a flat list keeps the order
       filteredTables already put them in, so the control means what it says.

       SPINS AND HEADS UP ARE NEVER HERE. They have their own tabs, they are
       seat-first rather than browse-first, and a Spin has no lobby at all -
       tapping one commits the buy-in. The `kind === 'mtt'` test below is what
       enforces that, and tests/unit/allTabScope.test.ts pins it. */
    if (gameType === 'ALL') {
      const isMtt = (e: LobbyEntry) => e.kind === 'mtt';
      const isLateRegOrStarting = (e: LobbyEntry) =>
        e.status === 'registering' || e.status === 'late_reg' || e.status === 'starting_soon';

      const selectedTourns = tourns
        .filter((t) => isMtt(t) && isLateRegOrStarting(t))
        .slice(0, ALL_TAB_MTT_CAP);

      return [...selectedTourns, ...cash];
    }

    // Tournaments first, cash after — same order the card grid used, so the
    // page-level sort control keeps meaning what it meant.
    return [...tourns, ...cash];
  }, [
    filteredTournaments,
    filteredTables,
    favoritesOnly,
    favoriteTableIds,
    gameType,
    waitlistCounts,
    club?.id,
    clubNames,
  ]);

  /* The auto-recovery declared above, placed here because it needs the two
     values it judges: the rendered board and the club's real game count. */
  useEffect(() => {
    if (loading) return;
    if (!narrowing.filtered || !narrowing.fSpec) return;
    if (lobbyEntries.length > 0) return;
    /* The same total `totalGameCount` reports further down, written out here
       because that constant is declared below this effect. "The club has
       games but this tab shows none" is the whole trigger. */
    if (tables.length + tournaments.length <= 0) return;
    const guardKey = `${resolvedClubId ?? 'unknown'}:${gameType}`;
    if (autoUnfilteredRef.current === guardKey) return;
    autoUnfilteredRef.current = guardKey;

    const next: FilterStore = {
      ...advFilters,
      [gameType]: emptyFilterValue(narrowing.fSpec),
    };
    setAdvFilters(next);
    if (resolvedClubId) saveFilters(resolvedClubId, next);
    toast.info('Filters Cleared, They Were Hiding Every Game');
  }, [
    loading,
    narrowing.filtered,
    narrowing.fSpec,
    lobbyEntries.length,
    tables.length,
    tournaments.length,
    advFilters,
    gameType,
    resolvedClubId,
    toast,
  ]);

  const selectedEntry = useMemo(
    () => (selectedId ? lobbyEntries.find((e) => e.id === selectedId) || null : null),
    [selectedId, lobbyEntries]
  );

  // A selected row that leaves the list (deleted, filtered out, status change)
  // closes the panel rather than showing a stale game.
  useEffect(() => {
    if (panelOpen && selectedId && !selectedEntry) setPanelOpen(false);
  }, [panelOpen, selectedId, selectedEntry]);

  // Reopen the game a ?game=<id> URL points at, once the list contains it.
  // A dead id (deleted game, another club's game) is dropped on the first
  // loaded list instead of lying in wait forever.
  useEffect(() => {
    if (!urlSyncEnabled || !pendingGameRef.current) return;
    if (lobbyEntries.length === 0) return;
    const id = pendingGameRef.current;
    pendingGameRef.current = null;
    const entry = lobbyEntries.find((e) => e.id === id);
    if (entry) {
      setSelectedId(id);
      setPanelOpen(true);
    }
  }, [urlSyncEnabled, lobbyEntries]);

  /** How many rows the lobby is about to render. */
  /* ONE ctx IDENTITY PER RENDER THAT ACTUALLY CHANGES IT.
     This object was built inline in the JSX, so it was a new identity on every
     render of the page - which makes memoising the rows below it pointless,
     because every row's props change every time regardless of whether
     anything it displays did. The lobby runs to a hundred-plus rows. */
  const filteredTournamentsRef = useRef<TournamentData[]>(filteredTournaments);
  useEffect(() => {
    filteredTournamentsRef.current = filteredTournaments;
  }, [filteredTournaments]);

  const lobbyCtx = useMemo<LobbyRowContext>(
    () => ({
      waitlistedIds: waitlistedTableIds,
      seatedIds: seatedTableIds,
      registeredIds: registeredTournamentIds,
      favoriteIds: favoriteTableIds,
      onToggleFavorite: currentUserId ? handleToggleFavorite : undefined,
      /* The card's buttons run the SAME flows the game-lobby panel
               runs — registerMtt for a tournament, the table navigation for
               a cash seat, the panel itself for a look first. Nothing new
               is invented at the card level, so there is one registration
               path and one join path in this page, not three. */
      onRegister: (e) => {
        /* From a ref, so `filteredTournaments` is not a dependency of this
           memo — see tablesRef above for why that mattered. */
        const row = filteredTournamentsRef.current.find((t) => t.id === e.id);
        if (row) handleRegister(row);
        else openEntry(e);
      },
      onUnregister: (e) => {
        const row = filteredTournamentsRef.current.find((t) => t.id === e.id);
        if (row) void handleUnregister(row);
      },
      actionBusy: actionBusy || waitlistActionBusy,
      /* SEAT-FIRST (Dan 2026-08-21, binding): a Spin or Heads-Up card's Sit
         Down opens the TABLE — the seat is bought there, by the tap that
         picks it. Same flow the game-lobby panel already runs; the card was
         the one surface still routing these to the MTT Sign Up dialog, which
         charged the buy-in with no seat attached. buy_in_amount comes from
         the row when the board still has it — the sibling hop inside
         spinQuickJoin matches on it — and falls back to the entry's own
         sort value, which is the same number. */
      onSpinJoin: (e, variant) => {
        const row = filteredTournamentsRef.current.find((t) => t.id === e.id);
        spinQuickJoin(
          {
            id: e.id,
            name: e.name,
            buy_in_amount: Number(row?.buy_in_amount ?? e.buyInValue ?? 0),
          },
          variant
        );
      },
      onJoinTable: (e) => handleJoinTable(e.id),
      /* A full table's primary action is the waitlist, not a join that cannot
         succeed. The page already owns this flow for the panel; the card runs
         the same one rather than inventing a second. */
      onWaitlistToggle: (tableId: string, joining: boolean) =>
        handleWaitlistToggle(tableId, joining),
      /* Dan 2026-08-24: "VIEW TABLE SHOULD OPEN THE GAME AND LET YOU
               WATCH AS A SPECTATOR — IT CURRENTLY BRINGS YOU TO THE JOIN
               PAGE." It did, because it opened the pre-commit panel. The
               table route with no join state IS the spectator view (the
               panel's own "Observe Table" link goes to exactly this), so
               the button now goes straight there.

               For a tournament the equivalent is its own lobby screen —
               "THE DETAILS BUTTON SHOULD TAKE YOU TO THE TOURNAMENT LOBBY
               SCREEN" — unconditionally, not only once it is running. */
      onViewTable: (e) =>
        e.kind === 'cash'
          ? navigate(`/table/${e.id}`)
          : /* Dan 2026-08-20: "there is 'no lobby' for a spin, you just start
               on a table." Watch and Return To Game on a spin therefore open
               the game's live TABLE (spinQuickJoin resolves the current one,
               stale ids and recycled siblings included) — an MTT keeps its
               own lobby screen. Heads-up SNGs ride the same table route for
               the same reason; multi-seat SNGs are registration games and
               keep the lobby. */
            e.kind === 'spin' || (e.kind === 'sng' && e.capacity > 0 && e.capacity <= 2)
            ? spinQuickJoin(
                {
                  id: e.id,
                  name: e.name,
                  buy_in_amount: Number(
                    filteredTournamentsRef.current.find((t) => t.id === e.id)?.buy_in_amount ??
                      e.buyInValue ??
                      0
                  ),
                },
                e.kind === 'sng' ? 'sng' : 'spin'
              )
            : openTournamentLobby(e.id),
    }),
    [
      waitlistedTableIds,
      seatedTableIds,
      registeredTournamentIds,
      favoriteTableIds,
      currentUserId,
      handleToggleFavorite,
      handleRegister,
      handleUnregister,
      handleJoinTable,
      openEntry,
      navigate,
      handleWaitlistToggle,
      openTournamentLobby,
      spinQuickJoin,
      actionBusy,
      waitlistActionBusy,
    ]
  );

  /**
   * Everything the club is running, before ANY narrowing.
   *
   * Deliberately the whole club rather than the current tab: the count exists
   * to answer "am I missing games?", and a per-tab total would answer that
   * question with the tab's own filter already applied, which is the one
   * narrowing most likely to be forgotten.
   */
  const totalGameCount = tables.length + tournaments.length;

  if (loading) {
    return (
      <div className="club-home loading" style={{ padding: '1rem' }}>
        {/* Skeleton header */}
        <div style={{ display: 'flex', gap: '12px', alignItems: 'center', marginBottom: '1.5rem' }}>
          <div
            style={{
              width: 56,
              height: 56,
              borderRadius: '50%',
              background: 'rgba(255,255,255,0.08)',
              animation: 'animationsPulse 1.5s ease-in-out infinite',
            }}
          />
          <div style={{ flex: 1 }}>
            <div
              style={{
                width: '60%',
                height: 20,
                borderRadius: 6,
                background: 'rgba(255,255,255,0.08)',
                marginBottom: 8,
                animation: 'animationsPulse 1.5s ease-in-out infinite',
              }}
            />
            <div
              style={{
                width: '40%',
                height: 14,
                borderRadius: 4,
                background: 'rgba(255,255,255,0.06)',
                animation: 'animationsPulse 1.5s ease-in-out infinite',
              }}
            />
          </div>
        </div>
        {/* Skeleton stat bar */}
        <div style={{ display: 'flex', gap: '8px', marginBottom: '1.5rem' }}>
          {[1, 2, 3].map((i) => (
            <div
              key={i}
              style={{
                flex: 1,
                height: 60,
                borderRadius: 10,
                background: 'rgba(255,255,255,0.05)',
                animation: 'animationsPulse 1.5s ease-in-out infinite',
              }}
            />
          ))}
        </div>
        {/* Skeleton table cards */}
        {[1, 2, 3].map((i) => (
          <div
            key={i}
            style={{
              height: 80,
              borderRadius: 12,
              background: 'rgba(255,255,255,0.04)',
              marginBottom: 12,
              animation: 'animationsPulse 1.5s ease-in-out infinite',
            }}
          />
        ))}
      </div>
    );
  }

  /**
   * NOT A MEMBER, SAID IN THE TAB (Dan 2026-08-28 round 2).
   *
   * Only reachable when `clubIdOverride` is set — `bounceToInvite` still
   * redirects on the club's own route. This is the embedded half: the player
   * is told plainly, their tables keep dealing above this panel, and joining
   * is a deliberate tap rather than something that happened to them mid-hand.
   */
  if (notAMember) {
    return (
      <div className="club-home error">
        <h2>You Are Not In This Club</h2>
        <p style={{ color: '#888', fontSize: '0.9rem', margin: '0 0 1rem' }}>
          Your Games Are Still Running. Join The Club To Browse Its Lobby.
        </p>
        <div style={{ display: 'flex', gap: '0.75rem' }}>
          <button
            className="btn btn-primary"
            onClick={() => {
              setNotAMember(false);
              loadingRef.current = false;
              loadClubData();
            }}
            style={{
              background: 'rgba(255,255,255,0.1)',
              border: '1px solid rgba(255,255,255,0.2)',
              color: 'white',
              padding: '0.6rem 1.2rem',
              borderRadius: 8,
              cursor: 'pointer',
              fontWeight: 600,
            }}
          >
            Retry
          </button>
          {/* The ONE deliberate exit. Joining genuinely lives on another
              route, so this is the player choosing to leave the felt — not a
              load effect choosing for them. */}
          <Link
            to={`/invite/${clubId}`}
            className="btn btn-primary"
            style={{
              background: '#1877f2',
              border: 'none',
              color: 'white',
              padding: '0.6rem 1.2rem',
              borderRadius: 8,
              textDecoration: 'none',
              fontWeight: 600,
            }}
          >
            Join This Club
          </Link>
        </div>
      </div>
    );
  }

  if (!club) {
    /**
     * Dan 2026-08-20: distinguish "we asked and the club is not there" from
     * "our request never came back". The watchdog above unsticks a stalled
     * load, and this panel used to tell those players their club had been
     * "moved or deleted" — a flatly untrue message during the 2026-08-20
     * Supabase API degradation, when the club existed and 39 of its tables
     * were running. Same panel, same Retry button, honest wording.
     */
    return (
      <div className="club-home error">
        <h2>{loadStalled ? 'Still Loading' : 'Club Not Found'}</h2>
        <p style={{ color: '#888', fontSize: '0.9rem', margin: '0 0 1rem' }}>
          {loadStalled
            ? 'This Is Taking Longer Than Usual - The Connection May Be Slow Right Now. Your Chips And Seats Are Safe.'
            : 'The Club May Have Been Moved Or Deleted.'}
        </p>
        {/* The cause, verbatim. A player can read it out and it names the bug
            immediately; without it every failure mode looks the same. */}
        {!loadStalled && loadFailure && (
          <p
            style={{
              color: '#6a7a8a',
              fontSize: '0.72rem',
              fontFamily: 'monospace',
              margin: '0 0 1rem',
              wordBreak: 'break-word',
            }}
          >
            {loadFailure}
          </p>
        )}
        <div style={{ display: 'flex', gap: '0.75rem' }}>
          <button
            className="btn btn-primary"
            onClick={() => {
              loadingRef.current = false;
              setLoadStalled(false);
              /* Drop the previous cause, or a retry that fails differently
                 would still be showing the first attempt's reason. */
              setLoadFailure(null);
              loadClubData();
            }}
            style={{
              background: '#1877f2',
              border: 'none',
              color: 'white',
              padding: '0.6rem 1.2rem',
              borderRadius: 8,
              cursor: 'pointer',
              fontWeight: 600,
            }}
          >
            Retry
          </button>
          {/* Dan 2026-08-28 round 2: "Back To Clubs" is a real anchor to a
              route OUTSIDE /table/*, and this panel is reachable in the in-tab
              lobby precisely when the club load is flaky — so the one obvious
              button on a failure screen was an exit that took the action bar
              and every running table's container with it. Retry is the right
              action in the tab anyway; the tab's own back pill is the way out.
              TournamentDetails already guards its identical link this way. */}
          {!clubIdOverride && (
            <Link
              to="/clubs"
              className="btn btn-primary"
              style={{
                background: 'rgba(255,255,255,0.1)',
                border: '1px solid rgba(255,255,255,0.2)',
                color: 'white',
                padding: '0.6rem 1.2rem',
                borderRadius: 8,
                textDecoration: 'none',
                fontWeight: 600,
              }}
            >
              Back To Clubs
            </Link>
          )}
        </div>
      </div>
    );
  }

  /* Staff may edit the club notice. Derived once so the markup, the keyboard
     path and the visibility test cannot drift apart. */
  const noticeEditable = isOwner || isClubStaff(userRole);
  const unionManagedClub = Boolean(club.is_union || club.union_id || unionIdForCreate);
  const canCreateClubGames = noticeEditable && !unionManagedClub;

  const saveClubNotice = () => {
    const newDesc = noticeDraft.replace(/\s+/g, ' ').trim().slice(0, CLUB_LOBBY_MESSAGE_MAX_LENGTH);
    const targetId = club.id;
    void (async () => {
      const { data, error } = await supabase.rpc('fn_set_club_lobby_message', {
        p_club_id: targetId,
        p_message: newDesc,
      });
      const result = (data || {}) as { ok?: boolean; lobby_message?: string | null };
      if (error || !result.ok) {
        reportError(
          error || new Error('Club lobby message command was rejected'),
          'ClubHomePage.Notice_save_failed'
        );
        toast.error('Could Not Save The Welcome Message');
      } else {
        setClub((prev) => (prev ? { ...prev, lobby_message: result.lobby_message ?? null } : prev));
        setIsEditingNotice(false);
        toast.success('Welcome Message Updated');
      }
    })();
  };

  const openCreationFor = (target: GameType) => {
    if (!canCreateClubGames) {
      toast.info('This Club Is Managed By A Union. Create Games From The Union Console.');
      return;
    }
    haptic.selection();
    const create =
      target === 'MTT' ? 'event' : target === 'SPIN' ? 'spin' : target === 'SNG' ? 'sng' : 'table';
    navigate(`/clubs/${clubId}/table-management?create=${create}`);
  };

  const hasCashCategory = (category: 'HOLDEM' | 'OMAHA' | 'LIMIT') =>
    tables.some((table) => cashKind(table) === category);
  const tournamentKinds = tournaments.map((tournament) =>
    classifyTournament(tournament as unknown as LobbyTournamentRow)
  );
  const launchTasks: ClubLaunchTask[] = [
    {
      id: 'opening-setup',
      label: 'Complete The Opening Setup Wizard',
      detail: 'Configure Rake, BBJ, Spins, Promotions, And Leaderboards',
      complete: openingSetupComplete,
      actionLabel: 'Start Setup',
      onAction: () => setShowOpeningWizard(true),
      disabled: !isOwner,
      disabledLabel: 'Owner Required',
    },
    {
      id: 'identity',
      label: 'Choose A Club Profile Picture',
      detail: 'Add A Recognizable Club Mark',
      complete: Boolean(club.logo_url || club.avatar_url),
      actionLabel: 'Add Picture',
      onAction: () => navigate(`/clubs/${clubId}/settings`),
    },
    {
      id: 'tagline',
      label: 'Write A Club Tag Line',
      detail: 'Tell Players What Makes This Club Special',
      complete: Boolean(club.tagline?.trim()),
      actionLabel: 'Add Tag Line',
      onAction: () =>
        openingSetupComplete ? navigate(`/clubs/${clubId}/settings`) : setShowOpeningWizard(true),
      disabled: !isOwner && !openingSetupComplete,
      disabledLabel: 'Owner Required',
    },
    {
      id: 'nlh',
      label: 'Open Your First NLH Table',
      detail: 'Create A No-Limit Hold’em Cash Game',
      complete: hasCashCategory('HOLDEM'),
      actionLabel: 'Create Table',
      onAction: () => openCreationFor('HOLDEM'),
    },
    {
      id: 'plo',
      label: 'Open Your First PLO Table',
      detail: 'Create A Pot-Limit Omaha Cash Game',
      complete: hasCashCategory('OMAHA'),
      actionLabel: 'Create Table',
      onAction: () => openCreationFor('OMAHA'),
    },
    {
      id: 'limit',
      label: 'Open Your First Limit Table',
      detail: 'Create A Fixed-Limit Cash Game',
      complete: hasCashCategory('LIMIT'),
      actionLabel: 'Create Table',
      onAction: () => openCreationFor('LIMIT'),
    },
    {
      id: 'mtt',
      label: 'Schedule Your First MTT',
      detail: 'Publish A Multi-Table Tournament',
      complete: tournamentKinds.includes('mtt'),
      actionLabel: 'Create MTT',
      onAction: () => openCreationFor('MTT'),
    },
    {
      id: 'spin',
      label: 'Launch Your First Spin',
      detail: club.spins_enabled
        ? 'Create A Three-Player Spin Event'
        : 'Enable And Fund Spins First',
      complete: tournamentKinds.includes('spin'),
      actionLabel: club.spins_enabled ? 'Create Spin' : 'Set Up Spins',
      onAction: () => (club.spins_enabled ? openCreationFor('SPIN') : setShowOpeningWizard(true)),
    },
    {
      id: 'heads-up',
      label: 'Launch Your First Heads Up Game',
      detail: 'Create A Two-Player Duel',
      complete: tournamentKinds.includes('sng'),
      actionLabel: 'Create Heads Up',
      onAction: () => openCreationFor('SNG'),
    },
    {
      id: 'first-player',
      label: 'Invite Your First Player',
      detail: 'Share Your Club Link And Build The Room',
      complete: Number(club.member_count || 0) > 1,
      actionLabel: 'Invite Player',
      onAction: () => bounceToInvite(true),
    },
    {
      id: 'first-agent',
      label: 'Configure Your First Agent',
      detail: 'Promote A Player, Choose Prepaid Or Credit, And Assign Rakeback',
      complete: Boolean(configuredAgentUserId),
      actionLabel: Number(club.member_count || 0) > 1 ? 'Choose Player' : 'Invite Player First',
      onAction: () =>
        configuredAgentUserId
          ? navigate(`/clubs/${clubId}/members/${configuredAgentUserId}`)
          : Number(club.member_count || 0) > 1
            ? navigate(`/clubs/${clubId}/members`)
            : bounceToInvite(true),
      disabled: !isOwner,
      disabledLabel: 'Owner Required',
    },
  ];
  const showLaunchChecklist =
    openingChecklistEligible &&
    noticeEditable &&
    launchTasks.some((task) => !task.complete && !task.skipped);

  return (
    <div className="club-home club-home--unified-mobile">
      <GlobalUXIndicators wsConnected={wsConnected} />
      {/* Dan 2026-08-19: the resume bar moved into the persistent multi-table
          layer (PersistentTableLayer in App.tsx), which now shows it on EVERY
          non-/table route — a per-page copy here would double-render it. */}
      {/* Animations moved to ClubHomePage.css */}

      {/* ═══════════════════════════════════════════════════════════════════
          LOBBY HEADER — rebuilt 2026-08-20 (Dan).
          One header block instead of four loosely-stacked rows. Every icon in
          here was an emoji glyph (trophy / bar-chart / two-people / chain-link)
          rendered from the platform font, so the same header drew differently
          on every device and broke the house no-emoji-in-source rule. All of
          them are inline SVG on currentColor now — see LobbyIcons.tsx.
      ═══════════════════════════════════════════════════════════════════ */}
      <section className="club-mobile-welcome" aria-labelledby="club-mobile-welcome-title">
        <span>Welcome To The</span>
        <h1 id="club-mobile-welcome-title" title={club.name}>
          {club.name}
        </h1>
      </section>

      {(club.lobby_message?.trim() || noticeEditable) && (
        <section
          className={`club-mobile-owner-message ${noticeEditable && !isEditingNotice ? 'club-mobile-owner-message--editable' : ''}`}
          aria-label="Club Owner Message"
        >
          {isEditingNotice ? (
            <div className="club-mobile-owner-message__editor">
              <input
                value={noticeDraft}
                maxLength={CLUB_LOBBY_MESSAGE_MAX_LENGTH}
                onChange={(event) => setNoticeDraft(event.target.value.replace(/[\r\n]+/g, ' '))}
                placeholder="Add A One-Line Club Message"
                autoFocus
                onKeyDown={(event) => {
                  if (event.key === 'Escape') setIsEditingNotice(false);
                  if (event.key === 'Enter') {
                    event.preventDefault();
                    saveClubNotice();
                  }
                }}
              />
              <span>
                {noticeDraft.length}/{CLUB_LOBBY_MESSAGE_MAX_LENGTH}
              </span>
              <button type="button" onClick={() => setIsEditingNotice(false)}>
                Cancel
              </button>
              <button type="button" onClick={saveClubNotice}>
                Save
              </button>
            </div>
          ) : (
            /* LIVE FOR EVERY VIEWER, NOT JUST STAFF (Dan 2026-09-02).
               The second club message on a phone - <ClubOwnerMessage>'s
               `.lobby-top__house-welcome` trigger - is hidden below 900px now
               (ClubHomePage.css), and that trigger was the only way a player
               who cannot edit could open the message in full or reach the
               club's announcements from the lobby. This strip carries both
               jobs on a phone: staff still open the inline editor, everyone
               else goes where the rail's panel would have sent them. Removing
               a duplicate must not quietly remove a destination. */
            <button
              type="button"
              className="club-mobile-owner-message__copy"
              onClick={() => {
                if (!noticeEditable) {
                  navigate(`/clubs/${clubId}/announcements`);
                  return;
                }
                setNoticeDraft(club.lobby_message || '');
                setIsEditingNotice(true);
              }}
              title={club.lobby_message || 'Add A One-Line Club Message'}
              aria-label={
                noticeEditable
                  ? `Club Message: ${club.lobby_message?.trim() || 'None Set'}. Open To Edit`
                  : `Club Message: ${club.lobby_message?.trim() || 'None Set'}. Open Club Announcements`
              }
            >
              {club.lobby_message?.trim() || 'Add A One-Line Club Message'}
            </button>
          )}
        </section>
      )}

      <header className="lobby-top">
        {/* ── THE CLUB'S OWN MESSAGE, FIRST (Dan 2026-09-01) ────────────────
            "the 'welcome to club jaqk' thats on the bottom of the wallets
            should be at the top above the club card, and that should be the
            'custom clickable message' for the club owners to put the days
            message, or something custom."

            It was the last child of the wallet stack, which on a desktop rail
            put it under seven wallet rows and, on a short viewport, past the
            fold. It is the first thing in the rail now, and it is a button:
            anybody may read the message in full, staff may write it, and both
            paths continue to the club's announcements. */}
        <ClubOwnerMessage
          clubId={club.id}
          clubName={club.name}
          message={club.lobby_message}
          tagline={club.tagline}
          canEdit={noticeEditable}
          onMessageSaved={(next) =>
            setClub((prev) => (prev ? { ...prev, lobby_message: next } : prev))
          }
          onOpenAnnouncements={() => navigate(`/clubs/${clubId}/announcements`)}
          onToast={(kind, text) => (kind === 'success' ? toast.success(text) : toast.error(text))}
        />

        {/* ── Club identity + wallet ── */}
        <div className="lobby-top__main">
          <ClubIdentityCard
            className="lobby-top__identity"
            clubName={club.name}
            logoUrl={
              club.logo_url || club.avatar_url
                ? sizedStorageUrl(club.logo_url || club.avatar_url, 256)
                : Number(club.club_id) === SHARK_CLUB_ID
                  ? SHARK_CLUB_FALLBACK_LOGO
                  : null
            }
            logoFallback={<span>&#9824;</span>}
            pokerAlias={currentUser?.display_name || currentUser?.username || 'Player'}
            clubId={club.club_id}
            playerId={currentUser?.player_number}
            level={clubLevel?.level}
            playersPlaying={playersPlaying}
            onCopyClubId={() => {
              navigator.clipboard.writeText(club.club_id.toString());
              toast.success('Club ID Copied');
            }}
            onCopyPlayerId={
              currentUser?.player_number
                ? () => {
                    navigator.clipboard.writeText(currentUser.player_number!.toString());
                    toast.success('Player Number Copied');
                  }
                : undefined
            }
            shareIcon={<IconShareLink />}
            onShare={async () => {
              haptic.medium();
              let refQuery = '';
              let profRefNum: number | null = null;
              try {
                // readLocalSession, not the auth SDK's remote user lookup: the
                // session is already local and the referral action must open
                // instantly when the player taps it.
                const session = readLocalSession();
                if (session?.userId) {
                  const { data: prof, error: profErr } = await supabase
                    .from('profiles')
                    .select('player_number')
                    .eq('id', session.userId)
                    .maybeSingle();
                  // ROUND 9 (2026-08-29): the uuid fallback below still
                  // credits the referral, so behaviour is unchanged - but a
                  // failed read was silently downgrading share links from the
                  // friendly player number to a raw uuid.
                  if (profErr) {
                    reportError(profErr, 'ClubHomePage.share_ref_profile_read_failed');
                  }
                  if (prof?.player_number) {
                    profRefNum = prof.player_number;
                    refQuery = `?ref=${prof.player_number}`;
                  } else {
                    refQuery = `?ref=${session.userId}`;
                  }
                }
              } catch (err) {
                reportError(err, 'ClubHomePage.share_ref_lookup_failed');
              }
              const shareUrl = `${window.location.origin}/hub/club-arena/invite/${club.id}${refQuery}`;
              const inviterName = currentUser?.display_name || currentUser?.username || 'A player';
              const playerNumText = profRefNum ? `\nYour Referral Number: ${profRefNum}` : '';
              const shareText = `${inviterName} invited you to join ${club.name}!\n\nClub ID: ${club.club_id}${playerNumText}`;

              try {
                if (navigator.share) {
                  await navigator.share({ title: club.name, text: shareText, url: shareUrl });
                } else {
                  await navigator.clipboard.writeText(`${shareText}\n\n${shareUrl}`);
                  toast.success('Club link copied!');
                }
              } catch (e) {
                reportError(e, 'ClubHomePage.async');
                /* user cancelled share */
              }
            }}
          />

          <button
            type="button"
            className="lobby-bbj"
            onClick={() => {
              haptic.medium();
              setShowBBJInfo(true);
            }}
            aria-label={`Bad Beat Jackpot: ${
              jackpotAmount > 0
                ? jackpotAmount.toLocaleString('en-US', {
                    minimumFractionDigits: 2,
                    maximumFractionDigits: 2,
                  })
                : 'No Pool'
            }`}
          >
            <ClubBBJShell className="lobby-bbj__shell" />
            <span className="lobby-bbj__label">Bad Beat Jackpot</span>
            <strong className="lobby-bbj__amount">
              {jackpotAmount > 0
                ? jackpotAmount.toLocaleString('en-US', {
                    minimumFractionDigits: 2,
                    maximumFractionDigits: 2,
                  })
                : '-'}
            </strong>
          </button>

          {/* ── Wallet ──
              WALLET SEPARATION LAW (Dan 2026-08-20): this is a CLUB screen, so
              it renders CLUB money. The variant used to become 'union' whenever
              a union owner opened one of his own clubs, which replaced Club
              Bank with Union Bank / Rake Treasury / Clubs Wallet / Backup BBJ —
              the union's books, on the club's lobby. Owning both does not merge
              them; one wallet never gets access to the other. Union figures are
              managed on the union's own surfaces and appear nowhere here.

              The lobby exposes every balance authorized for the viewer's role;
              each actionable row opens its matching ledger or cashier without
              leaving the club lobby. */}
          {currentUserId && resolvedClubId && (
            <div className="lobby-top__wallet">
              <button
                type="button"
                className="lobby-wallets-trigger"
                aria-expanded={walletsExpanded}
                aria-controls="club-wallet-list"
                onClick={() => {
                  haptic.selection();
                  setWalletsExpanded((expanded) => !expanded);
                }}
              >
                <span className="lobby-wallets-trigger__icon" aria-hidden="true" />
                <span className="lobby-wallets-trigger__copy">
                  <strong>My Wallets</strong>
                  <small>
                    {visibleWalletCount > 0
                      ? `${visibleWalletCount} ${visibleWalletCount === 1 ? 'Balance' : 'Balances'}`
                      : 'Loading Balances'}
                  </small>
                </span>
                <span
                  className={`lobby-wallets-trigger__chevron ${walletsExpanded ? 'is-expanded' : ''}`}
                  aria-hidden="true"
                />
              </button>
              <div
                id="club-wallet-list"
                className="lobby-wallets-content"
                data-expanded={walletsExpanded}
              >
                <div className="lobby-wallets-content__inner">
                  {/* The lobby renders its own compact Bad Beat Jackpot tile next
                  to the club identity. DynamicWallet therefore suppresses its
                  duplicate jackpot banner and supplies only the role-safe
                  balance tiles below it. */}
                  <DynamicWallet
                    userId={currentUserId}
                    clubId={clubId || ''}
                    // WHOSE books. A union's own lobby shows union books; every
                    // club lobby shows club books, whoever is standing in it.
                    variant={club?.is_union ? 'union' : 'club'}
                    // WHO is looking. Decides which rows exist - see walletRows.ts.
                    // The club's owner_id outranks a stale club_members row, which
                    // is how a brand new owner sees their own Club Bank.
                    role={isOwner ? 'owner' : userRole}
                    compactLobby
                    showAllLobbyWallets
                    showBBJ={false}
                    onVisibleWalletCountChange={setVisibleWalletCount}
                    onBuyDiamonds={() => {
                      haptic.medium();
                      setShowDiamondWallet(true);
                    }}
                    // Dan 2026-08-23: "if they click on Club Bank, that should
                    // open the Club Bank Cashier." The row only renders for owner,
                    // co-owner, admin and super agent, and fn_can_use_club_bank
                    // refuses everyone else server-side. The Chip Mint moved
                    // INSIDE that cashier - there is no mint button out here any
                    // more, and no mint at all once the club is in a union.
                    onOpenPlayerWallet={() => setShowPlayerWallet(true)}
                    onOpenPromoWallet={() => setActiveCashier('promo_wallet')}
                    onOpenAgentWallet={() => setActiveCashier('agent_wallet')}
                    onOpenClubBank={() => setActiveCashier('club_bank')}
                    onOpenBBJ={() => {
                      haptic.medium();
                      setShowBBJInfo(true);
                    }}
                    onOpenUnionBank={(balance) => {
                      setUnionWalletModal({ key: 'chips', label: 'Union Bank', balance });
                    }}
                    onOpenUnionRake={() => setUnionTreasuryModal('rake')}
                    onOpenUnionBackupBBJ={() => setUnionTreasuryModal('backup')}
                    onOpenUnionPromo={(balance) => {
                      setUnionWalletModal({ key: 'promo', label: 'Promo Wallet', balance });
                    }}
                    onOpenUnionSpins={(balance) => {
                      setUnionWalletModal({
                        key: 'spin_reserve',
                        label: 'Spins Treasury',
                        balance,
                      });
                    }}
                    onOpenClubRake={() => setStandaloneRakeModal(true)}
                    onOpenClubSpins={() => setStandaloneSpinsModal(true)}
                  />
                </div>
              </div>
            </div>
          )}
        </div>

        {/* ── NO SEARCH BOX ────────────────────────────────────────────────
            Dan 2026-08-25 asked for the search-by-name field to be removed
            completely: nobody is ever typing the name of a game.

            Removed rather than hidden. The state, the two filter passes that
            read it, the now-unreachable branch of the empty state, the icon
            import and the stylesheet rules all went with it. A hidden input
            still costs a filter pass over both lists on every render, and a
            dead code path is the thing that gets accidentally revived. Players
            find a game by tab, by the advanced filters and by sort, none of
            which need a name.

            tests/unit/lobbyCardsDoNotFlicker.test.ts asserts the literal UI
            strings are absent from this file, so quoting them here - even in a
            comment - would defeat the check. */}
      </header>

      <WalletCashierModal
        isOpen={!!activeCashier}
        onClose={() => setActiveCashier(null)}
        clubId={resolvedClubId || clubId || ''}
        role={isOwner ? 'owner' : userRole}
        walletType={activeCashier || DEFAULT_CASHIER_WALLET}
      />
      {unionWalletModal && (
        <UnionWalletModal
          isOpen={true}
          onClose={() => setUnionWalletModal(null)}
          unionId={unionIdForCreate || resolvedClubId || clubId || ''}
          walletKey={unionWalletModal.key}
          walletLabel={unionWalletModal.label}
          balance={unionWalletModal.balance}
        />
      )}
      {unionTreasuryModal && (
        <UnionTreasuryDetailModal
          isOpen={true}
          onClose={() => setUnionTreasuryModal(null)}
          unionId={unionIdForCreate || resolvedClubId || clubId || ''}
          mode={unionTreasuryModal}
          onSendFrom={
            unionTreasuryModal === 'backup'
              ? undefined
              : () => {
                  const isRake = unionTreasuryModal === 'rake';
                  setUnionTreasuryModal(null);
                  setUnionWalletModal({
                    key: isRake ? 'rake' : 'bbj',
                    label: isRake ? 'Rake Treasury' : 'BBJ Pool',
                    // The wallet modal fetches the true balance anyway, so 0 is fine
                    balance: 0,
                  });
                }
          }
        />
      )}
      {standaloneRakeModal && (
        <Modal
          isOpen={true}
          onClose={() => setStandaloneRakeModal(false)}
          title="Rake Treasury"
          size="large"
          showCloseButton
          className="club-home-treasury-modal"
        >
          <div style={{ height: '70vh', overflowY: 'auto', padding: '0 12px 24px' }}>
            <RakeReports clubId={resolvedClubId || clubId || ''} />
          </div>
        </Modal>
      )}
      {standaloneSpinsModal && (
        <Modal
          isOpen={true}
          onClose={() => setStandaloneSpinsModal(false)}
          title="Spins Wallet"
          size="medium"
          showCloseButton
          className="club-home-treasury-modal"
        >
          <div style={{ padding: '0 12px 24px' }}>
            <SpinActivationPanel clubId={resolvedClubId || clubId || ''} />
          </div>
        </Modal>
      )}
      <PlayerWalletModal
        isOpen={showPlayerWallet}
        onClose={() => setShowPlayerWallet(false)}
        clubId={resolvedClubId || clubId || ''}
      />
      <DiamondWalletModal
        isOpen={showDiamondWallet}
        onClose={() => setShowDiamondWallet(false)}
        onBuyClick={() => navigate('/vip')}
      />
      <BBJInfoModal
        isOpen={showBBJInfo}
        onClose={() => setShowBBJInfo(false)}
        poolId={bbjPoolId}
        poolAmount={jackpotAmount}
        currentUserId={currentUserId}
      />

      {/* ═══════════════════════════════════════════════════════════════════
          GAME ACTION BAR — every game type, flat, plus explicit sorting
      ═══════════════════════════════════════════════════════════════════ */}
      <section
        className="club-lobby-machine"
        data-opening-checklist={showLaunchChecklist || undefined}
        aria-label={`${club.name} Game Lobby`}
      >
        {/* The lobby must tell the same truth as the felt during the :55
            maintenance break (Dan 2026-09-01): without this it shows live
            counts and working Join buttons for a platform that is
            deliberately standing still. Renders nothing outside a break. */}
        <MaintenanceBreakBanner />
        <ClubLobbyCommandTop
          welcome={
            <div
              className={`lobby-top__notice ${isOwner || isClubStaff(userRole) ? 'lobby-top__notice--editable' : ''}`}
              role={noticeEditable && !isEditingNotice ? 'button' : undefined}
              tabIndex={noticeEditable && !isEditingNotice ? 0 : undefined}
              aria-label={
                noticeEditable && !isEditingNotice ? 'Edit Club Lobby Message' : undefined
              }
              onKeyDown={(e) => {
                if (!noticeEditable || isEditingNotice) return;
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  setNoticeDraft(club.lobby_message || '');
                  setIsEditingNotice(true);
                }
              }}
              onClick={() => {
                if (noticeEditable && !isEditingNotice) {
                  setNoticeDraft(club.lobby_message || '');
                  setIsEditingNotice(true);
                }
              }}
            >
              {isEditingNotice ? (
                <div className="lobby-top__notice-editor" onClick={(e) => e.stopPropagation()}>
                  <input
                    type="text"
                    value={noticeDraft}
                    maxLength={CLUB_LOBBY_MESSAGE_MAX_LENGTH}
                    onChange={(e) => setNoticeDraft(e.target.value.replace(/\s+/g, ' '))}
                    placeholder="Optional Club Lobby Message"
                    autoFocus
                    onKeyDown={(e) => {
                      if (e.key === 'Escape') setIsEditingNotice(false);
                      if (e.key === 'Enter') {
                        e.preventDefault();
                        saveClubNotice();
                      }
                    }}
                  />
                  <div className="lobby-top__notice-actions">
                    <button onClick={() => setIsEditingNotice(false)}>Cancel</button>
                    <button onClick={saveClubNotice}>Save</button>
                  </div>
                </div>
              ) : (
                <div className="club-lobby-command-top__welcome-copy">
                  <span className="club-lobby-command-top__welcome-eyebrow">Welcome To The</span>
                  <h2 className="club-lobby-command-top__club-name">{club.name}</h2>
                  <p className={!club.lobby_message?.trim() ? 'is-empty' : undefined}>
                    {club.lobby_message?.trim() ||
                      (noticeEditable ? 'Add Optional Club Lobby Message' : '\u00a0')}
                  </p>
                </div>
              )}
            </div>
          }
          controls={
            <section className="lobby-controls" aria-label="Browse Games">
              <div className="lobby-controls__heading">
                <div>
                  <span className="lobby-controls__eyebrow">Live Club Schedule</span>
                  <strong className="lobby-controls__title">Find Your Game</strong>
                </div>
                <div className="lobby-controls__operator-actions">
                  <span className="lobby-controls__total">
                    <strong>
                      {totalGameCount.toLocaleString()}
                      {countsCapped ? '+' : ''}
                    </strong>{' '}
                    Games
                  </span>
                  {canCreateClubGames && (
                    <GameCreationActions
                      managementPath={`/clubs/${clubId}/table-management`}
                      compact
                      only={CREATE_TARGET_FOR_TAB[gameType]}
                      desktopOnly
                      onNavigate={(path) => navigate(path)}
                    />
                  )}
                </div>
              </div>
              <div className="game-bar">
                <div className="game-bar__types" role="tablist" aria-label="Game Type">
                  {GAME_TYPE_TABS.map((tab) => (
                    <button
                      key={tab.key}
                      role="tab"
                      aria-selected={gameType === tab.key}
                      className={`game-bar__type ${gameType === tab.key ? 'is-active' : ''}`}
                      onClick={() => {
                        haptic.selection();
                        selectGameType(tab.key);
                      }}
                    >
                      {tab.label}
                    </button>
                  ))}
                </div>

                {/* ON ALL THIS IS A SORT BUTTON, AND IT SAYS SO (Dan 2026-08-25).
            The comment that used to sit here claimed the button was "Hidden
            on ALL". It was not, and what it opened there was worse than
            hidden: AdvancedFilters retargets initialType 'ALL' to 'HOLDEM',
            while filteredTables/filteredTournaments set advType to null on
            ALL - so a player could open the sheet, set Hold'em filters, press
            Save, watch the list not change, and have those filters then apply
            the moment they touched the NLH tab. A control that appears to do
            one thing and quietly does another.

            Hiding it was the other option and it is worse, because Sort By
            lives inside this same sheet and ALL is the tab with the most rows
            to order. So the sheet opens in sortOnly mode instead: the game
            type row and every filter section are gone, Sort By is all that is
            left, and the button reads Sort. Every other tab is unchanged. */}
                <button
                  className={`game-bar__filter-btn ${(() => {
                    if (gameType === 'ALL') return sortKey !== 'recommended' ? 'is-set' : '';
                    const fSpec = FILTER_SPECS[gameType as Exclude<FilterGameType, 'ALL'>];
                    const fVal = advFilters[gameType as FilterGameType];
                    const isFilt = fSpec && fVal && isFilterActive(fSpec, fVal);
                    return isFilt || sortKey !== 'recommended' ? 'is-set' : '';
                  })()}`}
                  aria-label={gameType === 'ALL' ? 'Sort' : 'Filters And Sort'}
                  title={gameType === 'ALL' ? 'Sort' : 'Filters And Sort'}
                  onClick={() => {
                    haptic.light();
                    setFiltersOpen(true);
                  }}
                >
                  <IconSort />
                  <span>{gameType === 'ALL' ? 'Sort' : 'Filters'}</span>
                </button>
              </div>

              {/* ═══════════════════════════════════════════════════════════════════
          QUICK PREFERENCES — the one-tap shortcuts under the action bar
          ───────────────────────────────────────────────────────────────────
          Dan 2026-08-21: "you never added the quick preference link under the
          action bar."

          Two rows, matching the reference: the stakes/buy-in TIERS, and the
          seat-status chips. The tier chips are not a separate filter - they
          write the same saved range the Advanced Filters sheet does, so the
          two can never disagree, and the icon on the right opens that sheet
          for everything the row has no space for.
      ═══════════════════════════════════════════════════════════════════ */}
              {gameType === 'ALL' ? (
                <div className="quickprefs">
                  <div className="quickprefs__row quickprefs__row--status" aria-label="Game Status">
                    {ALL_STATUS_FILTERS.map((status) => (
                      <button
                        key={status.key}
                        type="button"
                        className={`quickprefs__chip ${allStatusFilter === status.key ? 'is-on' : ''}`}
                        aria-pressed={allStatusFilter === status.key}
                        onClick={() => {
                          haptic.selection();
                          setAllStatusFilter(status.key);
                        }}
                      >
                        {status.label}
                      </button>
                    ))}
                  </div>
                </div>
              ) : (
                (() => {
                  const qSpec = FILTER_SPECS[gameType as Exclude<FilterGameType, 'ALL'>];
                  if (!qSpec) return null;
                  const qVal = advFilters[gameType as FilterGameType] ?? emptyFilterValue(qSpec);

                  return (
                    <div className="quickprefs">
                      <div
                        className="quickprefs__row quickprefs__row--status"
                        aria-label="Game Status"
                      >
                        <button
                          type="button"
                          className={`quickprefs__chip ${qVal.statuses.length === 0 ? 'is-on' : ''}`}
                          aria-pressed={qVal.statuses.length === 0}
                          onClick={() => {
                            haptic.selection();
                            const next: FilterStore = {
                              ...advFilters,
                              [gameType]: { ...qVal, statuses: [] },
                            };
                            setAdvFilters(next);
                            if (resolvedClubId) saveFilters(resolvedClubId, next);
                          }}
                        >
                          All
                        </button>
                        {/* AUDIT 2026-08-21: these chips used to be a hand-written list
                    chosen by showsCash, which disagreed with the sheet on the
                    same screen - Spin-It offered Full/Empty/Open Seats inside
                    Advanced Filters and Running/Registering out here. Both now
                    read spec.statuses, so there is one vocabulary per game type
                    and one place to change it.

                    They also write the SAVED filter now rather than the local
                    sub-filter state, which is what makes them agree with the
                    sheet after a reload instead of resetting. */}
                        {qSpec.statuses.map((sf) => {
                          const on = qVal.statuses.includes(sf.key);
                          return (
                            <button
                              key={sf.key}
                              className={`quickprefs__chip ${on ? 'is-on' : ''}`}
                              aria-pressed={on}
                              onClick={() => {
                                haptic.selection();
                                const next: FilterStore = {
                                  ...advFilters,
                                  [gameType]: {
                                    ...qVal,
                                    statuses: on
                                      ? qVal.statuses.filter((k) => k !== sf.key)
                                      : [...qVal.statuses, sf.key],
                                  },
                                };
                                setAdvFilters(next);
                                if (resolvedClubId) saveFilters(resolvedClubId, next);
                              }}
                            >
                              {sf.label}
                            </button>
                          );
                        })}
                        {currentUserId && showsCash && (
                          <button
                            type="button"
                            className={`quickprefs__chip ${favoritesOnly ? 'is-on' : ''}`}
                            aria-pressed={favoritesOnly}
                            onClick={() => {
                              haptic.selection();
                              selectFavoritesOnly(!favoritesOnly);
                            }}
                          >
                            Favorites
                          </button>
                        )}
                      </div>
                    </div>
                  );
                })()
              )}
            </section>
          }
          campaign={
            <button
              type="button"
              className="club-lobby-command-top__campaign-button"
              aria-label={`Open ${club.name} Promotions`}
              onClick={() => {
                haptic.selection();
                navigate(`/clubs/${clubId}/announcements`);
              }}
            >
              {/* The <picture> wrapper stays although both regimes now resolve
                  to the same file: it is the box the campaign bay's CSS sizes
                  (`.club-lobby-command-top__campaign-picture`), and it is where
                  a per-breakpoint <source> goes if a club ever ships two crops
                  of its own banner. */}
              <picture className="club-lobby-command-top__campaign-picture">
                <img
                  src={club.banner_url || CLUB_LOBBY_CAMPAIGN}
                  alt={
                    club.banner_url
                      ? `${club.name} Promotion`
                      : 'Shark Club Championship Series, 250,000 Guaranteed Main Event'
                  }
                />
              </picture>
            </button>
          }
        />

        {showLaunchChecklist && (
          <ClubLaunchProgress
            clubName={club.name}
            openingBank={Number(club.chip_treasury) || 0}
            tasks={launchTasks}
          />
        )}

        {/* ═══════════════════════════════════════════════════════════════════
          CLUB / UNION AD STRIP — directly under the action bar
      ═══════════════════════════════════════════════════════════════════ */}
        {/* `club.id` is the fallback, not a second source of truth: this markup
          only renders past the `if (!club) return` guard, so it is always
          present, while resolvedClubId stays null forever if the slug lookup
          missed. Without it, Filters and Create Game set state, played a
          haptic and opened nothing, with no error to explain why. */}
        {filtersOpen && (resolvedClubId || club?.id) && (
          <AdvancedFilters
            clubId={resolvedClubId || club!.id}
            initialType={gameType as FilterGameType}
            onClose={() => {
              /* Filters save on every click inside the sheet (Dan 2026-08-30),
                 so closing without Apply must still show what was saved -
                 re-read storage so the lobby matches the persisted store. */
              setFiltersOpen(false);
              setAdvFilters(loadFilters(resolvedClubId || club!.id));
            }}
            onApply={setAdvFilters}
            sortKey={sortKey}
            onSortChange={selectSortKey}
            sortOptions={SORT_OPTIONS}
            sortOnly={gameType === 'ALL'}
          />
        )}

        {/* The standalone STATUS REFINEMENT row was folded into the quick
          preferences block above on 2026-08-21. Keeping both would have shown
          the same four chips twice, a few pixels apart, with the lower copy
          the only working one. */}

        {/* ═══════════════════════════════════════════════════════════════════
          RESULT COUNT
          ─────────────────────────────────────────────────────────────────
          The lobby runs 60 to 170 cards and three independent things narrow
          it, one of which (Advanced Filters) is SAVED and survives a reload.
          Without a count, a player who set a filter days ago sees a short
          list and reads it as "this club is dead" rather than "you are
          looking at 12 of 170". The count only claims "of N" when something
          is actually narrowing, so it never implies a filter that is not set,
          and it carries the same one-tap clear the empty state uses.
      ═══════════════════════════════════════════════════════════════════ */}
        {/* Dan 2026-08-24: "REMOVE THE 30 GAMES, WE DON'T NEED THAT." The bare
          count is gone. What remains is the line that only renders when a
          filter or a search is actively hiding games — that one is not a
          statistic, it is the explanation for why the list looks short, and
          it carries the one-tap clear. */}
        {/* ═══════════════════════════════════════════════════════════════════
          LOBBY V2 — dense line-based game table + game lobby panel
          ─────────────────────────────────────────────────────────────────
          One compact row per game, columns adapted to the selected category.
          Clicking a row SELECTS it and opens the CasinoPlaque game lobby —
          it never joins, registers, or spends. All commit actions live in
          the panel and reuse the existing platform flows.
      ═══════════════════════════════════════════════════════════════════ */}
        <div className="club-home__games club-home__games--v2">
          {/* Render while loading too: LobbyTable owns the skeleton rows, and
            gating on entries>0 made them unreachable - first load flashed the
            empty state instead (review 2026-08-22). */}
          {(lobbyEntries.length > 0 || loading) && (
            <LobbyTable
              entries={lobbyEntries}
              clubId={resolvedClubId || clubId}
              category={gameType as LobbyCategory}
              selectedId={panelOpen ? selectedId : null}
              onSelect={openEntry}
              onActivate={openEntry}
              loading={loading}
              ctx={lobbyCtx}
            />
          )}

          {/* ═══════════════════════════════════════════════════════════════
            EMPTY STATE — say WHY, and offer the way out
            ───────────────────────────────────────────────────────────────
            AUDIT 2026-08-21. This said "No tables available / wait for the
            owner to create tables" for every empty result, and hid itself from
            owners entirely (`!isOwner`). Both are wrong, and the filter fix in
            this same pass makes them dangerous: filters now genuinely filter,
            so the most likely reason a lobby is empty is the player's own
            search or saved preferences - and the screen was blaming the club
            for it while offering no way back. An owner who over-filters saw a
            blank grid with no message at all.

            It now distinguishes the three real causes and, when the player
            caused it, clears the cause in one tap.
        ═══════════════════════════════════════════════════════════════ */}
          {!loading &&
            lobbyEntries.length === 0 &&
            (() => {
              // Same three causes the result count reads, from the same place.
              const totalHere = totalGameCount;
              const { filtered } = narrowing;
              const narrowed = narrowing.any;

              return (
                <div className="empty-tables">
                  {totalHere === 0 ? (
                    <>
                      <p>{showTournaments ? 'No Tournaments Yet' : 'No Tables Yet'}</p>
                      <p className="empty-hint">
                        Nothing Is Running Here Right Now. New Games Open All The Time.
                      </p>
                      {/* HOUSE ADS, `empty_state` (2026-08-28). Declared in Phase
                        1 and wired to nothing until now.

                        Deliberately ONLY this branch. The other three empty
                        views each carry a remedy - "Show All Games" - and an
                        advert beside a fix competes with the fix. This is the
                        one where the club genuinely has nothing running and the
                        player has nothing to tap, which is the entire
                        justification for the slot: it fills space that is dead,
                        rather than displacing something somebody came for. */}
                      <HouseAdCard
                        slot="empty_state"
                        clubId={resolvedClubId}
                        onNavigate={(path) => {
                          haptic.selection();
                          navigate(path);
                        }}
                      />
                    </>
                  ) : !narrowed ? (
                    <>
                      {/* ALL IS A SCOPE, NOT EVERYTHING (2026-08-26). The ALL tab
                        deliberately carries cash and joinable MTTs only - never
                        a Spin, never a Heads Up, never a tournament that has
                        stopped registering. With no search and no filter set,
                        `narrowed` is false, so a club running five Spins and
                        three running MTTs was told "Nothing Is Running Here
                        Right Now" with eight live games one tab away. The count
                        is the proof it was wrong, so the count is what it
                        says. */}
                      <p>Nothing On This Tab Right Now</p>
                      <p className="empty-hint">
                        {totalHere.toLocaleString()}
                        {countsCapped ? '+' : ''} Game{totalHere === 1 ? ' Is' : 's Are'} Open In
                        This Club. Spins And Heads Up Have Their Own Tabs, And So Do Tournaments
                        Already Under Way.
                      </p>
                    </>
                  ) : !filtered ? (
                    favoritesOnly ? (
                      <>
                        {/* Dan 2026-09-01: the Favorites toggle persisted from
                          an earlier visit and this branch blamed the TAB
                          ("None Of This Type Right Now") while 980 cash games
                          sat one toggle away. When Favorites is the narrowing,
                          say Favorites. Same rule as the comment below: name
                          the real cause. */}
                        <p>No Favorites On This Tab</p>
                        <p className="empty-hint">
                          The Favorites Filter Is On And Nothing Here Is Marked As A Favorite Yet.{' '}
                          {totalHere.toLocaleString()}
                          {countsCapped ? '+' : ''} Game
                          {totalHere === 1 ? ' Is' : 's Are'} Open In This Club.
                        </p>
                        <div className="empty-actions">
                          <button className="empty-action" onClick={clearAllNarrowing}>
                            Show All Games
                          </button>
                        </div>
                      </>
                    ) : (
                      <>
                        {/* Tab is the ONLY narrowing: blaming "filters" here
                          sent players hunting for filters they never set
                          (QA 2026-08-22). Name the real cause. */}
                        <p>Nothing Here On This Tab</p>
                        <p className="empty-hint">
                          {totalHere.toLocaleString()}
                          {countsCapped ? '+' : ''} Game{totalHere === 1 ? ' Is' : 's Are'} Open In
                          This Club, Just None Of This Type Right Now.
                        </p>
                        <div className="empty-actions">
                          <button className="empty-action" onClick={clearAllNarrowing}>
                            Show All Games
                          </button>
                        </div>
                      </>
                    )
                  ) : (
                    <>
                      <p>Nothing Matches Your Filters</p>
                      <p className="empty-hint">
                        {totalHere.toLocaleString()}
                        {countsCapped ? '+' : ''} Game{totalHere === 1 ? ' Is' : 's Are'} Open In
                        This Club, But The Filters On This Tab Hide{' '}
                        {totalHere === 1 ? 'It' : 'Them All'}.
                      </p>
                      <div className="empty-actions">
                        <button className="empty-action" onClick={clearAllNarrowing}>
                          Show All Games
                        </button>
                        {filtered && (
                          <button
                            className="empty-action empty-action--ghost"
                            onClick={() => {
                              haptic.light();
                              setFiltersOpen(true);
                            }}
                          >
                            Edit Filters
                          </button>
                        )}
                      </div>
                    </>
                  )}
                </div>
              );
            })()}
        </div>
      </section>

      {/* ═══════════════════════════════════════════════════════════════════
          SELECTED GAME LOBBY — CasinoPlaque panel (renders ONLY for the
          selected game; closes on Escape, backdrop, or the X)
      ═══════════════════════════════════════════════════════════════════ */}
      {panelOpen && selectedEntry && clubId && (
        <GameLobbyPanel
          embedded={Boolean(clubIdOverride)}
          entry={selectedEntry}
          clubId={clubId}
          currentUserId={currentUserId}
          waitlisted={waitlistedTableIds.has(selectedEntry.id)}
          seated={seatedTableIds.has(selectedEntry.id)}
          registered={registeredTournamentIds.has(selectedEntry.id)}
          /* `deletingTableId` was set in three places and read in none, so a
             table delete showed no busy state anywhere; `isRegisteringMtt`
             came out of useTournamentRegistration and was likewise never
             used, so the Register CTA had no pending state of its own. Both
             feed the panel's busy flag now, which is the control that was
             built for exactly this. */
          busy={actionBusy || waitlistActionBusy || isRegisteringMtt || deletingTableId !== null}
          onClose={() => setPanelOpen(false)}
          onJoinTable={handleJoinTable}
          onWaitlistToggle={handleWaitlistToggle}
          onRegister={handleRegister}
          onUnregister={handleUnregister}
          onSpinJoin={(t, variant) => {
            setPanelOpen(false);
            spinQuickJoin({ id: t.id, name: t.name, buy_in_amount: t.buy_in_amount }, variant);
          }}
          canDelete={
            (isOwner || userRole === 'admin' || userRole === 'co_owner') &&
            selectedEntry.players === 0 &&
            /* resolvedClubId, not clubId (2026-08-28 audit). On a `/clubs/:slug`
               route `clubId` is the SLUG while `raw.club_id` is a UUID, so this
               comparison was always false and the owner's table-close button
               was silently absent from the panel for every game that carries a
               club_id — which is all of them. The resolved UUID is in scope and
               is what every other comparison in this file uses. */
            (!(selectedEntry.raw as any).club_id ||
              (selectedEntry.raw as any).club_id === resolvedClubId)
          }
          onDeleteTable={(id) => {
            setPanelOpen(false);
            setDeleteTableConfirm({ show: true, tableId: id, tableName: selectedEntry.name });
          }}
        />
      )}

      {/* ═══════════════════════════════════════════════════════════════════
                BACKGROUND IMAGE (Premium Bar Scene)
            ═══════════════════════════════════════════════════════════════════ */}

      {/* ═══════════════════════════════════════════════════════════════════
                BOTTOM NAVIGATION BAR
            ═══════════════════════════════════════════════════════════════════ */}
      {/* SPIN QUICK-JOIN overlay — covers the register -> seat wait. */}
      {spinJoin && (
        <div className="spin-join-overlay" role="status">
          <div className="spin-join-card">
            <div className="spin-join-spinner" aria-hidden="true" />
            <div className="spin-join-title">{spinJoin.stage}</div>
            <div className="spin-join-sub">{spinJoin.name}</div>
            <button
              type="button"
              className="spin-join-cancel"
              onClick={() => {
                spinJoinCancelRef.current = true;
                setSpinJoin(null);
              }}
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* Confirm Modal for Table Closure */}
      <ConfirmModal
        isOpen={deleteTableConfirm.show}
        title="Close Table"
        message={`Close table "${deleteTableConfirm.tableName || ''}"? It can only close after every player has left.`}
        variant="danger"
        confirmText="Close Table"
        onConfirm={async () => {
          if (deleteTableConfirm.tableId) {
            const id = deleteTableConfirm.tableId;
            setDeleteTableConfirm({ show: false, tableId: null, tableName: null });
            setDeletingTableId(id);
            try {
              await gameManagementService.close('table', id);
              setTables((prev) => prev.filter((t) => t.id !== id));
              toast.success('Table Closed');
            } catch (err) {
              reportError(err, 'ClubHomePage.Failed_to_close_table');
              toast.error(err instanceof Error ? err.message : 'Failed To Close Table');
            } finally {
              setDeletingTableId(null);
            }
          }
        }}
        onCancel={() => setDeleteTableConfirm({ show: false, tableId: null, tableName: null })}
      />

      {showOpeningWizard && isOwner && club && openingChecklistEligible && (
        <ClubOpeningWizard
          clubId={club.id}
          clubName={club.name}
          clubBank={Number(club.chip_treasury) || 0}
          onClose={() => setShowOpeningWizard(false)}
          onComplete={({ clubBankAfter, spinsEnabled, tagline }) => {
            setClub((previous) =>
              previous
                ? {
                    ...previous,
                    chip_treasury: clubBankAfter,
                    spins_enabled: spinsEnabled,
                    tagline,
                  }
                : previous
            );
            setOpeningSetupComplete(true);
            setShowOpeningWizard(false);
          }}
        />
      )}
    </div>
  );
}
