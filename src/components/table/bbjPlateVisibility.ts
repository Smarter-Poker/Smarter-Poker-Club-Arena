/**
 * ONE ANSWER TO "IS THE JACKPOT PLATE ON THIS TABLE" (2026-09-11).
 *
 * TableModalsLayer decides whether to mount the felt plate, and since the mini
 * row hangs under that plate and the felt reserves height for it
 * (`--sp-bbj-h` in BadBeatJackpot.css), TablePage has to make the SAME
 * decision to stamp `data-bbj-mini` on the page root. Two copies of the
 * condition would drift; this is the one copy.
 *
 * The rule (2026-08-18): hidden for variants the server never pays (PLO6,
 * Short Deck), and never on tournaments, spins or heads-up.
 */
import { getBBJQualifyingInfo } from '../../config/RakeConfig';

export interface BbjPlateContext {
  gameType: string | null | undefined;
  isTournament: boolean;
  tournamentId: string | null | undefined;
  maxPlayers: number;
}

export function isBbjPlateShown(ctx: BbjPlateContext): boolean {
  const gameType = ctx.gameType ?? '';
  if (!getBBJQualifyingInfo(gameType).eligible) return false;
  if (ctx.isTournament || ctx.tournamentId) return false;
  if (!(ctx.maxPlayers > 2)) return false;
  if (gameType === 'heads_up' || gameType === 'hu' || gameType === 'spin' || gameType === 'spins') {
    return false;
  }
  return true;
}
