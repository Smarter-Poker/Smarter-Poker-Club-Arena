/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  DYNAMIC WALLET — Compact Premium-Style Inline Display
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Compact wallet display positioned below the club card.
 * Shows BBJ banner + role-specific wallet balance rows with action buttons.
 *
 * Three variants, chosen EXPLICITLY by the caller — never inferred:
 *   'player' — Chip Balance, Agent Wallet, Promo Wallet
 *   'owner'  — Club Bank, Agent Wallet, Promo Wallet
 *   'union'  — Union Bank, Rake Treasury, Clubs Wallet, Promo Wallet, Backup BBJ
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
 *   - Mint button gated to owner/union only
 */

import { useState, useEffect, useRef, useCallback } from 'react';
import { WalletIcon, type WalletIconName } from '../icons/LobbyIcons';
import { useIsMounted } from '../../hooks/useIsMounted';
import { useMasterBusSubscriptions } from '../../hooks/useMasterBusSubscription';
import { supabase } from '../../lib/supabase';
import { resolveClubUUID } from '../../utils/clubIdResolver';
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

// ═══════════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════════

type WalletVariant = 'player' | 'owner' | 'union';

interface DynamicWalletProps {
  userId: string;
  clubId: string;
  variant?: WalletVariant;
  /**
   * Render the BBJ banner. Default true. The club lobby passes false because
   * BBJTicker already owns the jackpot up there — two live copies of the same
   * number, animating on two separate subscriptions, is the kind of duplication
   * that eventually shows two DIFFERENT figures on one screen.
   */
  showBBJ?: boolean;
  onBuyDiamonds?: () => void;
  onMintChips?: () => void;
  onOpenBBJ?: () => void;
}

