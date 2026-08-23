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
import { clubWalletRows, type WalletRowKey } from './walletRows';
import { useSpinsWallet } from '../../hooks/useSpinsWallet';
import './DynamicWallet.css';
import { reportError } from '../../utils/errorReporter';

// All bus events that should trigger a wallet refresh
const WALLET_BUS_EVENTS = [
  'BALANCE_UPDATED',
  'DIAMOND_BALANCE_CHANGED',
  'WALLET_REFRESHED',
  'CHIPS_ADDED',
  'CHIPS_WITHDRAWN',
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
  onBuyDiamonds?: () => void;
  /** Opens the Club Bank Cashier. Only ever wired on the four bank roles. */
  onOpenClubBank?: () => void;
  onOpenPromoWallet?: () => void;
  onOpenAgentWallet?: () => void;
  onOpenPlayerWallet?: () => void;
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

// ═══════════════════════════════════════════════════════════════════════════════
// ANIMATED COUNTER — preserves fractional precision (2 decimal places)
// ═══════════════════════════════════════════════════════════════════════════════

function useAnimatedCounter(target: number, duration = 400): number {
  const [value, setValue] = useState(target);
  const rafId = useRef<number | null>(null);
  const currentValueRef = useRef(value);
  currentValueRef.current = value;

  useEffect(() => {
    const start = currentValueRef.current;
    const diff = target - start;
    if (Math.abs(diff) < 0.01) {
      setValue(target);
      return;
    }

    const startTime = performance.now();
    const animate = (now: number) => {
      const elapsed = now - startTime;
      const progress = Math.min(elapsed / duration, 1);
      const eased = 1 - Math.pow(1 - progress, 3);
      // Preserve 2-decimal precision instead of Math.round (which loses cents)
      const interpolated = start + diff * eased;
      setValue(Math.round(interpolated * 100) / 100);
      if (progress < 1) rafId.current = requestAnimationFrame(animate);
    };
    rafId.current = requestAnimationFrame(animate);
    return () => {
      if (rafId.current) cancelAnimationFrame(rafId.current);
    };
  }, [target, duration]);

  return value;
}

// ═══════════════════════════════════════════════════════════════════════════════
// FORMAT NUMBER
// ═══════════════════════════════════════════════════════════════════════════════

function formatBalance(num: number): string {
  // Math.abs() was applied here, so an agent wallet of -25,000 rendered
  // identically to +25,000 — the sign of a debt was invisible on a money
  // surface. Negatives are now shown as negatives.
  const safe = Number.isFinite(num) ? num : 0;
  return safe.toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
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
  onBuyDiamonds,
  onOpenClubBank,
  onOpenPromoWallet,
  onOpenAgentWallet,
  onOpenPlayerWallet,
  onOpenBBJ,
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
    boot.entry ? { ...INITIAL_WALLET_DATA, ...boot.entry.data } : INITIAL_WALLET_DATA
  );
  const [loading, setLoading] = useState(() => !boot.entry);
  const [fetchError, setFetchError] = useState(false);
  const [isClubInUnion, setIsClubInUnion] = useState(() => boot.entry?.isClubInUnion ?? false);
  const isMounted = useIsMounted();

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
      setData({ ...INITIAL_WALLET_DATA, ...cached.data });
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
    // Union promo is the swept 25% BBJ slice in union_wallets, not the
    // club-agent promo wallet.
    effectiveVariant === 'union' ? data.unionPromo : data.promoBalance
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
  const spins = useSpinsWallet(clubId, variant !== 'union' && !isClubInUnion);
  const animSpins = useAnimatedCounter(spins.balance);
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
      label: 'Spins Wallet',
      icon: 'treasury',
      value: animSpins,
      known: spins.state !== null,
      hint: 'Funds This Club’s Spin Multipliers',
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
    },
  };

  const UNION_ROWS: WalletRow[] = [
    {
      key: 'union_rake',
      label: 'Rake Treasury',
      icon: 'treasury',
      value: animUnionRake,
      known: unionFiguresKnown,
      hint: unionFiguresKnown
        ? `Held In Trust · ${formatBalance(data.projectedClubsShare)} To Clubs ${closeDay}`
        : 'Union Admins Only',
    },
    {
      key: 'union_backup_bbj',
      label: 'BBJ Backup Wallet',
      icon: 'reserve',
      value: animBackupBBJ,
      known: unionFiguresKnown,
      hint: 'Next Jackpot Seed',
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
      ? UNION_ROWS
      : clubWalletRows(rowRole, {
          standalone: !isClubInUnion,
          spinsActive: spins.active,
        }).map((k) => CLUB_ROW_BY_KEY[k]);

  // ── Keyboard handler for BBJ banner (accessibility) ─────────────────────────
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
      <div className="dw dw--loading" aria-busy="true" aria-label="Loading wallet">
        <div className="dw__shimmer dw__shimmer--bbj" />
        <div className="dw__rows">
          <div className="dw__shimmer dw__shimmer--row" />
          <div className="dw__shimmer dw__shimmer--row" />
          <div className="dw__shimmer dw__shimmer--row" />
          <div className="dw__shimmer dw__shimmer--row" />
        </div>
      </div>
    );
  }

  return (
    <div className={`dw dw--${effectiveVariant}`} aria-label="Wallet balances">
      {/* ── Error indicator — subtle, non-blocking ──────────────────────── */}
      {fetchError && (
        <button
          className="dw__error-badge"
          onClick={() => {
            setFetchError(false);
            fetchData();
          }}
          aria-label="Retry loading wallet data"
          title="Failed to load - tap to retry"
        >
          Balances Unavailable · Retry
        </button>
      )}

      {/* ── BBJ Banner — suppressed where a dedicated ticker already owns it ── */}
      {showBBJ && (
        <div
          className="dw__bbj"
          onClick={onOpenBBJ}
          onKeyDown={handleBbjKeyDown}
          role="button"
          tabIndex={0}
          aria-label={`Bad Beat Jackpot: ${animBBJ === 0 ? 'no pool' : formatBalance(animBBJ)}`}
        >
          <span className="dw__bbj-label">BAD BEAT JACKPOT</span>
          <span className="dw__bbj-amount">{animBBJ === 0 ? '-' : formatBalance(animBBJ)}</span>
        </div>
      )}

      {/* ── Wallet Rows ───────────────────────────────────────────────────── */}
      <div className="dw__rows" aria-live="off">
        {/* Diamond Balance */}
        <div className="dw__row dw__row--diamond">
          <span className="dw__row-icon" aria-hidden="true">
            <WalletIcon name="diamond" />
          </span>
          <span className="dw__row-label">Diamonds</span>
          <span className="dw__row-value">{formatBalance(animDiamonds)}</span>
          {onBuyDiamonds && (
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
            className={
              `dw__row dw__row--wallet` +
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
            <span className="dw__row-icon" aria-hidden="true">
              <WalletIcon name={row.icon} />
            </span>
            <span className="dw__row-label">
              {row.label}
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
            Union panel: always (it is a union-level reserve).
            Club panel: ONLY for a standalone club, where the reserve genuinely
            belongs to that club. A club inside a union is served the UNION's
            backup figure by fn_club_money_panel, so rendering it here would
            put union money back on a club screen through the side door —
            the same leak as Union Bank, one row further down. */}
        {!isClubInUnion && data.backupBBJ > 0 && (
          <div className="dw__row dw__row--backup-bbj">
            <span className="dw__row-icon" aria-hidden="true">
              <WalletIcon name="reserve" />
            </span>
            <span className="dw__row-label">
              Backup BBJ
              <span className="dw__row-hint">Reserve · Reseeds Main After A Hit</span>
            </span>
            <span className="dw__row-value">
              {animBackupBBJ === 0 ? '-' : formatBalance(animBackupBBJ)}
            </span>
          </div>
        )}
      </div>
    </div>
  );
}
