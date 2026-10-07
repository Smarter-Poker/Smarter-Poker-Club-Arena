/**
 * USE BRIDGE RATE - the live diamonds-per-chip rate the Chip Mint charges.
 *
 * THE RATE IS A ROW (Dan 2026-09-07: 1 diamond = $0.01, 1 chip = $1.00).
 * fn_mint_chips_from_diamonds reads public.fn_ca_bridge_rate() (ca_bridge_rate,
 * id 1) and charges at whatever it says. The mint previews used to print a
 * literal left over from the 2026-08-21 rate ("100 Diamonds = 10K Chips")
 * while the server credited 1 chip for those 100 diamonds. They now read the
 * same function the server does, so the preview cannot drift from the charge.
 *
 * Returns the rate once read, null while loading, and `failed` when the read
 * did not succeed. A failed read is not a rate: callers print Unavailable and
 * keep the mint disabled rather than guess.
 */

import { useEffect, useState } from 'react';
import { supabase } from '../lib/supabase';
import { reportError } from '../utils/errorReporter';

export interface BridgeRate {
  diamondsPerChip: number | null;
  failed: boolean;
}

export function useBridgeRate(enabled = true): BridgeRate {
  const [state, setState] = useState<BridgeRate>({ diamondsPerChip: null, failed: false });

  useEffect(() => {
    if (!enabled) return;
    let live = true;
    void (async () => {
      const { data, error } = await supabase.rpc('fn_ca_bridge_rate');
      if (!live) return;
      const rate = Number(data);
      if (error || !Number.isSafeInteger(rate) || rate <= 0) {
        if (error) reportError(error, 'useBridgeRate');
        setState({ diamondsPerChip: null, failed: true });
        return;
      }
      setState({ diamondsPerChip: rate, failed: false });
    })();
    return () => {
      live = false;
    };
  }, [enabled]);

  return state;
}
