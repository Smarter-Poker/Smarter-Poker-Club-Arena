import { supabase } from '../lib/supabase';

export interface DiamondCustodyBalance {
  available: number;
  inPlay: number;
}

/** The database binds the read to auth.uid(); callers cannot name another player. */
export async function getDiamondCustodyBalance(): Promise<DiamondCustodyBalance> {
  const { data, error } = await supabase.rpc('fn_poker_diamond_custody_balance');
  if (error) throw new Error(error.message || 'Could Not Read Diamond Balance');
  if (
    !data ||
    !Number.isSafeInteger(data.available) ||
    data.available < 0 ||
    !Number.isSafeInteger(data.in_play) ||
    data.in_play < 0
  )
    throw new Error('Invalid Diamond Balance Response');
  return { available: data.available, inPlay: data.in_play };
}
