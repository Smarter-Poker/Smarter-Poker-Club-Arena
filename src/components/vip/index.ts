/**
 * VIP Components — Index
 *
 * Three components were removed on 2026-09-05, all for the same reason: they
 * were exported from this barrel and rendered NOWHERE, and each still carried a
 * piece of the tier ladder Dan struck ("THERE IS NO SUCH THING AS 'PLATINUM
 * VIP' BTW. JUST VIP, AND LIFETIME VIP").
 *
 *   VIPStatusCard      props declared tier: bronze|silver|gold|platinum|diamond
 *   VIPUpgradeModal    a whole upgrade ladder, in #ffd700, and the second bare
 *                      `.tier-card` that collided with VIPPage.css across pages
 *   VIPProgressRing    a `.tier-name` ring around progress toward a rung
 *
 * A barrel export is not a use. Keeping them meant every one of them was one
 * import away from putting the ladder back on a page.
 * VIPMembershipPlate is what states a membership now.
 */

export { VIPCardsModal } from './VIPCardsModal';
export { VIPMembershipPlate } from './VIPMembershipPlate';
export { VIPPerksGrid } from './VIPPerksGrid';
