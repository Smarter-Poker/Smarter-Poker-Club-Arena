/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  DYNAMIC WALLET — Compact Premium-Style Inline Display
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Compact wallet display positioned below the club card.
 * Shows BBJ banner + role-specific wallet balance rows with action buttons.
 *
 * TWO SCOPES, chosen EXPLICITLY by the caller — never inferred:
 *   'club'  — the club's books. WHICH rows appear is decided by the viewer's
 *             role, in walletRows.ts (see WALLET VISIBILITY LAW there).
 *   'union' — Rake Treasury, BBJ Backup, Promo. Union surfaces only.
 *
 * ── WALLET VISIBILITY LAW (Dan 2026-08-23, binding) ─────────────────────────
 * A player sees Diamonds and their Player Wallet, nothing else. Agents and sub
 * agents add an Agent Wallet and a Promo Wallet. Only an owner, co-owner,
 * admin or super agent ever sees the CLUB BANK, and clicking it opens the Club
 * Bank Cashier. The rule lives in walletRows.ts; the server enforces the same
 * four roles in fn_can_use_club_bank, so this is presentation, not security.
 *
 * ── CHIP MINT (Dan 2026-08-23) ──────────────────────────────────────────────
 * There is no mint button on this panel any more. Minting is not a wallet
 * action, it is a Club Bank action, and it exists only for a STANDALONE club —
 * the moment a club joins a union its mint is revoked and chips flow down from
 * the union instead. The entry point is inside the Club Bank Cashier.
 *
 * ── WALLET SEPARATION LAW (Dan 2026-08-20, binding) ─────────────────────────
 * Union money and club money are DIFFERENT MONEY and must never appear on the
 * same panel. Owning both does not merge them: a union owner standing in one
 * of his own clubs is a CLUB owner in that context and sees the CLUB's ledgers
 * only. The 'union' variant is legal on union-scoped surfaces alone (union
 * dashboard / union cashier) and is NEVER auto-selected — see effectiveVariant
 * below for the regression this replaced.
 *
 * All variants: Diamond Balance (+buy). The BBJ banner is opt-out via
 * `showBBJ` for surfaces that already render a dedicated jackpot ticker.
 *
 * Real-time data flow:
 *   1. Initial fetch via Supabase REST
 *   2. Supabase Realtime subscriptions on profiles, club_members, bbj_pools,
 *      agents, clubs, union_wallets
 *   3. MasterBus subscriptions: BALANCE_UPDATED, DIAMOND_BALANCE_CHANGED,
 *      WALLET_REFRESHED, CHIPS_ADDED, CHIPS_DISTRIBUTED, CHIPS_WITHDRAWN,
 *      CLUB_UPDATED, SETTLEMENT_COMPLETED, COMMISSION_PAID
 *
 * Improvements (v2):
 *   - Loading skeleton (shimmer) instead of flash-of-zeros
 *   - Error state with retry button
 *   - RT channel reconnect with exponential backoff
 *   - union_wallets RT channel for instant union bank updates
 *   - Accessibility: keyboard handlers, focus indicators, aria-live
 */

import { useState, useEffect, useRef, useCallback } from 'react';
import { WalletIcon, type WalletIconName } from '../icons/LobbyIcons';
import { useIsMounted } from '../../hooks/useIsMounted';
import { useMasterBusSubscriptions } from '../../hooks/useMasterBusSubscription';
import { supabase } from '../../lib/supabase';
import { resolveClubUUID, resolveClubUUIDSync } from '../../utils/clubIdResolver';
import {
  walletCacheKey,
  readWalletCacheEntry,
  writeWalletCacheDebounced,
  dedupedFetch,
} from '../../lib/walletCache';
import { useVisibilityRefresh } from '../../hooks/useVisibilityRefresh';
import { normaliseRole, type ClubRole } from '../../types/clubRoles';
import {
  canSeeClubBank,
  clubLobbyWalletRows,
  clubWalletRows,
  type WalletRowKey,
} from './walletRows';
import { useSpinsWallet } from '../../hooks/useSpinsWallet';
import './DynamicWallet.css';
import { reportError } from '../../utils/errorReporter';
import { ClubBBJShell, ClubWalletShell, type ClubWalletArtworkKind } from './ClubWalletArtwork';

// All bus events that should trigger a wallet refresh
const WALLET_BUS_EVENTS = [
  'BALANCE_UPDATED',
  'DIAMOND_BALANCE_CHANGED',
  'WALLET_REFRESHED',
  'CHIPS_ADDED',
  'CHIPS_DISTRIBUTED',
  'CLUB_UPDATED',
  'SETTLEMENT_COMPLETED',
  'COMMISSION_PAID',
] as const;

// Reconnect backoff delays (ms)
const BACKOFF_DELAYS = [2000, 4000, 8000, 16000, 30000];

/**
 * A cached panel younger than this is trusted as-is on mount: no immediate
 * refetch. Realtime channels re-bind instantly, bus events still force a
 * refresh, and the visibility hook refetches after 30s+ hidden — so the only
 * thing this window skips is the redundant full resync on every page hop.
 */
const FRESH_WINDOW_MS = 15_000;

// ═══════════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * WHOSE BOOKS this panel is showing. Not "who is looking" — that is `role`.
 * The two were once the same prop and the result is documented at
 * effectiveVariant below.
 */
type WalletVariant = 'club' | 'union';

interface DynamicWalletProps {
  userId: string;
  clubId: string;
  variant?: WalletVariant;
  /**
   * The viewer's role IN THIS CLUB. Decides which club rows exist — see
   * walletRows.ts. Defaults to 'player', the least-privileged reading, so a
   * caller that forgets to pass it under-shows rather than over-shows.
   * Ignored by the 'union' scope, which has its own fixed row set.
   *
   * Widened to `string` because CashierPage still holds its role as a bare
   * string carrying legacy values like 'member'. normaliseRole maps anything
   * unrecognised onto 'player', so a stale vocabulary can only ever show LESS.
   */
  role?: ClubRole | string;
  /**
   * False while the caller is still fetching the viewer's role.
   *
   * `role` defaults to 'player', which is the safe default but not a HONEST
   * one during hydration: CashierPage holds 'member' until its context query
   * returns, so a club owner landing there saw a single Player Wallet row and
   * then watched Agent, Promo and Club Bank pop in underneath it. On a money
   * surface that reads as "my club bank is gone". The panel keeps its skeleton
   * instead, which is what it already does for its own in-flight data.
   */
  roleReady?: boolean;
  /**
   * Render the BBJ banner. Default true. The club lobby passes false because
   * BBJTicker already owns the jackpot up there — two live copies of the same
   * number, animating on two separate subscriptions, is the kind of duplication
   * that eventually shows two DIFFERENT figures on one screen.
   */
  showBBJ?: boolean;
  /**
   * Compact Club Arena header treatment. It keeps the same live data and
   * click handlers, but limits the visible tiles to the role-specific lobby
   * summary. Every other ledger remains available through the Cashier.
   */
  compactLobby?: boolean;
  /**
   * The Club Arena mobile wallet accordion is a ledger, not the old three-tile
   * summary. Keep the compact artwork and actions, but include every row the
   * viewer is authorized to see. Desktop decides which three rows remain in
   * its fixed command column with responsive CSS; the DOM/data source stays
   * singular so we do not create a second set of balance subscriptions.
   */
  showAllLobbyWallets?: boolean;
  /** Reports the number of real, authorized balance rows rendered. */
  onVisibleWalletCountChange?: (count: number) => void;
  onBuyDiamonds?: () => void;
  /** Opens the Club Bank Cashier. Only ever wired on the four bank roles. */
  onOpenClubBank?: () => void;
  onOpenPromoWallet?: () => void;
  onOpenAgentWallet?: () => void;
  onOpenPlayerWallet?: () => void;
  onOpenBBJ?: () => void;
  onOpenUnionRake?: (balance: number) => void;
  onOpenUnionBackupBBJ?: (balance: number) => void;
  onOpenUnionBank?: (balance: number) => void;
  onOpenUnionPromo?: (balance: number) => void;
  onOpenUnionSpins?: (balance: number) => void;
  onOpenClubRake?: (balance: number) => void;
  onOpenClubSpins?: (balance: number) => void;
}

