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

import { useCallback, useEffect, useState } from 'react';
import { spinActivationApi, type SpinOwnerState } from '../services/SpinActivationService';
import { useUserStore } from '../stores/useUserStore';
import {
  walletCacheKey,
  readWalletCache,
  writeWalletCache,
  dedupedFetch,
} from '../lib/walletCache';

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
  const userId = useUserStore((s: any) => s.user?.id) as string | undefined;

  const reload = useCallback(() => setNonce((n) => n + 1), []);

  useEffect(() => {
    if (!enabled || !ownerKey) {
      setState(null);
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
    const raw = cacheKey ? readWalletCache<{ s: SpinOwnerState | null }>(cacheKey) : null;
    const hit = raw !== null && typeof raw === 'object' && 's' in raw;
    if (hit) {
      setState(raw.s);
    } else {
      setLoading(true);
    }

    void (async () => {
      try {
        // Deduped: DynamicWallet and a dashboard tile asking for the same
        // owner in the same window share one request.
        const res = await dedupedFetch(cacheKey ?? `spins_anon_${ownerKey}`, () =>
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
        if (!cancelled) setLoading(false);
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