interface WalletData {
  diamonds: number;
  bbjPool: number;
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

export default function DynamicWallet({
  userId,
  clubId,
  variant = 'player',
  showBBJ = true,
  onBuyDiamonds,
  onMintChips,
  onOpenBBJ,
}: DynamicWalletProps) {
  const [data, setData] = useState<WalletData>({
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
    clubsWallet: 0,
    clubProjectedRakeback: 0,
    projectedClubsShare: 0,
    nextCloseAt: null,
    scope: null,
  });
  const [loading, setLoading] = useState(true);
  const [fetchError, setFetchError] = useState(false);
  const [isClubInUnion, setIsClubInUnion] = useState(false);
  const isMounted = useIsMounted();

  // Resolved UUID — DynamicWallet now handles resolution internally
  const [resolvedId, setResolvedId] = useState<string | null>(null);
  // Fetch version counter to discard stale responses on rapid club switching
  const fetchVersionRef = useRef(0);
  // Tracked union_id for union_wallets RT channel
  const currentUnionIdRef = useRef<string | null>(null);
  // Mirrored into state because the realtime effect below binds its BBJ and
  // union_wallets filters to this value. A ref cannot be a dependency, so the
  // effect previously keyed on the `isClubInUnion` BOOLEAN — which does not
  // change when moving from one union club to ANOTHER union club, leaving both
  // channels subscribed to the PREVIOUS union. The panel then showed a live
  // Bad Beat Jackpot and Union Bank belonging to the club you just left.
  const [currentUnionId, setCurrentUnionId] = useState<string | null>(null);
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

  useEffect(() => {
    // Reset before resolving. Without this, `resolvedId` kept pointing at the
    // OLD club while resolveClubUUID was in flight, `loading` stayed false
    // (it is only ever set false after the first fetch) and `data` was never
    // cleared — so the previous club's Chip Balance, Club Bank and BBJ
    // rendered under the new club's header with no skeleton.
    setResolvedId(null);
    setCurrentUnionId(null);
    setFetchError(false);
    setLoading(true);
    if (!clubId) {
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
  }, [clubId]);

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
  // HERE. The surface decides: club surfaces pass 'player'/'owner', union
  // surfaces pass 'union'. Nothing infers it. Do not reintroduce a promotion
  // rule of any shape.
  const effectiveVariant: WalletVariant = variant;

  // Animated values
  const animDiamonds = useAnimatedCounter(data.diamonds);
  const animBBJ = useAnimatedCounter(data.bbjPool);
  const animRow1 = useAnimatedCounter(
    effectiveVariant === 'union'
      ? data.unionBank
      : effectiveVariant === 'owner'
        ? data.clubBank
        : data.chipBalance
  );
  const animRow2 = useAnimatedCounter(
    // Union: the combined operational banks of the member clubs. This used to
    // read the SELECTED club's own bank, which is not a union-level figure at
    // all — it read 0.00 for a union whose clubs held 800k.
    effectiveVariant === 'union' ? data.clubsWallet : data.agentBalance
  );
  const animRow3 = useAnimatedCounter(
    // Union promo is the swept 25% BBJ slice in union_wallets, not the
    // club-agent promo wallet.
    effectiveVariant === 'union' ? data.unionPromo : data.promoBalance
  );
  const animBackupBBJ = useAnimatedCounter(data.backupBBJ);
  // Dan 2026-08-21: "even club owners need a player wallet, that's the only
  // wallet they can play out of." The owner stack now leads with the viewer's
  // own per-club chip balance — the money that actually buys into games.
  const animPlayerWallet = useAnimatedCounter(data.chipBalance);
  const animTreasury = useAnimatedCounter(
    effectiveVariant === 'union' ? data.unionRake : data.clubTreasury
  );

  // ── Fetch data — uses resolvedId (UUID) for all Supabase queries ───────────
  const fetchData = useCallback(async () => {
    if (!userId || !resolvedId) return;

    // Increment version — any in-flight fetch with a lower version is stale
    const thisVersion = ++fetchVersionRef.current;

    try {
      // fn_club_money_panel replaces three separate reads (bbj_pools, clubs,
      // union_wallets) with one permission-aware server call. It resolves the
      // BBJ pool union-first exactly as the engine banks it, and returns a
      // `scope` saying which figures the caller may actually see — so the
      // panel can render "—" for what it is not allowed to read instead of a
      // fabricated 0.00. It also removes the second, serial round trip.
      const [profileRes, memberRes, agentRes, panelRes] = await Promise.all([
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
      ]);

      // Discard stale response if a newer fetch has started
      if (thisVersion !== fetchVersionRef.current || !isMounted.current) return;

      // Defensive unwrap: a jsonb-returning RPC hands back the object, but a
      // TABLE-returning one hands back an array. Reading `.x` off the array
      // was exactly how Backup BBJ came to render 0.00 once before.
      const panel = ((Array.isArray(panelRes.data) ? panelRes.data[0] : panelRes.data) ??
        {}) as Record<string, unknown>;
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

      setData({
        diamonds: Number(profileRes.data?.diamonds) || 0,
        chipBalance: Number(memberRes.data?.chip_balance) || 0,
        promoBalance: Number(agentRes.data?.promo_wallet_balance) || 0,
        bbjPool: num(bbj.main),
        backupBBJ: num(bbj.backup),
        agentBalance: Number(agentRes.data?.agent_wallet_balance) || 0,
        clubBank: num(panel.club_treasury),
        clubTreasury: num(panel.club_treasury),
        unionBank: unionScoped ? num(panel.union_bank) : 0,
        unionRake: unionScoped ? num(panel.rake_treasury) : 0,
        unionPromo: unionScoped ? num(panel.union_promo) : 0,
        clubsWallet: unionScoped ? num(panel.clubs_wallet) : 0,
        clubProjectedRakeback: num(panel.club_projected_rakeback),
        projectedClubsShare: unionScoped ? num(panel.projected_clubs_share) : 0,
        nextCloseAt: (panel.next_close_at as string | null) ?? null,
        scope: (panel.scope as WalletData['scope']) ?? null,
      });
      setIsClubInUnion(Boolean(panel.in_union));
      setFetchError(false);
      setLoading(false);
    } catch (err) {
      reportError(err, 'DynamicWallet.Fetch_error');
      if (thisVersion === fetchVersionRef.current && isMounted.current) {
        setFetchError(true);
        setLoading(false);
      }
    }
  }, [userId, resolvedId, variant]);

  useEffect(() => {
    if (resolvedId) fetchData();
  }, [fetchData, resolvedId]);

  // ── MasterBus: Refresh on ALL balance-related events (debounced 500ms) ─────
  useMasterBusSubscriptions(
    [...WALLET_BUS_EVENTS],
    () => {
      fetchData();
    },
    { debounce: 500 }
  );

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

    const channel = supabase
      .channel(`dynamic-wallet-${resolvedId}-${userId}`)
      .on(
        'postgres_changes',
        {
          event: 'UPDATE',
          schema: 'public',
          table: 'profiles',
          filter: `id=eq.${userId}`,
        },
        (p) => {
          if (isMounted.current && p.new?.diamonds !== undefined) {
            setData((prev) => ({ ...prev, diamonds: Number(p.new.diamonds) || 0 }));
          }
        }
      )
      .on(
        'postgres_changes',
        {
          event: 'UPDATE',
          schema: 'public',
          table: 'club_members',
          filter: `user_id=eq.${userId}`,
        },
        (p) => {
          if (isMounted.current && p.new?.club_id === resolvedId) {
            setData((prev) => ({
              ...prev,
              chipBalance: Number(p.new.chip_balance) || 0,
            }));
          }
        }
      )
      .on(
        'postgres_changes',
        {
          event: 'UPDATE',
          schema: 'public',
          table: 'bbj_pools',
          // Must watch the pool the widget actually READS. Filtering by
          // club_id for a union club subscribes to that club's own retired
          // pool row — a row that will never change again — so the jackpot
          // would freeze on screen. currentUnionIdRef is set by fetchData and
          // this effect re-runs when isClubInUnion flips.
          filter: currentUnionId ? `union_id=eq.${currentUnionId}` : `club_id=eq.${resolvedId}`,
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
        if (status === 'SUBSCRIBED') {
          // Reset retry count on successful subscription
          retryCountRef.current = 0;
        }
        if (status === 'CHANNEL_ERROR') {
          if (err) reportError(err?.message || err, 'DynamicWallet._Realtime_channel_error');
          scheduleReconnect();
        }
        if (status === 'TIMED_OUT') {
          console.warn('[DynamicWallet] Realtime channel timed out');
          scheduleReconnect();
        }
      });

    // ── Clubs RT channel: chip_treasury + union_id changes ──
    const clubChannel = supabase
      .channel(`dynamic-wallet-club-${resolvedId}`)
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
          // If union_id changed (club joined or left a union), do a full refetch
          // to update unionBank and isClubInUnion
          if (p.old?.union_id !== p.new?.union_id) {
            fetchData();
          }
        }
      )
      .subscribe((status: string) => {
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
        .channel(`dynamic-wallet-union-${unionId}`)
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
          // Same as the club channel: silent failure froze Union Bank, Rake
          // Treasury and Union Promo with no recovery path.
          if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
            console.warn(`[DynamicWallet] union channel ${status}`);
            scheduleReconnect();
          }
        });
    }

    return () => {
      supabase.removeChannel(channel);
      supabase.removeChannel(clubChannel);
      if (unionWalletChannel) supabase.removeChannel(unionWalletChannel);
    };
    // currentUnionId (state, not the ref) so a union->union club switch rebinds.
  }, [userId, resolvedId, currentUnionId, channelEpoch, variant]);

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
    label: string;
    icon: WalletIconName;
    value: number;
    hint?: string;
    known?: boolean;
  };

  const ROW_CONFIG: Record<WalletVariant, WalletRow[]> = {
    player: [
      // Dan 2026-08-21: named for what it IS across every role — the wallet
      // you play out of. (Was "Chip Balance".)
      { label: 'Player Wallet', icon: 'chip', value: animRow1 },
      { label: 'Agent Wallet', icon: 'agent', value: animRow2 },
      { label: 'Promo Wallet', icon: 'promo', value: animRow3 },
    ],
    owner: [
      // Dan 2026-08-21: "even club owners need a player wallet, that's the
      // only wallet they can play out of. Agents must move chips from their
      // agent wallets to player wallets to buy into games." Owners get the
      // same row players see, first, so the money that buys in is never
      // hidden behind club treasury figures.
      {
        label: 'Player Wallet',
        icon: 'chip',
        value: animPlayerWallet,
        hint: 'The Wallet You Play From',
      },
      { label: 'Club Bank', icon: 'bank', value: animRow1 },
      // Dan 2026-08-21: "Due at close" removed from the wallet stack — that
      // figure lives on the Data tab (ClubDataPage settlement breakdown shows
      // the 90% rakeback due line). A money panel lists wallets, not
      // projections.
      { label: 'Agent Wallet', icon: 'agent', value: animRow2 },
      { label: 'Promo Wallet', icon: 'promo', value: animRow3 },
    ],
    union: [
      {
        label: 'Rake Treasury',
        icon: 'treasury',
        value: animTreasury,
        known: unionFiguresKnown,
        hint: unionFiguresKnown
          ? `Held In Trust · ${formatBalance(data.projectedClubsShare)} To Clubs ${closeDay}`
          : 'Union Admins Only',
      },
      {
        label: 'BBJ Backup Wallet',
        icon: 'reserve',
        value: animBackupBBJ,
        known: unionFiguresKnown,
        hint: 'Next Jackpot Seed',
      },
      {
        label: 'Promo Wallet',
        icon: 'promo',
        value: animRow3,
        known: unionFiguresKnown,
        // The 25% promo slice accrues inside the BBJ pool and is swept across
        // to this wallet every ~5 minutes, so it steps rather than streams.
        // Saying so stops it reading as "not being funded".
        hint: unionFiguresKnown ? '25% BBJ Slice · Swept Every 5 Min' : undefined,
      },
    ],
  };

  const rows = ROW_CONFIG[effectiveVariant];

  // Only show mint button for owner/union variants (players should never see it)
  const showMintButton =
    onMintChips && (effectiveVariant === 'owner' || effectiveVariant === 'union');

  // ── Keyboard handler for BBJ banner (accessibility) ─────────────────────────
  const handleBbjKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      onOpenBBJ?.();
    }
  };

  // ── Loading skeleton ───────────────────────────────────────────────────────
  if (loading) {
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

        {/* Role-specific wallet rows */}
        {rows.map((row, idx) => (
          <div
            key={row.label}
            className={`dw__row dw__row--wallet${idx === 0 ? ' dw__row--primary' : ''}`}
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
            {idx === 0 && showMintButton && (
              <button
                className="dw__plus"
                onClick={(e) => {
                  e.stopPropagation();
                  onMintChips!();
                }}
                aria-label="Mint Chips"
              >
                +
              </button>
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
