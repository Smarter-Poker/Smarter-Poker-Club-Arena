/**
 * VIP Components — Index
 *
 * VIPStatusCard was removed 2026-09-05 with `src/constants/vipTiers.ts`: its
 * props declared `tier: 'bronze' | 'silver' | 'gold' | 'platinum' | 'diamond'`,
 * a ladder that does not exist (Dan 2026-09-04: "THERE IS NO SUCH THING AS
 * 'PLATINUM VIP' BTW. JUST VIP, AND LIFETIME VIP"), and nothing outside this
 * barrel ever imported it. VIPMembershipPlate is what states a membership now.
 */

export { VIPCardsModal } from './VIPCardsModal';
export { VIPMembershipPlate } from './VIPMembershipPlate';
export { VIPPerksGrid } from './VIPPerksGrid';
export { VIPProgressRing } from './VIPProgressRing';
export { VIPUpgradeModal } from './VIPUpgradeModal';
