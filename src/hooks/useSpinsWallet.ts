/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  THE SPINS WALLET, FOR ANY SURFACE THAT SHOWS WALLETS
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Dan, 2026-08-23: "ADD THE SPINS WALLET TO THE UNION, AND CLUBS WHEN THEY
 * ENABLE SPINS. IF A CLUB JOINS A UNION, THAT WALLET MUST DISAPPEAR."
 *
 * THE TWO POTS THIS EXISTS TO KEEP APART.
 *
 * The union dashboard already had a tile labelled "Spin Reserve", and it does
 * NOT show this. That one reads union_wallets.spin_reserve_wallet — operator
 * capital earmarked for Spins but NOT YET DEPLOYED. The migration that created
 * it says so outright: "The DEPLOYED reserve is spin_bonus_pools.balance —
 * this wallet holds only what is NOT currently in the pool, so the two never
 * double-count."
 *
 * So the live Spins wallet — the float every multiplier is actually paid from —
 * appeared on no wallet surface anywhere. This hook is that number.
 *
 * WHY IT GOES THROUGH THE API AND NOT A SELECT. spin_bonus_pools has RLS on
 * with no client-readable policy, deliberately: it is a money table. The only
 * sanctioned read is fn_spin_owner_state, a SECURITY DEFINER function reached
 * through /api/club-arena/spin-activation, which is also the only thing that
 * knows how to resolve an owner. Passing a club id that belongs to a union
 * returns the UNION's wallet, which is exactly right and is why the caller
 * must not try to be clever about which id to send.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { spinActivationApi, type SpinOwnerState } from '../services/SpinActivationService';
import { useUserStore } from '../stores/useUserStore';
import {
  walletCacheKey,
  readWalletCacheEntry,
  writeWalletCache,
  dedupedFetch,
} from '../lib/walletCache';

/**
 * A cached spins state younger than this is trusted as-is on mount — no
 * immediate refetch. Mirrors DynamicWallet's fresh window: page hops stop
 * re-asking a question answered seconds ago. reload() always bypasses it.
 */
const FRESH_WINDOW_MS = 15_000;

export interface SpinsWallet {
  state: SpinOwnerState | null;
  loading: boolean;
  /** Whether this owner has switched Spins on. */
  active: boolean;
  /** The live pool balance — what the multipliers are paid from. */
  balance: number;
  reload: () => void;
}

/**
 * @param ownerKey a club id OR a union id. Both resolve through
 *                 fn_spin_reserve_owner to whichever pool actually owns the
 *                 money, so a club inside a union reports its UNION's wallet.
 * @param enabled  skip the request entirely when the surface would not show it.
 */
export function useSpinsWallet(ownerKey: string | null | undefined, enabled = true): SpinsWallet {
  const [state, setState] = useState<SpinOwnerState | null>(null);
  const [loading, setLoading] = useState(false);
  const [nonce, setNonce] = useState(0);
  /** The nonce this hook has already fetched for. */
  const fetchedNonceRef = useRef(0);
  const userId = useUserStore((s: any) => s.user?.id) as string | undefined;

  const reload = useCallback(() => setNonce((n) => n + 1), []);

  useEffect(() => {
    if (!enabled || !ownerKey) {
      setState(null);
      /* AND CLEAR loading. Without this a request in flight when the club
         joined a union - the exact transition this hook exists for - left the
         consumer on a spinner forever: the cleanup below set `cancelled`, so
         the `finally` skipped setLoading(false), and this early return never
         reached it either. */
      setLoading(false);
      return;
    }
    let cancelled = false;

    // Instant paint from the device cache (stale-while-revalidate — the
    // request below ALWAYS runs and overwrites). Keyed per viewing user so a
    // sign-out purge isolates accounts; skipped entirely when no user id is
    // known yet.
    //
    // SENTINEL ENVELOPE: the cached value is `{ s: state }`, never the bare
    // state. A club with no Spins state caches `{ s: null }`, which is
    // DISTINGUISHABLE from a cache miss — before this, "cached: no spins"
    // read as "never asked", so every visit to a no-spins club flashed the
    // loading state it was built to avoid. (Old bare-shape entries fail the
    // `'s' in` guard and count as misses — harmless, they refill once.)
    const cacheKey = userId ? walletCacheKey(userId, 'spins', ownerKey) : null;
    const entry = cacheKey ? readWalletCacheEntry<{ s: SpinOwnerState | null }>(cacheKey) : null;
    const raw = entry?.data ?? null;
    const hit = raw !== null && typeof raw === 'object' && 's' in raw;
    if (hit) {
      setState(raw.s);
      /* FRESH WINDOW: seconds-old answer, nothing to re-ask on a page hop.
         An explicit reload() bumps `nonce`, which always fetches.
         Compared against the nonce ALREADY FETCHED, not against 0: `nonce`
         never returns to 0, so after the first reload() this window was shut
         for the life of the hook and every later ownerKey or userId change
         re-fetched against a two-second-old entry. */
      if (nonce === fetchedNonceRef.current && entry && Date.now() - entry.at < FRESH_WINDOW_MS) {
        setLoading(false);
        return;
      }
    } else {
      setLoading(true);
    }

    void (async () => {
      try {
        // Deduped: DynamicWallet and a dashboard tile asking for the same
        // owner in the same window share one request.
        /* The nonce is part of the DEDUPE key but not the CACHE key. Without
           it, a reload() raised while the first request was still in flight
           was handed that same in-flight promise and resolved with the
           pre-top-up balance - a refresh that silently refreshed nothing. */
        const res = await dedupedFetch(`${cacheKey ?? `spins_anon_${ownerKey}`}_${nonce}`, () =>
          spinActivationApi.getState(ownerKey)
        );
        if (!cancelled) {
          const next = res.state ?? null;
          setState(next);
          if (cacheKey) writeWalletCache(cacheKey, { s: next });
        }
      } catch {
        // A viewer with no permission, or a club that has never touched Spins,
        // is a normal outcome. The row simply does not appear — it must never
        // render a made-up zero next to real balances. On error, only fall
        // back to null when nothing cached painted above.
        if (!cancelled && !hit) setState(null);
      } finally {
        if (!cancelled) {
          fetchedNonceRef.current = nonce;
          setLoading(false);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [ownerKey, enabled, nonce, userId]);

  return {
    state,
    loading,
    active: Boolean(state?.is_active),
    balance: Number(state?.balance ?? 0),
    reload,
  };
}