interface WalletData {
  diamonds: number;
  bbjPool: number;
  /**
   * The id of the pool row `bbjPool` was read from. The realtime filter binds
   * to THIS row rather than re-deriving the scope from club_id / union_id -
   * see the bbj_pools subscription below for why re-deriving it was wrong on
   * two separate paths.
   */
  bbjPoolId: string | null;
  chipBalance: number;
  clubBank: number;
  agentBalance: number;
  promoBalance: number;
  unionBank: number;
  backupBBJ: number;
  /**
   * WALLET AUDIT 2026-08-19 — RESTORED + made regression-proof.
   *
   * Commit 714738896 removed the union ledger rows and the union-first BBJ
   * resolver from this widget. The effect, had it shipped: every union club
   * resolves its jackpot by club_id, finds its own RETIRED pool row (both
   * club pools were merged into the union pool and zeroed on 2026-08-19) and
   * shows a 0.00 Bad Beat Jackpot while 14k sits in the union pool — plus the
   * Rake Treasury row disappears and Promo falls back to the club-agent
   * wallet. Production was still serving the older, correct bundle, so this
   * was latent rather than live.
   *
   * All of that rule now lives in ONE server function, fn_club_money_panel,
   * so a client-side edit cannot silently un-fix it again.
   */
  clubTreasury: number;
  unionRake: number;
  unionPromo: number;
  /**
   * A STANDALONE club's own rake treasury (fn_club_money_panel ->
   * club_rake_treasury). A club inside a union has none — its rake goes to the
   * union's treasury, which is union money. `null` means "not applicable or
   * not readable", and renders as "-" rather than as 0.00.
   */
  clubRakeTreasury: number | null;
  /**
   * THE CLUB'S OWN PROMO WALLET (fn_club_money_panel -> club_promo_wallet).
   *
   * Dan, 2026-09-02: "NONE OF THE CHIPS FROM THE BBJ RAKE ARE GOING INTO THE
   * PROMO WALLET." They were, and are. Every hand's bad-beat drop splits
   * 50/25/25 main/backup/promo, and fn_sweep_bbj_promo banks the promo slice in
   * clubs.promo_balance for a standalone club (Deep Stack Society held 1,220.19
   * of it, correctly, on the day he asked). What no surface could do was READ
   * it: the panel never returned the column, so the club's Promo Wallet row
   * fell back to `promoBalance` - the VIEWER'S OWN agent float, 0.00 for an
   * owner who is not an agent.
   *
   * A club inside a union banks its promo slice in the UNION wallet, so this is
   * honestly 0 there and `unionPromo` carries the union's figure on the union
   * surface. Club-scoped either way, per the wallet separation law.
   */
  clubPromoWallet: number;
  /**
   * UNION SPIN TREASURY (Dan 2026-08-24: "the wallet is still missing the
   * spins treasury"). The capital every Spin multiplier is paid out of.
   *
   * TWO HALVES, because either alone lies: `unionSpinIdle` is what sits in
   * union_wallets.spin_reserve_wallet waiting to be seeded, and
   * `unionSpinDeployed` is what is live inside spin_bonus_pools. Reporting
   * only the column showed 0.00 while ~25,800 was in the pool — the seed was
   * debited straight from promo_wallet into the pool row and never touched the
   * column. The row shows the SUM; the breakdown is the hint.
   */
  unionSpinTreasury: number;
  unionSpinIdle: number;
  unionSpinDeployed: number;
  /** Sum of member clubs' operational banks — the real union-level figure. */
  clubsWallet: number;
  /** What Monday's close hands back to THIS club / to all clubs. */
  clubProjectedRakeback: number;
  projectedClubsShare: number;
  nextCloseAt: string | null;
  /**
   * What the caller is permitted to see. union_wallets is RLS-restricted to
   * union owners/admins, so a CLUB owner's union reads returned nothing and
   * the panel rendered "Union Bank 0.00 / Rake Treasury 0.00" as if that were
   * the truth. Anything outside this scope renders as "—" (unknown) instead.
   */
  scope: 'union' | 'club' | 'member' | null;
}

/**
 * A cached panel is untrusted input. `localStorage` survives builds, users and
 * tampering, and `readWalletCacheEntry` validates only the envelope, never the
 * payload — so a legacy or edited entry could put a string where a balance
 * belongs and be spread straight into state. Every numeric field goes through
 * Number() and a finiteness check here, falling back to the zero-state, and a
 * non-object payload is rejected outright (spreading a string yields
 * `{0:'a',1:'b'}`, which is how a wallet ends up rendering nothing at all).
 */
function sanitiseCachedWalletData(raw: unknown): WalletData {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return INITIAL_WALLET_DATA;
  const src = raw as Record<string, unknown>;
  const out = { ...INITIAL_WALLET_DATA } as Record<string, unknown>;
  for (const [key, fallback] of Object.entries(INITIAL_WALLET_DATA)) {
    const v = src[key];
    if (v === undefined) continue;
    if (typeof fallback === 'number') {
      const n = Number(v);
      out[key] = Number.isFinite(n) ? n : fallback;
    } else if (key === 'clubRakeTreasury') {
      const n = Number(v);
      out[key] = v === null ? null : Number.isFinite(n) ? n : null;
    } else if (key === 'scope') {
      out[key] = v === 'union' || v === 'club' || v === 'member' ? v : null;
    } else if (key === 'nextCloseAt') {
      out[key] = typeof v === 'string' ? v : null;
    } else {
      out[key] = fallback;
    }
  }
  return out as unknown as WalletData;
}

// ═══════════════════════════════════════════════════════════════════════════════
// ANIMATED COUNTER — preserves fractional precision (2 decimal places)
// ═══════════════════════════════════════════════════════════════════════════════

function useAnimatedCounter(target: number, duration = 400): number {
  /* A non-finite target used to be fatal and PERMANENT. `Math.abs(NaN) < 0.01`
     is false, so the animation ran, committed NaN, and from then on every
     later target computed `start = NaN` -> `diff = NaN` -> NaN again: the row
     was stuck for the life of the component, and formatBalance printed the
     wreckage as a tidy "0.00" on a money surface. One coercion at the door
     ends the whole class. */
  /* The animation runs from a finite number - it has to - but the CALLER must
     still be able to tell a broken figure from a real zero. `formatBalance`
     and `formatDiamonds` print "-" for a non-finite value on the grounds that
     a wrong number on a money surface is worse than none, and coercing here
     without returning the sentinel below quietly turned every one of those
     into a confident 0.00. */
  const targetIsReal = Number.isFinite(target);
  const safeTarget = targetIsReal ? target : 0;
  const [value, setValue] = useState(safeTarget);
  const rafId = useRef<number | null>(null);
  /* Synced in an effect, never in the render body. Writing a ref while
     rendering is a side effect: React 19 may start a render and throw it
     away, leaving the ref holding a number that was never on screen, and the
     next animation would then start from it and visibly jump. */
  /* Seeded here, then written only by the two places that KNOW the committed
     value: the settle path and each animation frame. A `useEffect(..., [value])`
     mirror was tried and removed - passive effects flush on their own schedule,
     so under load the effect for frame N could land after frame N+1 had already
     written the ref, moving it BACKWARDS and starting the next animation a
     frame behind. */
  const currentValueRef = useRef(safeTarget);

  useEffect(() => {
    const start = currentValueRef.current;
    const diff = safeTarget - start;
    if (!Number.isFinite(diff) || Math.abs(diff) < 0.01) {
      setValue(safeTarget);
      currentValueRef.current = safeTarget;
      return;
    }

    const startTime = performance.now();
    const animate = (now: number) => {
      const elapsed = now - startTime;
      const progress = Math.min(elapsed / duration, 1);
      const eased = 1 - Math.pow(1 - progress, 3);
      // Preserve 2-decimal precision instead of Math.round (which loses cents)
      const interpolated = start + diff * eased;
      const next = Math.round(interpolated * 100) / 100;
      currentValueRef.current = next;
      setValue(next);
      if (progress < 1) rafId.current = requestAnimationFrame(animate);
    };
    rafId.current = requestAnimationFrame(animate);
    return () => {
      if (rafId.current) cancelAnimationFrame(rafId.current);
    };
  }, [safeTarget, duration]);

  return targetIsReal ? value : NaN;
}

// ═══════════════════════════════════════════════════════════════════════════════
// FORMAT NUMBER
// ═══════════════════════════════════════════════════════════════════════════════

