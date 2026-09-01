import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { sliceBetween } from '../helpers/sourceWindow';

/**
 * LAW: a realtime subscription on a high-volume table must not call a full
 * reload once per row.
 *
 * Measured in production on 2026-09-01 via pg_stat_statements:
 *   - Supabase Realtime's WAL decode + RLS check was 13% of ALL database time
 *     (50,739 seconds across 96,968 batches, 523ms mean).
 *   - agent_commissions is the highest-write table in the supabase_realtime
 *     publication: 1,878,396 lifetime writes, 1,539,684 rows since 2026-05-01,
 *     averaging 0.40 chips each. It is a PER-HAND ledger.
 *   - SettlementDashboardPage subscribed to every INSERT on it, platform-wide,
 *     with no filter and no debounce, calling loadData() directly - while the six
 *     masterBus subscriptions immediately above it were all debounced 500-2000ms.
 *
 * The in-flight guard inside loadData() dropped overlapping reloads, so this was
 * never as bad on the client as it looks. That is exactly why it survived: it was
 * invisible from the outside. The cost was real anyway, and a settlement dashboard
 * does not need per-hand granularity to be correct.
 *
 * This pins the shape, not the number: the handler must not be a bare call.
 */

const read = (p: string) => readFileSync(resolve(process.cwd(), p), 'utf8');

describe('LAW: realtime handlers on per-hand tables are debounced', () => {
  it('SettlementDashboardPage does not reload once per agent_commissions row', () => {
    const src = read('src/pages/SettlementDashboardPage.tsx');

    // locate the agent_commissions postgres_changes subscription
    const idx = src.indexOf("table: 'agent_commissions'");
    expect(idx, 'the agent_commissions realtime subscription should still exist').toBeGreaterThan(
      -1
    );

    // Bound the window by the structure it is about, never by a byte count.
    // Two structural landmarks: the subscription descriptor that opens the handler
    // and the .subscribe( that closes the chain. The window then grows exactly as
    // fast as the handler does and can never be outrun by it.
    // (sliceStatement is wrong here - it stops at the first semicolon, which lands
    // INSIDE the handler body.) See tests/helpers/sourceWindow.ts.
    const handler = sliceBetween(src, "table: 'agent_commissions'", '.subscribe(');

    // the regression this pins: `table: 'agent_commissions' },\n () => loadData()`
    const bareReload = /table: 'agent_commissions'\s*\}\s*,\s*\(\)\s*=>\s*loadData\(\)/.test(src);
    expect(
      bareReload,
      'agent_commissions is a per-hand ledger (1.5M rows, 0.40 chips each). Calling ' +
        'loadData() once per inserted row re-arms a full dashboard reload on every ' +
        'hand dealt. Debounce it, as the masterBus subscriptions above it already are.'
    ).toBe(false);

    // and positively: some debouncing must be present in that handler
    expect(
      /setTimeout|Debounced|debounce/i.test(handler),
      'the agent_commissions realtime handler must debounce before reloading'
    ).toBe(true);
  });

  it('the debounce timer is cleared on unmount, so it cannot fire into a dead component', () => {
    const src = read('src/pages/SettlementDashboardPage.tsx');
    expect(
      /return \(\) => \{[\s\S]{0,300}clearTimeout\(commissionReloadTimer\.current\)/.test(src),
      'the commission reload timer must be cleared in the effect cleanup'
    ).toBe(true);
  });
});
