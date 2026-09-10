import { useEffect, useState } from 'react';
import { supabase } from '../../lib/supabase';
import { masterBus } from '../../core/MasterBus';
import {
  getDiamondCustodyBalance,
  type DiamondCustodyBalance as Balance,
} from '../../services/DiamondCustodyService';

export default function DiamondCustodyBalance() {
  const [balance, setBalance] = useState<Balance | null>(null);
  const [failed, setFailed] = useState(false);
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    let alive = true;
    let generation = 0;
    let signedOut = false;
    const refresh = async () => {
      if (!alive || signedOut) return;
      const request = ++generation;
      try {
        const next = await getDiamondCustodyBalance();
        if (alive && request === generation) {
          setBalance(next);
          setFailed(false);
        }
      } catch {
        if (alive && request === generation) {
          setBalance(null);
          setFailed(true);
        }
      }
    };
    void refresh();
    const onFocus = () => {
      void refresh();
    };
    const onVisible = () => {
      if (document.visibilityState === 'visible') void refresh();
    };
    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onVisible);
    const offBalance = masterBus.subscribe('DIAMOND_BALANCE_CHANGED', onFocus);
    const offSpend = masterBus.subscribe('DIAMOND_SPENT', onFocus);
    const offSeat = masterBus.subscribe('TABLE_LEFT', onFocus);
    const offBuyIn = masterBus.subscribe('TABLE_SEATED', onFocus);
    const offRefresh = masterBus.subscribe('BALANCE_UPDATED', onFocus);
    // Profile UPDATE events do not require an old diamond value from replication.
    const offProfile = masterBus.subscribe('PROFILE_UPDATED', onFocus);
    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((event) => {
      if (event === 'SIGNED_OUT' || event === 'SIGNED_IN') {
        ++generation;
        signedOut = event === 'SIGNED_OUT';
        setBalance(null);
        setFailed(signedOut);
      }
      // Auth callbacks must finish before starting another Supabase request.
      if (event !== 'SIGNED_OUT')
        queueMicrotask(() => {
          if (alive) void refresh();
        });
    });
    return () => {
      alive = false;
      ++generation;
      subscription.unsubscribe();
      offBalance();
      offSpend();
      offSeat();
      offBuyIn();
      offRefresh();
      offProfile();
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [retry]);
  if (failed)
    return (
      <p role="status">
        Diamond Balance Unavailable.{' '}
        <button onClick={() => setRetry((v) => v + 1)}>Retry Balance</button>
      </p>
    );
  if (!balance) return <p role="status">Loading Diamond Balance</p>;
  return (
    <dl aria-label="Diamond Balances">
      <dt>Available Diamonds</dt>
      <dd>{balance.available.toLocaleString()}</dd>
      <dt>Diamonds In Play</dt>
      <dd>{balance.inPlay.toLocaleString()}</dd>
    </dl>
  );
}
