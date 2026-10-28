import type { HandConfig } from '../types.js';
import { getFullRakeConfig, getPlayerCountCaps } from './RakeConfig.js';
/** Exact historical league 1/2 cash pricing, shared without changing schedules. */
export function publishedCashPricing(profile: {
  tournament: boolean;
  variant?: string;
  tableSeats?: number;
  seats: number;
}): { rakeConfig: HandConfig['rakeConfig']; bbjConfig: NonNullable<HandConfig['bbjConfig']> } {
  if (profile.tournament) throw new Error('Published PLO4 pricing is the cash 1/2 game only');
  const full = getFullRakeConfig(1, 2, profile.variant ?? 'plo4');
  return {
    rakeConfig: {
      percent: full.rakePercent,
      cap: full.rakeCap,
      noFlopNoDrop: true,
      playerCountCaps: getPlayerCountCaps(full.rakeCap, profile.tableSeats ?? profile.seats),
    },
    bbjConfig: {
      enabled: full.bbjEnabled,
      feeBB: full.bbjFeeBB,
      minPotBB: full.rules.minPotBB,
      minPlayersDealt: full.rules.minPlayersDealt,
    },
  };
}
