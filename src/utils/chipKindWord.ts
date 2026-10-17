import { enumToTitleCase } from './titleCase';

/**
 * The ledger's movement categories as a player reads them. `enumToTitleCase`
 * turns `buyin` into "Buyin" and `addon` into "Addon"; the words the rest of
 * the wallet prints are hyphenated (launch audit 2026-10-09, R-11). Anything
 * not named here still falls through to the enum reading.
 */
export const CHIP_KIND_WORD: Record<string, string> = {
  buyin: 'Buy-In',
  cashout: 'Cash-Out',
  addon: 'Add-On',
  addon_refund: 'Add-On Refund',
  rebuy: 'Rebuy',
  tournament_buyin: 'Tournament Buy-In',
  tournament_cashout: 'Tournament Cash-Out',
  bbj: 'Bad Beat Jackpot',
  bbj_promo_sweep: 'Bad Beat Jackpot Promo Sweep',
  /* Read as the Club Bank send it is: a label of its own named the rows
     only one kind of member ever receives (cashier launch B-5). */
  horse_refill: 'Club Bank Send',
  club_bank_send: 'Club Bank Send',
};

export function chipKindWord(kind: string | null | undefined): string {
  const raw = String(kind ?? '');
  return CHIP_KIND_WORD[raw] ?? enumToTitleCase(raw);
}