function formatBalance(num: number): string {
  // Math.abs() was applied here, so an agent wallet of -25,000 rendered
  // identically to +25,000 — the sign of a debt was invisible on a money
  // surface. Negatives are now shown as negatives.
  /* NaN and Infinity are NOT zero. Printing them as "0.00" is the one thing
     this file argues against everywhere else - a wrong number on a money
     surface is worse than none - so they render as unknown, the same mark
     every unreadable figure already uses. */
  if (!Number.isFinite(num)) return '-';
  return num.toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

/* Dan 2026-08-24: "DIAMONDS ARE ALWAYS WHOLE NUMBERS SO YOU CAN DELETE THE
   .00." Diamonds are a counted item, not a currency — they are bought, spent
   and awarded in whole units and there is no half-diamond anywhere in the
   schema — so the two cents columns were decoration that made the balance
   read like money and cost it two digits of width beside the wallets that
   really are money. Truncation, not rounding: a fractional diamond could only
   ever arrive from a bad write, and rounding 0.6 up to 1 would invent a
   diamond the player does not own. */
function formatDiamonds(num: number): string {
  if (!Number.isFinite(num)) return '-';
  return Math.trunc(num).toLocaleString('en-US', { maximumFractionDigits: 0 });
}

// ═══════════════════════════════════════════════════════════════════════════════
// COMPONENT
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * The zero-state panel. Extracted so a cache-hit paint can MERGE the cached
 * payload over these defaults: a payload written before a field existed (the
 * Spins Treasury trio arrived after the cache shipped) would otherwise hand
 * `undefined` to the animated counters. Shape drift heals here instead of
 * requiring a version bump that throws away every valid cached number.
 */
const INITIAL_WALLET_DATA: WalletData = {
  diamonds: 0,
  bbjPool: 0,
  bbjPoolId: null,
  chipBalance: 0,
  clubBank: 0,
  agentBalance: 0,
  promoBalance: 0,
  unionBank: 0,
  backupBBJ: 0,
  clubTreasury: 0,
  unionRake: 0,
  unionPromo: 0,
  clubRakeTreasury: null,
  clubPromoWallet: 0,
  unionSpinTreasury: 0,
  unionSpinIdle: 0,
  unionSpinDeployed: 0,
  clubsWallet: 0,
  clubProjectedRakeback: 0,
  projectedClubsShare: 0,
  nextCloseAt: null,
  scope: null,
};

/** What one (user, club, variant) stores on the device. */
interface CachedPanel {
  data: WalletData;
  isClubInUnion: boolean;
  unionId: string | null;
  /**
   * The viewer's role at the time the panel was last shown with roleReady.
   * Lets a revisit choose the correct ROW SET immediately instead of holding
   * the skeleton while the page re-derives a role that almost never changes.
   * Presentation only — every permission check still runs on the live role.
   */
  role?: ClubRole;
}

export default function DynamicWallet({
  userId,
  clubId,
  variant = 'club',
  role = 'player',
  roleReady = true,
  showBBJ = true,
  compactLobby = false,
  showAllLobbyWallets = false,
  onVisibleWalletCountChange,
  onBuyDiamonds,
  onOpenClubBank,
  onOpenPromoWallet,
  onOpenAgentWallet,
  onOpenPlayerWallet,
  onOpenBBJ,
  onOpenUnionRake,
  onOpenUnionBackupBBJ,
  onOpenUnionBank,
  onOpenUnionPromo,
  onOpenUnionSpins,
  onOpenClubRake,
  onOpenClubSpins,
}: DynamicWalletProps) {
  // ── SYNCHRONOUS BOOT (Dan 2026-08-24: "the wallet should always be loaded
  // and displayed... it should just stay in some sort of persistent state") ──
  // The cache read used to live in a useEffect, which runs AFTER the first
  // paint — so every mount showed at least one skeleton frame even on a
  // memory-cache hit, and leaving a table for the lobby "reloaded" a wallet
  // whose numbers were seconds old. The read now happens DURING the first
  // render: a remount paints the last-known panel in its very first frame.
  //
  // `fresh` additionally records whether the entry is younger than the fresh
  // window — if so, the immediate refetch is skipped entirely (the realtime
  // channels, bus events and the visibility refresh own keeping it true),
  // which is what stops a Table -> Lobby hop from resyncing everything.
  const bootRef = useRef<{
    key: string | null;
    entry: CachedPanel | null;
    fresh: boolean;
  } | null>(null);
  if (bootRef.current === null) {
    const key = userId && clubId ? walletCacheKey(userId, clubId, variant) : null;
    const hit = key ? readWalletCacheEntry<CachedPanel>(key) : null;
    bootRef.current = {
      key,
      entry: hit?.data && hit.data.data ? hit.data : null,
      fresh: hit ? Date.now() - hit.at < FRESH_WINDOW_MS : false,
    };
  }
  const boot = bootRef.current;

  const [data, setData] = useState<WalletData>(() =>
    boot.entry ? sanitiseCachedWalletData(boot.entry.data) : INITIAL_WALLET_DATA
  );
  const [loading, setLoading] = useState(() => !boot.entry);
  const [fetchError, setFetchError] = useState(false);
  const [isClubInUnion, setIsClubInUnion] = useState(() => boot.entry?.isClubInUnion ?? false);
  const isMounted = useIsMounted();
  /* Realtime topics must be unique PER MOUNTED PANEL, not just per club.
     RealtimeClient._leaveOpenTopic unsubscribes any already-joined channel
     with the same topic on every subscribe, so two wallet surfaces in one
     window - the club lobby's panel and a modal's, which the fetch dedupe
     above exists precisely because they co-occur - silently killed each
     other's listeners: the first panel's jackpot and agent balance froze,
     and the survivor entered a reconnect loop re-killing the other. */
  const instanceIdRef = useRef<string>('');
  if (!instanceIdRef.current) {
    instanceIdRef.current = Math.random().toString(36).slice(2, 10);
  }
  /* AND WITH THE EPOCH. `RealtimeClient.channel(topic)` RETURNS THE EXISTING
     CHANNEL when one with that topic is still registered, and
     `removeChannel()` only deregisters when the server acknowledges the leave
     - a network round trip. React runs an effect's cleanup and its next setup
     back to back in one synchronous pass, so a reconnect asked for a topic the
     old channel still held and got that object back, in state 'leaving'.
     `RealtimeChannel.subscribe()` does all of its work inside
     `if (this.state === 'closed')`, so it registered no status callback,
     never joined, and returned silently: no SUBSCRIBED, no CHANNEL_ERROR, no
     CLOSED, nothing to reconnect it. One epoch-scoped topic per attempt makes
     a collision impossible. */

  // Resolved UUID — DynamicWallet now handles resolution internally.
  // Synchronous from the persisted map on first render whenever the mapping
  // is already on the device, so the realtime channels bind immediately.
  const [resolvedId, setResolvedId] = useState<string | null>(() =>
    clubId ? resolveClubUUIDSync(clubId) : null
  );
  // Fetch version counter to discard stale responses on rapid club switching
  const fetchVersionRef = useRef(0);
  // Tracked union_id for union_wallets RT channel
  const currentUnionIdRef = useRef<string | null>(boot.entry?.unionId ?? null);
  // Consume the fresh window exactly once (see the fetch effect).
  const skipNextFetchRef = useRef(boot.fresh);
  // The clubId effect's first run must not redo (and briefly undo) the work
  // the synchronous boot above already did.
  const bootConsumedRef = useRef(false);
  // Mirrored into state because the realtime effect below binds its BBJ and
  // union_wallets filters to this value. A ref cannot be a dependency, so the
  // effect previously keyed on the `isClubInUnion` BOOLEAN — which does not
  // change when moving from one union club to ANOTHER union club, leaving both
  // channels subscribed to the PREVIOUS union. The panel then showed a live
  // Bad Beat Jackpot and Union Bank belonging to the club you just left.
  const [currentUnionId, setCurrentUnionId] = useState<string | null>(boot.entry?.unionId ?? null);
  // Reconnect tracking
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const retryCountRef = useRef(0);
  // Identifies which (user, club, union) the channels are bound to, so a
  // reconnect can be told apart from a genuine change of subscription target.
  const lastSubscriptionTargetRef = useRef<string>('');
  // Bumped by scheduleReconnect and used as a dependency of the realtime
  // effect, so a reconnect actually TEARS DOWN AND REBUILDS the channels.
  // Previously the reconnect timer only called fetchData(): one refetch, the
  // dead channel left dead, no re-arm, and because retryCountRef only advanced
  // once the backoff never escalated past its first entry.
  const [channelEpoch, setChannelEpoch] = useState(0);
  /** Topic discriminator: per mounted panel AND per reconnect attempt. */
  const channelTopicSuffix = `${instanceIdRef.current}-${channelEpoch}`;

  // ── Instant-paint cache (Dan 2026-08-23: "wallets need to cache much
  // better") ────────────────────────────────────────────────────────────────
  // Keyed on the RAW clubId prop (not the resolved UUID) so a cache hit can
  // paint before — and without — the UUID-resolution roundtrip. The cached
  // payload is only ever a PAINT: fetchData always runs and overwrites it,
  // and every realtime delta is written back through, so the cache converges
  // on the live panel. See walletCache.ts for the full contract.
  const cacheKey = userId && clubId ? walletCacheKey(userId, clubId, variant) : null;
  // Which cache key the CURRENT `data` state legitimately belongs to. Guards
  // the write-through effect against the one-render window after a club
  // switch where `cacheKey` already points at the new club while `data` still
  // holds the old one — writing in that window would poison the new club's
  // cache with the old club's money.
  const paintedKeyRef = useRef<string | null>(boot.entry ? boot.key : null);
  // Last-known viewer role from the device cache. Bridges the roleReady gap:
  // the row SET paints from this until the caller's live role hydrates, then
  // the live role wins. Never used for any permission decision.
  const [cachedRole, setCachedRole] = useState<ClubRole | null>(() =>
    boot.entry?.role ? normaliseRole(boot.entry.role) : null
  );

  useEffect(() => {
    // FIRST RUN: the synchronous boot above already painted this exact key
    // during the first render — redoing it here would churn every state hook
    // for no reason. All that may still be owed is the ASYNC UUID resolution
    // (when the persisted map could not answer synchronously).
    if (!bootConsumedRef.current) {
      bootConsumedRef.current = true;
      if (paintedKeyRef.current === cacheKey || !clubId) {
        if (clubId && !resolveClubUUIDSync(clubId)) {
          resolveClubUUID(clubId)
            .then((uuid) => {
              if (isMounted.current) setResolvedId(uuid);
            })
            .catch((err) => {
              console.warn('[DynamicWallet] Failed to resolve clubId:', err);
              if (isMounted.current) setResolvedId(clubId);
            });
        }
        return;
      }
      // Boot could not paint (e.g. userId arrived after mount): fall through
      // to the full path below.
    }

    // Reset before resolving. Without this, `resolvedId` kept pointing at the
    // OLD club while resolveClubUUID was in flight, `loading` stayed false
    // (it is only ever set false after the first fetch) and `data` was never
    // cleared — so the previous club's Chip Balance, Club Bank and BBJ
    // rendered under the new club's header with no skeleton.
    setResolvedId(null);
    setCurrentUnionId(null);
    /* The union flag belongs to the club being left. Left behind, it decides
       which ROWS the next club shows before its own panel has answered. */
    setIsClubInUnion(false);
    setFetchError(false);
    setCachedRole(null);
    paintedKeyRef.current = null;
    skipNextFetchRef.current = false;
    if (!clubId) {
      setLoading(true);
      return;
    }

    // 1. INSTANT PAINT: last-known panel for this (user, club, variant) from
    //    the device cache. No skeleton on a revisit — the numbers appear in
    //    the same frame and the network refresh corrects them if stale.
    //    MERGED over the zero-state so a payload written by an older build
    //    (missing fields added since) heals to safe defaults instead of
    //    feeding `undefined` into the animated counters.
    const hit = cacheKey ? readWalletCacheEntry<CachedPanel>(cacheKey) : null;
    const cached = hit?.data;
    if (cached && cached.data) {
      setData(sanitiseCachedWalletData(cached.data));
      setIsClubInUnion(cached.isClubInUnion);
      currentUnionIdRef.current = cached.unionId ?? null;
      setCurrentUnionId(cached.unionId ?? null);
      if (cached.role) setCachedRole(normaliseRole(cached.role));
      paintedKeyRef.current = cacheKey;
      // Same fresh-window rule as the synchronous boot: seconds-old data
      // needs no immediate resync when hopping between surfaces.
      skipNextFetchRef.current = hit !== null && Date.now() - hit.at < FRESH_WINDOW_MS;
      setLoading(false);
    } else {
      setLoading(true);
    }

    // 2. UUID resolution: synchronous when the mapping is already on the
    //    device (persisted by clubIdResolver), which lets the data fetch
    //    start this tick instead of one roundtrip later.
    const syncUuid = resolveClubUUIDSync(clubId);
    if (syncUuid) {
      setResolvedId(syncUuid);
      return;
    }
    resolveClubUUID(clubId)
      .then((uuid) => {
        if (isMounted.current) setResolvedId(uuid);
      })
      .catch((err) => {
        console.warn('[DynamicWallet] Failed to resolve clubId:', err);
        // Fallback: use raw clubId (it might already be a UUID)
        if (isMounted.current) setResolvedId(clubId);
      });
  }, [clubId, cacheKey]);

  // Effective variant — the caller's choice, full stop.
  //
  // WALLET SEPARATION LAW (Dan 2026-08-20). Two successive versions of this
  // line auto-promoted a club surface to the union panel:
  //
  //   v1  `isClubInUnion ? 'union' : variant`
  //         — true for EVERY club inside a union, so ordinary member-club
  //           owners saw the union's whole treasury as their own balance.
  //   v2  `variant === 'owner' && data.scope === 'union' ? 'union' : variant`
  //         — narrower, and still wrong. `scope` answers "may this caller READ
  //           union figures", which is a PERMISSION question, not a "which
  //           wallet am I standing in" question. Dan owns both Shark Club and
  //           its union, so scope came back 'union' inside the Shark Club
  //           lobby and the club's own panel was replaced by Union Bank / Rake
  //           Treasury / Clubs Wallet / Backup BBJ. Two separate pots of money
  //           rendered as one balance sheet on a club screen.
  //
  // Being permitted to see union money elsewhere is not permission to show it
  // HERE. The surface decides: club surfaces pass 'club', union surfaces pass
  // 'union'. Nothing infers it. Do not reintroduce a promotion rule of any
  // shape. (WHICH rows a club surface shows is a separate question, answered
  // by the viewer's role in walletRows.ts — that is not a scope promotion.)
  const effectiveVariant: WalletVariant = variant;
  const viewerRole: ClubRole = normaliseRole(role);
  /* WHOSE PROMO WALLET IS THIS ROW? The people who can see the Club Bank are
     looking at the CLUB's money, and the club's promo pot is the account the
     BBJ promo slice is swept into. An agent or sub-agent is looking at their
     own float, which is the wallet they distribute promo chips from. Same row,
     same label, decided by exactly the rule that decides the Club Bank row -
     see walletRows.ts, which is the pinned law for both. */
  const clubPromoIsClubMoney = canSeeClubBank(viewerRole);

  // The pool row the jackpot on screen came from. Read by the realtime effect
  // below so the subscription binds to that exact row rather than re-deriving
  // the scope, which is wrong for a non-member of a union club.
  const bbjPoolId = data.bbjPoolId;

  // Animated values
  const animDiamonds = useAnimatedCounter(data.diamonds);
  const animBBJ = useAnimatedCounter(data.bbjPool);
  const animAgent = useAnimatedCounter(
    // Union: the combined operational banks of the member clubs. This used to
    // read the SELECTED club's own bank, which is not a union-level figure at
    // all — it read 0.00 for a union whose clubs held 800k.
    effectiveVariant === 'union' ? data.clubsWallet : data.agentBalance
  );
  const animPromo = useAnimatedCounter(
    // Three different accounts wear the name "Promo Wallet", and which one the
    // row means is decided by the surface and the viewer's role:
    //   union surface           -> union_wallets.promo_wallet (the swept slice)
    //   club surface, club bank -> clubs.promo_balance (this club's slice)
    //   club surface, an agent  -> agents.promo_wallet_balance (their own float)
    // Reading the third one for a club owner is what made Dan's Promo Wallet
    // read 0.00 while 1,220.19 of BBJ promo sat in the club's account.
    effectiveVariant === 'union'
      ? data.unionPromo
      : clubPromoIsClubMoney
        ? data.clubPromoWallet
        : data.promoBalance
  );
  const animBackupBBJ = useAnimatedCounter(data.backupBBJ);
  const animUnionSpins = useAnimatedCounter(data.unionSpinTreasury);
  // Dan 2026-08-21: "even club owners need a player wallet, that's the only
  // wallet they can play out of." Every club stack leads with the viewer's own
  // per-club chip balance — the money that actually buys into games.
  const animPlayerWallet = useAnimatedCounter(data.chipBalance);
  const animClubBank = useAnimatedCounter(data.clubBank);
  const animClubRake = useAnimatedCounter(data.clubRakeTreasury ?? 0);

  /**
   * The Spins wallet. Only fetched where it could ever be shown: a club that
   * is NOT in a union (a club inside one has no Spins wallet of its own -- the
   * pool belongs to the union) and a viewer who may see the Club Bank. The
   * union panel reads its own below.
   */
  /* resolvedId, not the raw prop. Every other read here uses the resolved
     UUID - that is what resolveClubUUID exists for - and the spins hook keys
     its device cache on whatever it is handed, so a surface passing the slug
     and one passing the UUID kept two divergent cached answers for one club.
     Which OWNER the id resolves to is still the API's decision, untouched. */
  const spins = useSpinsWallet(resolvedId, variant !== 'union' && !isClubInUnion);
  const animSpins = useAnimatedCounter(spins.balance);
  const animUnionBank = useAnimatedCounter(data.unionBank);
  const animUnionRake = useAnimatedCounter(data.unionRake);

  // ── Fetch data — uses resolvedId (UUID) for all Supabase queries ───────────
  const fetchData = useCallback(async () => {
    /* Returning while `loading` is still true left a permanent shimmer with
       no error and no retry: signed out, or signed in but not yet hydrated,
       the cache key is null so nothing paints, and this was the only path
       that could have cleared it. */
    if (!userId || !resolvedId) {
      if (isMounted.current) setLoading(false);
      return;
    }

    // Increment version — any in-flight fetch with a lower version is stale
    const thisVersion = ++fetchVersionRef.current;

    try {
      // fn_club_money_panel replaces three separate reads (bbj_pools, clubs,
      // union_wallets) with one permission-aware server call. It resolves the
      // BBJ pool union-first exactly as the engine banks it, and returns a
      // `scope` saying which figures the caller may actually see — so the
      // panel can render "—" for what it is not allowed to read instead of a
      // fabricated 0.00. It also removes the second, serial round trip.
      //
      // dedupedFetch: two wallet surfaces mounting in the same window (e.g.
      // the Cashier's panel plus a modal's) share ONE set of queries instead
      // of racing duplicates.
      const [profileRes, memberRes, agentRes, panelRes] = await dedupedFetch(
        `dw_fetch_${userId}_${resolvedId}`,
        () =>
          Promise.all([
            supabase.from('profiles').select('diamonds').eq('id', userId).maybeSingle(),
            supabase
              .from('club_members')
              .select('chip_balance')
              .eq('club_id', resolvedId)
              .eq('user_id', userId)
              .maybeSingle(),
            supabase
              .from('agents')
              .select('agent_wallet_balance, promo_wallet_balance')
              .eq('club_id', resolvedId)
              .eq('user_id', userId)
              .maybeSingle(),
            supabase.rpc('fn_club_money_panel', { p_club_id: resolvedId }),
          ])
      );

      // Discard stale response if a newer fetch has started
      if (thisVersion !== fetchVersionRef.current || !isMounted.current) return;

      // A REJECTED READ IS NOT A BALANCE OF ZERO.
      //
      // supabase-js does not throw on a query or RPC error - it RESOLVES with
      // `{ data: null, error }`. Nothing here looked at `error`, so an RLS
      // denial, a renamed fn_club_money_panel, or a PGRST116 from
      // .maybeSingle() all landed as `panel = {}`, every `num()` returned 0,
      // and the panel then declared success: Club Bank 0.00, Bad Beat Jackpot
      // 0.00, Diamonds 0, Player Wallet 0.00, no error badge. Raising here
      // sends it to the catch below, which keeps the numbers already on
      // screen and shows that they could not be refreshed.
      const readError =
        profileRes.error ?? memberRes.error ?? agentRes.error ?? panelRes.error ?? null;
      if (readError) throw readError;

      // Defensive unwrap: a jsonb-returning RPC hands back the object, but a
      // TABLE-returning one hands back an array. Reading `.x` off the array
      // was exactly how Backup BBJ came to render 0.00 once before.
      const panel = ((Array.isArray(panelRes.data) ? panelRes.data[0] : panelRes.data) ??
        {}) as Record<string, unknown>;
      /* AND `authorized: false` IS NOT A SUCCESS EITHER. fn_club_money_panel
         answers `{authorized:false, reason}` for no_auth, club_not_found and
         not_a_member, and that is a RESOLVED rpc with no `error` - so the
         error check above cannot see it. Every key below is then absent,
         `num()` returns 0, and the panel used to commit Club Bank 0.00, Bad
         Beat Jackpot 0.00 and no error badge, then persist those invented
         zeros to the device cache for the next visit to paint instantly.
         Raising sends it to the catch, which keeps whatever was on screen. */
      /* ...BUT "NOT YOURS TO READ" IS NOT "THE READ FAILED".
         Three of the four reads above are the viewer's OWN money - diamonds,
         their club chip balance, their agent wallets - and they succeed
         whether or not this club is theirs. Only the panel refuses. Throwing
         on every refusal (as the first version of this did) meant a signed-in
         NON-MEMBER opening any club lobby got a red "Balances Unavailable"
         badge and a fabricated Diamonds 0 over the balance we had just read
         successfully, with a Retry that could only fail again and a
         reportError on every visit. `not_a_member` and `no_auth` are ordinary
         states: keep what was read, leave the club's own figures UNKNOWN
         (scope stays null, so the rows render "-" rather than 0.00), and do
         not raise. Anything else really is a fault. */
      const panelRefused = panel.authorized === false;
      const refusalReason = String(panel.reason ?? 'unknown');
      if (panelRefused && refusalReason !== 'not_a_member' && refusalReason !== 'no_auth') {
        throw new Error(`fn_club_money_panel refused: ${refusalReason}`);
      }
      const bbj = (panel.bbj ?? {}) as Record<string, unknown>;
      const num = (v: unknown) => Number(v) || 0;
      const unionId = (panel.union_id as string | null) ?? null;

      // Track union_id for the union_wallets RT channel
      currentUnionIdRef.current = unionId;
      if (isMounted.current) setCurrentUnionId(unionId ?? null);

      // WALLET SEPARATION LAW: a club-scoped panel never even HOLDS union
      // figures. Gating only at render time leaves the numbers sitting in
      // component state where the next edit can surface them by accident —
      // which is exactly how Union Bank reached the Shark Club lobby. On a
      // club surface these stay 0 and are never rendered, so there is nothing
      // to leak.
      const unionScoped = variant === 'union';

      const nextData: WalletData = {
        diamonds: Number(profileRes.data?.diamonds) || 0,
        chipBalance: Number(memberRes.data?.chip_balance) || 0,
        promoBalance: Number(agentRes.data?.promo_wallet_balance) || 0,
        bbjPool: num(bbj.main),
        bbjPoolId: (bbj.pool_id as string | null) ?? null,
        backupBBJ: num(bbj.backup),
        agentBalance: Number(agentRes.data?.agent_wallet_balance) || 0,
        clubBank: num(panel.club_treasury),
        clubTreasury: num(panel.club_treasury),
        // Present ONLY for a standalone club, and only for club staff. Absent
        // means "you have no such account" or "you may not read it" — both of
        // which render "-", never 0.00.
        clubRakeTreasury:
          panel.club_rake_treasury === undefined || panel.club_rake_treasury === null
            ? null
            : num(panel.club_rake_treasury),
        // The club's own promo pot, funded by the BBJ promo slice. Club money,
        // read on a club surface; never mixed with the union's.
        clubPromoWallet: num(panel.club_promo_wallet),
        unionBank: unionScoped ? num(panel.union_bank) : 0,
        unionRake: unionScoped ? num(panel.rake_treasury) : 0,
        unionPromo: unionScoped ? num(panel.union_promo) : 0,
        unionSpinTreasury: unionScoped ? num(panel.union_spin_treasury) : 0,
        unionSpinIdle: unionScoped ? num(panel.union_spin_idle) : 0,
        unionSpinDeployed: unionScoped ? num(panel.union_spin_deployed) : 0,
        clubsWallet: unionScoped ? num(panel.clubs_wallet) : 0,
        clubProjectedRakeback: num(panel.club_projected_rakeback),
        projectedClubsShare: unionScoped ? num(panel.projected_clubs_share) : 0,
        nextCloseAt: (panel.next_close_at as string | null) ?? null,
        scope: (panel.scope as WalletData['scope']) ?? null,
      };
      setData(nextData);
      /* `in_union` is only present on an authorized panel, which the throw
         above now guarantees we have - so this is a plain assignment again.
         The earlier `if (panel.in_union !== undefined)` guard was worse than
         the unconditional write it replaced: it could never fire on the path
         it was written for (the refusal branches carry neither `in_union` nor
         `union_id`), and it PINNED a stale `true` across a club switch, which
         silently removed a standalone club's Rake Treasury and Spins Wallet
         rows and stopped useSpinsWallet fetching at all. `union_id` is the
         same fact from the same object and is the fallback. */
      /* A refusal carries neither `in_union` nor `union_id`, so it must not
         move the flag in either direction - the club-switch reset already put
         it at false, which is the safe default. */
      if (!panelRefused) {
        setIsClubInUnion(panel.in_union !== undefined ? Boolean(panel.in_union) : unionId !== null);
      }
      setFetchError(false);
      setLoading(false);

      // 3. Mark `data` as belonging to this cache key. The write-through
      //    effect below owns ALL persistence (fetches and realtime deltas
      //    alike) — one write path, debounced, flushed on pagehide.
      if (cacheKey) paintedKeyRef.current = cacheKey;
    } catch (err) {
      reportError(err, 'DynamicWallet.Fetch_error');
      if (thisVersion === fetchVersionRef.current && isMounted.current) {
        setFetchError(true);
        setLoading(false);
      }
    }
  }, [userId, resolvedId, variant, cacheKey]);

  useEffect(() => {
    if (!resolvedId) return;
    // FRESH WINDOW: the panel just painted from data written seconds ago
    // (typically by this same widget on the page the user just left). An
    // immediate refetch would be a full resync for numbers that cannot
    // meaningfully have moved — and every later trigger (bus event, realtime
    // delta, visibility return, club switch) still fetches as before.
    if (skipNextFetchRef.current) {
      skipNextFetchRef.current = false;
      return;
    }
    fetchData();
  }, [fetchData, resolvedId]);

  // ── Realtime write-through ────────────────────────────────────────────────
  // The realtime channels below patch `data` directly (diamonds, chip
  // balance, club bank, union ledgers). Mirror every such change into the
  // device cache so the next instant paint shows the LAST number this panel
  // displayed, not the one from the last full fetch. paintedKeyRef gates the
  // one-render window after a club switch where `data` still belongs to the
  // previous key.
  useEffect(() => {
    if (loading || fetchError) return;
    if (!cacheKey || paintedKeyRef.current !== cacheKey) return;
    const payload: CachedPanel = {
      data,
      isClubInUnion,
      unionId: currentUnionId,
    };
    // Persist the viewer's role only when the caller has actually resolved it
    // (roleReady) — caching the hydration default would freeze 'player' in
    // and defeat the very gap this bridges. Union panels have a fixed row
    // set, so role is meaningless there.
    if (variant === 'club' && roleReady) payload.role = viewerRole;
    // Debounced: realtime patches arrive several times a second during play;
    // memory updates instantly, storage settles when the burst does (and is
    // force-flushed on pagehide/hidden so the final number is never lost).
    writeWalletCacheDebounced(cacheKey, payload);
  }, [
    data,
    isClubInUnion,
    currentUnionId,
    loading,
    fetchError,
    cacheKey,
    variant,
    roleReady,
    viewerRole,
  ]);

  // ── MasterBus: Refresh on ALL balance-related events (debounced 500ms) ─────
  useMasterBusSubscriptions(
    [...WALLET_BUS_EVENTS],
    () => {
      fetchData();
    },
    { debounce: 500 }
  );

  // ── Tab-visible refresh ────────────────────────────────────────────────────
  // A phone unlocked after minutes away paints the cached panel instantly and
  // the realtime channels take a moment to re-establish; this closes the gap
  // by refetching whenever the tab becomes visible after 30s+ hidden. Same
  // hook the union dashboard already uses.
  useVisibilityRefresh(fetchData);

  // ── Channel reconnect helper ──────────────────────────────────────────────
  const scheduleReconnect = useCallback(() => {
    if (!isMounted.current) return;
    const delay = BACKOFF_DELAYS[Math.min(retryCountRef.current, BACKOFF_DELAYS.length - 1)];
    console.warn(
      `[DynamicWallet] Scheduling reconnect in ${delay}ms (attempt ${retryCountRef.current + 1})`
    );
    // A repeated CHANNEL_ERROR used to stack one timer per event, each firing
    // its own full refetch — a thundering herd exactly when the connection is
    // already unhealthy. Only ever one pending reconnect.
    if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
    reconnectTimerRef.current = setTimeout(() => {
      reconnectTimerRef.current = null;
      if (!isMounted.current) return;
      retryCountRef.current++;
      fetchData(); // catch up on anything missed while disconnected
      // ...and rebuild the subscriptions. retryCountRef is reset on SUBSCRIBED,
      // so a channel that keeps failing walks up BACKOFF_DELAYS instead of
      // hammering. A channel that recovers starts from the short delay again.
      setChannelEpoch((e) => e + 1);
    }, delay);
  }, [fetchData]);

  // Clean up reconnect timer on unmount
  useEffect(() => {
    return () => {
      if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
    };
  }, []);

  // ── Realtime subscriptions — profiles, club_members, bbj_pools, agents, clubs ─
  useEffect(() => {
    if (!userId || !resolvedId) return;

    // Reset the BACKOFF only when the subscription TARGET actually changes.
    //
    // This effect now re-runs on channelEpoch (a reconnect), and an
    // unconditional reset here wiped retryCountRef on every retry — so the
    // delay was pinned at BACKOFF_DELAYS[0] (2s) forever and never escalated
    // to 4/8/16/30s. A club with a flaky realtime connection would retry every
    // two seconds indefinitely: precisely the thundering herd the comment on
    // scheduleReconnect warns about, reintroduced by making the effect
    // re-runnable. Introduced in 294b85db4 and caught auditing my own change.
    //
    // Recovery still resets the backoff — the SUBSCRIBED handler below does
    // that, which is the correct trigger: we connected, so start over.
    const subscriptionTarget = `${userId}:${resolvedId}:${currentUnionId ?? ''}`;
    if (lastSubscriptionTargetRef.current !== subscriptionTarget) {
      lastSubscriptionTargetRef.current = subscriptionTarget;
      retryCountRef.current = 0;
    }
    if (reconnectTimerRef.current) {
      clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }

    /* THE TEARDOWN LOOP. `removeChannel` -> `unsubscribe` -> the channel's own
       close handler -> `subscribe`'s callback with status CLOSED, which the
       club and union callbacks below treated as a failure and answered with
       scheduleReconnect(). That bumped channelEpoch, which re-ran this
       effect, which tore the channels down again: a full four-query refetch
       and a complete channel rebuild every two seconds for as long as the
       panel stayed mounted. The callbacks fire AFTER the cleanup has already
       cleared the pending-timer guard, so only a per-run disposed flag can
       tell "the server dropped us" from "we let go". */
    let disposed = false;

    /* And the backoff could never escalate: the main channel resubscribes
       successfully on every epoch and its SUBSCRIBED handler zeroed the retry
       count, so a club channel failing over and over stayed pinned at the
       first 2s delay. The count is only cleared once EVERY channel this run
       created reports healthy. */
    const expectsUnionChannel = Boolean(currentUnionId) && variant === 'union';
    const health = { main: false, club: false, union: !expectsUnionChannel };
    const markHealthy = (which: 'main' | 'club' | 'union') => {
      health[which] = true;
      if (health.main && health.club && health.union) retryCountRef.current = 0;
    };

    const channel = supabase
      .channel(`dynamic-wallet-${resolvedId}-${userId}-${channelTopicSuffix}`)
      // 2026-08-24: the `profiles` (id=eq.userId) and `club_members`
      // (user_id=eq.userId) listeners that used to sit here are gone.
      //
      // Both were byte-identical duplicates of listeners already carried by
      // PostgresSyncHooks' `global_db_sync:<userId>` channel - one channel per
      // signed-in user, created at sign-in and never torn down - and this widget
      // is mounted on ClubHomePage, CashierPage and ClubFinancialsPage, so it
      // was opening a second and third copy of them on the hottest screens.
      //
      // Nothing is lost, because the refresh they raced was already happening.
      // The global listeners emit DIAMOND_BALANCE_CHANGED (profiles.diamonds)
      // and CLUB_UPDATED (club_members), both of which are in WALLET_BUS_EVENTS
      // above, and useMasterBusSubscriptions already calls fetchData() on any of
      // them. So this widget refreshed TWICE per change: once by applying the
      // payload locally, once by the debounced bus refetch. Only the duplicate
      // subscription is removed; the authoritative refresh path is untouched.
      //
      // The bbj_pools listener below STAYS - it is genuinely specific to this
      // widget (it watches the pool the widget actually reads) and has no
      // equivalent in the global channel.
      .on(
        'postgres_changes',
        {
          event: 'UPDATE',
          schema: 'public',
          table: 'bbj_pools',
          // WATCH THE ROW WE READ, BY ITS ID.
          //
          // "The pool the widget actually READS" was the right idea and the
          // wrong implementation: it re-derived the scope from currentUnionId
          // instead of using the id fn_club_money_panel already hands back,
          // and that derivation is wrong on a path nobody had walked. A
          // NON-MEMBER standing in a union club's lobby gets `not_a_member`,
          // which carries the jackpot (so the banner is correct at mount) but
          // no `union_id` - so this filter fell through to
          // `club_id=eq.<club>`, i.e. that club's RETIRED pool row, which will
          // never emit again. The number was right and frozen, which is worse
          // than either being right or being absent.
          //
          // `bbj.pool_id` is the row the balance on screen came from, on every
          // path, for every viewer. Bind to it. The club_id fallback only
          // applies before the first fetch resolves.
          filter: bbjPoolId
            ? `id=eq.${bbjPoolId}`
            : currentUnionId
              ? `union_id=eq.${currentUnionId}`
              : `club_id=eq.${resolvedId}`,
        },
        (p) => {
          if (isMounted.current) {
            setData((prev) => ({
              ...prev,
              bbjPool: Number(p.new?.main_balance) || 0,
              backupBBJ: Number(p.new?.backup_balance) || 0,
            }));
          }
        }
      )
      .on(
        'postgres_changes',
        {
          event: 'UPDATE',
          schema: 'public',
          table: 'agents',
          filter: `user_id=eq.${userId}`,
        },
        (p) => {
          if (isMounted.current && p.new?.club_id === resolvedId) {
            setData((prev) => ({
              ...prev,
              agentBalance: Number(p.new.agent_wallet_balance) || 0,
              promoBalance: Number(p.new.promo_wallet_balance) || 0,
            }));
          }
        }
      )
      .subscribe((status: string, err?: Error) => {
        if (disposed) return;
        if (status === 'SUBSCRIBED') markHealthy('main');
        if (status === 'CHANNEL_ERROR') {
          if (err) reportError(err?.message || err, 'DynamicWallet._Realtime_channel_error');
          scheduleReconnect();
        }
        if (status === 'TIMED_OUT') {
          console.warn('[DynamicWallet] Realtime channel timed out');
          scheduleReconnect();
        }
        /* A close we did not ask for is a real disconnection - the main
           channel used to ignore it entirely, so its jackpot and agent
           listeners could die silently with nothing reconnecting them. */
        if (status === 'CLOSED') {
          console.warn('[DynamicWallet] main channel closed');
          scheduleReconnect();
        }
      });

    // ── Clubs RT channel: chip_treasury + union_id changes ──
    const clubChannel = supabase
      .channel(`dynamic-wallet-club-${resolvedId}-${channelTopicSuffix}`)
      .on(
        'postgres_changes',
        {
          event: 'UPDATE',
          schema: 'public',
          table: 'clubs',
          filter: `id=eq.${resolvedId}`,
        },
        (p) => {
          if (!isMounted.current) return;
          // Update club bank immediately from RT payload
          if (p.new?.chip_treasury !== undefined) {
            setData((prev) => ({
              ...prev,
              clubBank: Number(p.new.chip_treasury) || 0,
            }));
          }
          /* The club Promo Wallet is live too (2026-09-05): a union promo send
             lands in clubs.promo_balance, and the row a Club Bank role reads
             is that account, so it moves with the payload rather than waiting
             for the next full refetch. */
          if (p.new?.promo_balance !== undefined) {
            setData((prev) => ({
              ...prev,
              clubPromoWallet: Number(p.new.promo_balance) || 0,
            }));
          }
          /* Compare against what we already know, not against `p.old`.
             Postgres logical replication only fills old_record with the
             replica-identity columns - the primary key, by default - so
             `p.old.union_id` is ALWAYS undefined and this was permanently
             true: every club-bank movement fired the full four-query refetch
             that the payload apply two lines above exists to avoid. */
          const nextUnionId = (p.new?.union_id as string | null) ?? null;
          if (nextUnionId !== currentUnionIdRef.current) {
            fetchData();
          }
        }
      )
      .subscribe((status: string) => {
        if (disposed) return;
        if (status === 'SUBSCRIBED') markHealthy('club');
        // Was a bare .subscribe(): a failure here was silent, so Club Bank
        // froze on its last value with nothing reconnecting and nothing shown.
        if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
          console.warn(`[DynamicWallet] club channel ${status}`);
          scheduleReconnect();
        }
      });

    // ── Union wallets RT channel: instant union bank balance updates ──
    // Dynamic — only created if the club is in a union.
    // Uses the unionId from the most recent fetchData to listen for changes.
    let unionWalletChannel: ReturnType<typeof supabase.channel> | null = null;
    const unionId = currentUnionId;
    // WALLET SEPARATION LAW: this channel writes unionBank / unionRake /
    // unionPromo straight into state, bypassing the scoping applied in
    // fetchData. A club surface must not subscribe to it at all — otherwise a
    // single union_wallets UPDATE would refill the very fields fetchData
    // deliberately zeroed.
    if (unionId && variant === 'union') {
      unionWalletChannel = supabase
        .channel(`dynamic-wallet-union-${unionId}-${channelTopicSuffix}`)
        .on(
          'postgres_changes',
          {
            event: 'UPDATE',
            schema: 'public',
            table: 'union_wallets',
            filter: `union_id=eq.${unionId}`,
          },
          (p) => {
            if (isMounted.current && p.new) {
              // Mirror every union ledger the panel shows, not just the bank.
              // Previously rake_wallet and promo_wallet sat on their first
              // fetched value while rake poured in all week.
              setData((prev) => ({
                ...prev,
                unionBank:
                  p.new.chip_balance !== undefined
                    ? Number(p.new.chip_balance) || 0
                    : prev.unionBank,
                unionRake:
                  p.new.rake_wallet !== undefined ? Number(p.new.rake_wallet) || 0 : prev.unionRake,
                unionPromo:
                  p.new.promo_wallet !== undefined
                    ? Number(p.new.promo_wallet) || 0
                    : prev.unionPromo,
              }));
            }
          }
        )
        .subscribe((status: string) => {
          if (disposed) return;
          if (status === 'SUBSCRIBED') markHealthy('union');
          // Same as the club channel: silent failure froze Union Bank, Rake
          // Treasury and Union Promo with no recovery path.
          if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
            console.warn(`[DynamicWallet] union channel ${status}`);
            scheduleReconnect();
          }
        });
    }

    return () => {
      disposed = true;
      supabase.removeChannel(channel);
      supabase.removeChannel(clubChannel);
      if (unionWalletChannel) supabase.removeChannel(unionWalletChannel);
    };
    // currentUnionId (state, not the ref) so a union->union club switch rebinds.
    // bbjPoolId too: the jackpot filter binds to that row by id, so the first
    // fetch resolving it has to rebind the channel or the subscription stays on
    // the pre-fetch club_id fallback for the life of the mount.
  }, [userId, resolvedId, currentUnionId, bbjPoolId, channelEpoch, variant]);

  // ── Role-specific row config ───────────────────────────────────────────────
  // Union figures come from union_wallets, which RLS restricts to union
  // owners/admins. If we are not allowed to read them we must say so rather
  // than print 0.00 — a wrong number on a money surface is worse than none.
  const unionFiguresKnown = data.scope === 'union';
  const closeDay = data.nextCloseAt
    ? new Date(data.nextCloseAt).toLocaleDateString('en-US', {
        weekday: 'short',
        day: 'numeric',
        month: 'short',
      })
    : 'Monday';

  type WalletRow = {
    key: string;
    label: string;
    icon: WalletIconName;
    value: number;
    hint?: string;
    known?: boolean;
    /** Makes the row a button. Only the Club Bank has one. */
    onOpen?: () => void;
  };

  // ── Club rows: the viewer's ROLE decides which of these exist ─────────────
  // Dan 2026-08-23. A player gets one row. An agent gets three. Only the four
  // bank roles get the Club Bank, and only a standalone club has a rake
  // treasury of its own to show beneath it. The rule is in walletRows.ts.
  const CLUB_ROW_BY_KEY: Record<WalletRowKey, WalletRow> = {
    player_wallet: {
      key: 'player_wallet',
      // Dan 2026-08-21: named for what it IS across every role — the wallet
      // you play out of. (Was "Chip Balance".) Dan 2026-08-23: the "The Wallet
      // You Play From" hint is gone — self-explanatory, and it was the only
      // row carrying one on a club panel.
      label: 'Player Wallet',
      icon: 'chip',
      value: animPlayerWallet,
      // Dan 2026-08-24: "PLAYER WALLET NEEDS TO BE FULLY CLICKABLE AND OPEN TO
      // SEE ALL TRANSACTIONS AND OTHER AVAILABLE DATA WHEN CLICKED."
      onOpen: onOpenPlayerWallet,
    },
    agent_wallet: {
      key: 'agent_wallet',
      label: 'Agent Wallet',
      icon: 'agent',
      value: animAgent,
      onOpen: onOpenAgentWallet,
    },
    promo_wallet: {
      key: 'promo_wallet',
      label: 'Promo Wallet',
      icon: 'promo',
      value: animPromo,
      // The BBJ promo slice accrues inside the pool and is swept across every
      // few minutes, so a club's promo balance steps rather than streams.
      // Saying so stops it reading as "not being funded" - which is exactly
      // how it read while the row was showing the wrong account entirely.
      // A club inside a union banks its BBJ slice in the UNION wallet; its own
      // pot is what the union promo wallet pays into (Dan 2026-09-05). Only a
      // standalone club's pot is fed by the sweep.
      hint: clubPromoIsClubMoney
        ? isClubInUnion
          ? 'Funded By The Union Promo Wallet'
          : '25% BBJ Slice · Swept Every 5 Min'
        : undefined,
      onOpen: onOpenPromoWallet,
    },
    club_bank: {
      key: 'club_bank',
      label: 'Club Bank',
      icon: 'bank',
      value: animClubBank,
      hint: undefined,
      onOpen: onOpenClubBank,
    },
    spins_wallet: {
      key: 'spins_wallet',
      // Named for what it IS to an owner: the wallet the Spin multipliers are
      // paid out of. NOT the union dashboard's "Spin Reserve" tile, which is
      // undeployed capital waiting to be seeded -- see useSpinsWallet.
      label: 'Spins Treasury',
      icon: 'treasury',
      value: animSpins,
      known: spins.state !== null,
      hint: 'Funds This Club’s Spin Multipliers',
      onOpen: () => onOpenClubSpins?.(spins.balance || 0),
    },
    rake_treasury: {
      key: 'rake_treasury',
      label: 'Rake Treasury',
      icon: 'treasury',
      value: animClubRake,
      // A standalone club keeps its own rake. `null` from the panel means the
      // account is not applicable or not readable — "-" beats a made-up zero.
      known: data.clubRakeTreasury !== null,
      hint: 'This Club Keeps Its Own Rake',
      onOpen: () => onOpenClubRake?.(data.clubRakeTreasury || 0),
    },
    backup_bbj: {
      key: 'backup_bbj',
      label: 'BBJ Backup Wallet',
      icon: 'reserve',
      value: animBackupBBJ,
      known: data.backupBBJ !== null,
      hint: 'Next Jackpot Seed',
      onOpen: () => onOpenUnionBackupBBJ?.(data.backupBBJ || 0),
    },
  };

  const UNION_ROWS: WalletRow[] = [
    {
      key: 'union_bank',
      label: 'Union Bank',

      icon: 'bank',
      value: animUnionBank,
      known: unionFiguresKnown,
      hint: unionFiguresKnown ? 'Send Or Pull Chips From Clubs & Members' : 'Union Admins Only',
      onOpen: () => onOpenUnionBank?.(data.unionBank || 0),
    },
    {
      key: 'union_rake',
      label: 'Rake Treasury',
      icon: 'treasury',
      value: animUnionRake,
      known: unionFiguresKnown,
      hint: unionFiguresKnown
        ? `Held In Trust · ${formatBalance(data.projectedClubsShare)} To Clubs ${closeDay}`
        : 'Union Admins Only',
      onOpen: () => onOpenUnionRake?.(data.unionRake || 0),
    },
    {
      key: 'union_backup_bbj',
      label: 'BBJ Backup Wallet',
      icon: 'reserve',
      value: animBackupBBJ,
      known: unionFiguresKnown,
      hint: 'Next Jackpot Seed',
      onOpen: () => onOpenUnionBackupBBJ?.(data.backupBBJ || 0),
    },
    {
      key: 'union_promo',
      label: 'Promo Wallet',
      icon: 'promo',
      value: animPromo,
      known: unionFiguresKnown,
      // The 25% promo slice accrues inside the BBJ pool and is swept across
      // to this wallet every ~5 minutes, so it steps rather than streams.
      // Saying so stops it reading as "not being funded".
      hint: unionFiguresKnown ? '25% BBJ Slice · Swept Every 5 Min' : undefined,
      onOpen: () => onOpenUnionPromo?.(data.unionPromo || 0),
    },
    {
      key: 'union_spins',
      label: 'Spins Treasury',
      icon: 'treasury',
      value: animUnionSpins,
      known: unionFiguresKnown,
      // Say WHERE it is, not just how much. An owner reading a single number
      // cannot tell seeded capital from idle capital, and the two behave
      // completely differently: deployed money is already at risk in a pool,
      // idle money is not.
      hint: unionFiguresKnown
        ? `${formatBalance(data.unionSpinDeployed)} Deployed · ${formatBalance(data.unionSpinIdle)} Idle`
        : undefined,
      onOpen: () => onOpenUnionSpins?.(data.unionSpinIdle || 0),
    },
  ];

  // Which role picks the row set: the live role once the caller has resolved
  // it; the device-cached last-known role while it is still hydrating. The
  // cached role was only ever written from a roleReady render, so it is a
  // last HONEST answer, not the 'player' hydration default the visibility
  // law was written against. Live role always wins the moment it arrives.
  const rowRole: ClubRole = roleReady ? viewerRole : (cachedRole ?? viewerRole);

  const rows: WalletRow[] =
    effectiveVariant === 'union'
      ? compactLobby
        ? showAllLobbyWallets
          ? UNION_ROWS
          : UNION_ROWS.filter((row) => row.key === 'union_bank' || row.key === 'union_rake')
        : UNION_ROWS
      : (compactLobby
          ? showAllLobbyWallets
            ? clubWalletRows(rowRole, {
                standalone: !isClubInUnion,
                // A funded/configured reserve is a wallet even while Spins is
                // temporarily inactive. Hiding it made real club money vanish
                // from the owner's wallet panel.
                spinsActive: spins.state !== null,
              })
            : clubLobbyWalletRows(rowRole)
          : clubWalletRows(rowRole, {
              standalone: !isClubInUnion,
              spinsActive: spins.state !== null,
            })
        ).map((k) => CLUB_ROW_BY_KEY[k]);

  const hasStandaloneClubBackup =
    effectiveVariant === 'club' && !isClubInUnion && data.backupBBJ > 0;
  const rendersSeparateBackup =
    hasStandaloneClubBackup && !rows.some((row) => row.key === 'backup_bbj');
  const visibleWalletCount = rows.length + 1 + (rendersSeparateBackup ? 1 : 0);

  useEffect(() => {
    onVisibleWalletCountChange?.(visibleWalletCount);
  }, [onVisibleWalletCountChange, visibleWalletCount]);

  const compactLabel = (row: WalletRow) =>
    compactLobby && row.key === 'club_bank' ? 'Club Balance' : row.label;

  const settledRowValue = (key: string): number | null => {
    switch (key) {
      case 'player_wallet':
        return data.chipBalance;
      case 'agent_wallet':
        return data.agentBalance;
      case 'club_bank':
        return data.clubBank;
      case 'promo_wallet':
        return clubPromoIsClubMoney ? data.clubPromoWallet : data.promoBalance;
      case 'spins_wallet':
        return spins.balance;
      case 'rake_treasury':
        return data.clubRakeTreasury;
      case 'backup_bbj':
      case 'union_backup_bbj':
        return data.backupBBJ;
      case 'union_bank':
        return data.unionBank;
      case 'union_rake':
        return data.unionRake;
      case 'union_promo':
        return data.unionPromo;
      case 'union_spins':
        return data.unionSpinTreasury;
      default:
        return null;
    }
  };

  // ── Keyboard handler for BBJ banner (accessibility) ─────────────────────────
  const bbjClickable = Boolean(onOpenBBJ);
  const handleBbjKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      onOpenBBJ?.();
    }
  };

  // ── Loading skeleton ───────────────────────────────────────────────────────
  // `!roleReady` counts as loading: which ROWS exist is as much a part of this
  // panel's answer as the numbers in them, and showing the wrong set first is
  // worse than showing none for another beat. Exception: a device-cached
  // last-known role (written only from a roleReady render) answers the row
  // question honestly enough to paint now — the live role corrects it on the
  // rare occasion it actually changed.
  if (loading || (effectiveVariant === 'club' && !roleReady && cachedRole === null)) {
    return (
      <div
        className={`dw dw--loading${compactLobby ? ' dw--lobby-board' : ''}`}
        role="region"
        aria-busy="true"
        aria-label="Loading Wallet"
      >
        {showBBJ && <div className="dw__shimmer dw__shimmer--bbj" />}
        <div className={`dw__rows${compactLobby ? ' dw__rows--count-3' : ''}`}>
          {Array.from({ length: compactLobby ? 3 : 4 }, (_, index) => (
            <div key={index} className="dw__shimmer dw__shimmer--row" />
          ))}
        </div>
      </div>
    );
  }

  return (
    <div
      className={`dw dw--${effectiveVariant}${compactLobby ? ' dw--lobby-board' : ''}`}
      role="region"
      aria-label="Wallet Balances"
    >
      {/* ── Error indicator — subtle, non-blocking ──────────────────────── */}
      {fetchError && (
        <button
          className="dw__error-badge"
          onClick={() => {
            setFetchError(false);
            fetchData();
          }}
          aria-label="Retry Loading Wallet Data"
          title="Failed To Load - Tap To Retry"
        >
          Balances Unavailable · Retry
        </button>
      )}

      {/* ── BBJ Banner — suppressed where a dedicated ticker already owns it ── */}
      {showBBJ && (
        <div
          className="dw__bbj"
          /* Only a button when there is something to open. onOpenBBJ is
             optional, and this was unconditionally focusable with
             role="button" - offering keyboard and screen-reader users a
             control that does nothing on every surface that omits it. */
          onClick={bbjClickable ? onOpenBBJ : undefined}
          onKeyDown={bbjClickable ? handleBbjKeyDown : undefined}
          role={bbjClickable ? 'button' : undefined}
          tabIndex={bbjClickable ? 0 : undefined}
          /* The SETTLED pool, not the animating one. A jackpot counting up
             from zero reads "no pool" on its first frame and then flips, so
             the label announced something that was never true. */
          aria-label={`Bad Beat Jackpot: ${data.bbjPool === 0 ? 'No Pool' : formatBalance(data.bbjPool)}`}
        >
          <ClubBBJShell />
          <span className="dw__bbj-label">BAD BEAT JACKPOT</span>
          <span className="dw__bbj-amount">
            {data.bbjPool === 0 ? '-' : formatBalance(animBBJ)}
          </span>
        </div>
      )}

      {/* ── Wallet Rows ───────────────────────────────────────────────────── */}
      {/* THE LIVE REGION. `aria-live` cannot go on the values themselves -
          they animate at 60fps and would flood a screen reader - so it goes
          on a hidden mirror that only ever renders SETTLED figures from
          `data`. Before this the container carried aria-live="off" and a
          blind player was never told their balance had changed at all. */}
      <span className="dw__sr-live" aria-live="polite" aria-atomic="true">
        {`Diamond Wallet ${formatDiamonds(data.diamonds)}. ${rows
          .map((row) => {
            const settled = settledRowValue(row.key);
            return `${compactLabel(row)} ${settled === null ? 'unavailable' : formatBalance(settled)}`;
          })
          .join('. ')}.`}
      </span>

      <div className={`dw__rows dw__rows--count-${rows.length + 1}`}>
        {/* Diamond Balance */}
        <div
          data-wallet-key="diamonds"
          className={`dw__row dw__row--diamond dw__row--wallet-art${compactLobby && onBuyDiamonds ? ' dw__row--actionable' : ''}`}
          onClick={compactLobby ? onBuyDiamonds : undefined}
          onKeyDown={
            compactLobby && onBuyDiamonds
              ? (e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    onBuyDiamonds();
                  }
                }
              : undefined
          }
          role={compactLobby && onBuyDiamonds ? 'button' : undefined}
          tabIndex={compactLobby && onBuyDiamonds ? 0 : undefined}
          aria-label={compactLobby && onBuyDiamonds ? 'Open Diamond Wallet' : undefined}
        >
          <ClubWalletShell kind="diamonds" />
          <span className="dw__row-icon" aria-hidden="true">
            <WalletIcon name="diamond" />
          </span>
          <span className="dw__row-label">{compactLobby ? 'Diamond Wallet' : 'Diamonds'}</span>
          <span className="dw__row-value">{formatDiamonds(animDiamonds)}</span>
          {onBuyDiamonds && !compactLobby && (
            <button
              className="dw__plus"
              onClick={(e) => {
                e.stopPropagation();
                onBuyDiamonds();
              }}
              aria-label="Buy Diamonds"
            >
              +
            </button>
          )}
        </div>

        {/* Role-specific wallet rows.
            The Club Bank row is a button: "if they click on Club Bank, that
            should open the Club Bank Cashier" (Dan 2026-08-23). The Player
            Wallet row is a button too: it opens the member's own statement
            (Dan 2026-08-24). The rest are balances, not controls. */}
        {rows.map((row, idx) => (
          <div
            key={row.key}
            data-wallet-key={row.key}
            className={
              `dw__row dw__row--wallet dw__row--wallet-art` +
              (idx === 0 ? ' dw__row--primary' : '') +
              (row.onOpen ? ' dw__row--actionable' : '')
            }
            onClick={row.onOpen}
            onKeyDown={
              row.onOpen
                ? (e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      row.onOpen!();
                    }
                  }
                : undefined
            }
            role={row.onOpen ? 'button' : undefined}
            tabIndex={row.onOpen ? 0 : undefined}
            aria-label={row.onOpen ? `Open ${row.label}` : undefined}
          >
            <ClubWalletShell kind={row.key as ClubWalletArtworkKind} />
            <span className="dw__row-icon" aria-hidden="true">
              <WalletIcon name={row.icon} />
            </span>
            <span className="dw__row-label">
              {compactLabel(row)}
              {row.hint && <span className="dw__row-hint">{row.hint}</span>}
            </span>
            <span className="dw__row-value">
              {row.known === false ? '-' : formatBalance(row.value)}
            </span>
            {row.onOpen && (
              <span className="dw__row-chevron" aria-hidden="true">
                &rsaquo;
              </span>
            )}
          </div>
        ))}

        {/* Backup BBJ.
            CLUB PANEL ONLY, and only for a STANDALONE club, where the reserve
            genuinely belongs to that club. A club inside a union is served the
            UNION's backup figure by fn_club_money_panel, so rendering it here
            would put union money back on a club screen through the side door —
            the same leak as Union Bank, one row further down.

            2026-08-25: `effectiveVariant === 'club'` added. The comment above
            this block used to claim "Union panel: always", but UNION_ROWS
            ALREADY carries a `union_backup_bbj` row driven by the very same
            `animBackupBBJ`. So a union panel pointed at a standalone club
            (in_union false, which is also the reset value after every club
            switch and the value a REFUSED panel leaves in place) rendered
            "BBJ Backup Wallet" and "Backup BBJ" one above the other, same
            figure, twice. Two live copies of one number on a money surface is
            the duplication the BBJ banner's own showBBJ opt-out exists to
            prevent. The union panel keeps its row; this one is the club's. */}
        {rendersSeparateBackup && (
          <div
            className="dw__row dw__row--backup-bbj dw__row--wallet-art"
            data-wallet-key="backup_bbj"
          >
            <ClubWalletShell kind="backup_bbj" />
            <span className="dw__row-icon" aria-hidden="true">
              <WalletIcon name="reserve" />
            </span>
            <span className="dw__row-label">
              Backup BBJ
              <span className="dw__row-hint">Reserve · Reseeds Main After A Hit</span>
            </span>
            <span className="dw__row-value">
              {data.backupBBJ === 0 ? '-' : formatBalance(animBackupBBJ)}
            </span>
          </div>
        )}
      </div>
    </div>
  );
}
