/**
 * Which cashier surface a club switch keeps the viewer on.
 *
 * Lived in src/components/club/CashierClubSwitcher.tsx until the regression
 * review of 2026-10-10 (G-06): a component module that exports a plain
 * function loses React Fast Refresh.
 */

/**
 * Switching clubs keeps the viewer on the cashier surface they are on (launch
 * audit 2026-10-09, P-08). This always sent them to `/cashier`, the Trade
 * grid, so an owner on the classic cashier's Mint or History tab who picked
 * another club lost the classic page. The classic route is
 * `clubs/:clubId/cashier-classic` and the statements route
 * `clubs/:clubId/cashier/statements`; anything else is the Trade cashier.
 */
export function cashierDestination(pathname: string): string {
  if (/\/cashier-classic\/?$/.test(pathname)) return 'cashier-classic';
  if (/\/cashier\/statements\/?$/.test(pathname)) return 'cashier/statements';
  return 'cashier';
}
