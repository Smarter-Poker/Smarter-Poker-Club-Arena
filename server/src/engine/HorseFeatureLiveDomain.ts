import { publishedCashPricing } from '../config/leagueCashPricing.js';
import type { HorseFeatureDomain } from './HorseFeatureAuthority.js';
export interface HorseFeatureLiveDeclaration {
  schema: 'horse-feature-live-domain-v1';
  profileId: string;
  domain: HorseFeatureDomain;
}
const stable = (x: any): string =>
  JSON.stringify(x, (_k, v) =>
    v && typeof v === 'object' && !Array.isArray(v)
      ? Object.fromEntries(
          Object.keys(v)
            .sort()
            .map((k) => [k, v[k]])
        )
      : v
  );
const targets = [
  'combo_draw_pressure',
  'targeted_river_bluff',
  'river_position_defense',
  'river_bluff_checkraise',
  'barrel_continuation_outlook',
  'pressure_package',
];
/** Optional prospective declaration. No old locked plan is widened or rewritten.
 * A single exact starting profile bounds its intrahand states, not other stakes
 * or arbitrary initial stack distributions. */
export function featureLiveDomainRefusals(plan: any): string[] {
  const x = plan?.liveAdmission,
    d = x?.domain,
    p = plan?.profiles?.find((p: any) => p.id === x?.profileId);
  if (!x) return ['live_domain_not_declared'];
  if (
    x.schema !== 'horse-feature-live-domain-v1' ||
    Object.keys(x).sort().join(',') !== 'domain,profileId,schema' ||
    !d ||
    !p ||
    !targets.includes(plan.target) ||
    plan.schema !== 'horse-incremental-ablation-plan-v2' ||
    plan.state !== 'heldout_locked'
  )
    return ['live_domain_profile'];
  const shapes =
    plan.target === 'river_bluff_checkraise'
      ? ['2:100']
      : ['2:100', '4:100', '6:40', '6:100', '6:200'];
  if (
    !['nlh', 'plo4', 'plo5', 'plo6'].includes(p.variant) ||
    !shapes.includes(`${p.seats}:${p.stackBB}`) ||
    p.id !== `${plan.target}-${p.variant}-6max-${p.seats}dealt-${p.stackBB}bb`
  )
    return ['live_domain_profile'];
  const pricing = publishedCashPricing({
    tournament: false,
    variant: p.variant,
    seats: p.seats,
    tableSeats: 6,
  });
  if (
    d.variant !== p.variant ||
    d.mode !== 'cash' ||
    d.asset !== 'chips' ||
    d.chipUnit !== 0.01 ||
    d.boardCount !== 1 ||
    d.smallBlind !== 1 ||
    d.bigBlind !== 2 ||
    d.ante !== 0 ||
    d.bigBlindAnte !== false ||
    d.bettingStructure !== (p.variant === 'nlh' ? 'no_limit' : 'pot_limit') ||
    d.sidePots !== false ||
    stable(d.rakeConfig) !== stable(pricing.rakeConfig) ||
    stable(d.bbjConfig) !== stable(pricing.bbjConfig)
  )
    return ['live_domain_economics'];
  if (
    stable(d.dealtSeats) !== stable([p.seats]) ||
    !Array.isArray(d.remainingPlayers) ||
    !d.remainingPlayers.length ||
    new Set(d.remainingPlayers).size !== d.remainingPlayers.length ||
    d.remainingPlayers.some((n: any) => !Number.isInteger(n) || n < 2 || n > p.seats) ||
    d.startingStackBB !== p.stackBB ||
    !Array.isArray(d.effectiveStackBB) ||
    d.effectiveStackBB.length !== 2 ||
    !d.effectiveStackBB.every(Number.isFinite) ||
    d.effectiveStackBB[0] < 0 ||
    d.effectiveStackBB[1] < d.effectiveStackBB[0] ||
    d.effectiveStackBB[1] > p.stackBB
  )
    return ['live_domain_population'];
  return [];
}
