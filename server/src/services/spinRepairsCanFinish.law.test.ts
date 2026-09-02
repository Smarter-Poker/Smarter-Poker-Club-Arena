/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  A REPAIR MUST BE ABLE TO FINISH (2026-08-31)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * fn_backpay_spin_unpaid_winners is the safety net under the one Spin failure
 * where a prize LEAVES THE RESERVE POOL AND REACHES NOBODY. On 2026-08-31 it
 * was measured through PostgREST exactly as GameServer calls it, and it failed
 * FIVE TIMES OUT OF FIVE with 57014 statement timeout against the 8s
 * service_role limit. It had been called every ten minutes and erroring every
 * time, and nothing said so, because a back-pay that finds nothing and a
 * back-pay that never runs return the same silence.
 *
 * The cause was structural: the RPC read an unbounded historical view three
 * times per call. These pins are the source-level half of the contract - every
 * recurring repair the engine drives must be given a window it can finish in,
 * and none of them may reach for the unbounded auditor.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { sliceCall } from '../testHelpers/sourceWindow.js';

const gameServer = readFileSync(join(__dirname, '..', 'GameServer.ts'), 'utf8');

/**
 * The `supabase.rpc(...)` call for a named function, bounded by its own
 * MATCHING PAREN rather than a byte count.
 *
 * A fixed forward window is the exact defect testHelpers/sourceWindow exists
 * to stop: the argument object here already sits behind a ten-line comment,
 * and one more paragraph would push `p_since_hours` out of any magic number
 * and turn a green pin red - or, far worse, leave it green while watching
 * nothing.
 */
const callBlock = (rpc: string): string => {
  const named = gameServer.indexOf(`'${rpc}'`);
  expect(named, `${rpc} is called from GameServer`).toBeGreaterThan(-1);
  // Walk BACK to the call that names it, then let sliceCall bound the window
  // by the matching paren. Anchoring on the literal alone would depend on the
  // indentation between `rpc(` and the name.
  const opens = gameServer.slice(0, named).lastIndexOf('supabase.rpc(');
  expect(opens, `${rpc} is passed to supabase.rpc`).toBeGreaterThan(-1);
  return sliceCall(gameServer.slice(opens), 'supabase.rpc(');
};

describe('every recurring spin repair is bounded', () => {
  it('the unpaid-winner back-pay is given a window', () => {
    expect(callBlock('fn_backpay_spin_unpaid_winners')).toMatch(/p_since_hours:\s*\d+/);
  });

  /**
   * Six hours is thirty-six passes of the ten-minute loop. Wide enough that a
   * few consecutive failures cannot let a debt escape the window, narrow
   * enough that the query finishes. A window measured in days would put this
   * straight back where it started.
   */
  it('that window is generous against the loop but not an audit', () => {
    const m = callBlock('fn_backpay_spin_unpaid_winners').match(/p_since_hours:\s*(\d+)/);
    const hours = Number(m?.[1]);
    expect(hours).toBeGreaterThanOrEqual(2);
    expect(hours).toBeLessThanOrEqual(48);
  });

  it('every repair the loop drives carries a bound', () => {
    for (const [rpc, bound] of [
      ['fn_repair_tournament_rake_attribution', /p_limit:\s*\d+/],
      ['fn_backpay_tournament_rake_attribution', /p_limit:\s*\d+/],
      ['fn_backpay_spin_unpaid_winners', /p_limit:\s*\d+/],
    ] as const) {
      expect(callBlock(rpc), `${rpc} passes a limit`).toMatch(bound);
    }
  });

  /**
   * fn_repair_ retries settlements the settle path RECORDED as failed. It
   * cannot see the ones that were never measured at all, which was 40,055
   * rows on 2026-08-31. Draining that was a one-off by hand; keeping it
   * drained cannot be.
   */
  it('the rake attribution back-pay runs on the loop, not only by hand', () => {
    expect(gameServer).toContain('fn_backpay_tournament_rake_attribution');
    expect(gameServer).toContain('GameServer.rake_attribution_backpay_failed');
  });

  it('the spin gauges are started with the rest of the collectors', () => {
    expect(gameServer).toContain('this.spinMetrics.start()');
    expect(gameServer).toContain('...this.spinMetrics.toPrometheus()');
  });
});
