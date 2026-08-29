/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  A FAILED RECOMPUTE MUST NOT ADVANCE THE RAKEBACK WATERMARK (2026-08-29)
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * `_runSettlementInner` counted `failures` from `fn_rakeback_recompute_periods`,
 * logged the number, and then advanced the durable cursor past those
 * `rake_records` anyway — returning 'idle'/'more' rather than 'halted', even
 * though the file defines 'halted' as "a read failed: the cursor did NOT
 * advance" and already uses it for exactly that in two other places.
 *
 * WHY IT DOES NOT SELF-HEAL. `fn_rakeback_recompute_periods` rebuilds a
 * (club, week) period FROM SOURCE, so a failed batch repairs itself only if
 * another rake record happens to land in the same club and the same ISO week
 * before that week closes. A failure on a week's last batch is permanent.
 *
 * AND IT COMPOUNDS. `rake_generated` is what selects the rakeback tier band
 * (5/10/15/20/30%), so a period computed from partial data can pay a player a
 * whole band low — the failure mode this service's own notes record as having
 * understated one player 16x and dropped them a tier.
 *
 * Retrying is safe: recompute rebuilds from source and the player_stats
 * applies are keyed, so a held cursor costs a re-read, never a double-credit.
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

const SRC = fs.readFileSync(
  path.join(process.cwd(), 'src/services/RakebackSettlerService.ts'),
  'utf8'
);
/** Strip comments so a guard cannot pass on prose describing the old code. */
const code = SRC.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');

describe('the rakeback settlement watermark', () => {
  it('holds the cursor when a period recompute failed', () => {
    /* There are TWO cursor advances in this method and only one of them is a
       bug. The first sits in the `buckets.size === 0` branch -- no eligible
       player-credits, so there is nothing to recompute and nothing that can
       fail, and advancing there is correct. The one that matters is the LAST
       one, after the recompute loop, which is why this uses lastIndexOf. */
    const guard = code.indexOf('if (failures > 0)');
    const finalAdvance = code.lastIndexOf('this.cursor = nextCursor');
    expect(guard, 'no failures > 0 guard before the watermark advances').toBeGreaterThan(-1);
    expect(finalAdvance).toBeGreaterThan(-1);
    expect(
      guard,
      'the watermark advances past a failed recompute — those rake_records are then never settled'
    ).toBeLessThan(finalAdvance);
  });

  it("returns 'halted' on a failed recompute, like the two read-failure sites", () => {
    expect(code).toMatch(/if \(failures > 0\)[\s\S]{0,900}?return 'halted';/);
  });

  it('says so out loud rather than only counting it', () => {
    expect(code).toMatch(/period_recompute_failures_hold_cursor/);
  });

  it("still has 'halted' wired as a real cycle outcome", () => {
    // If this type ever loses 'halted', the guard above becomes unreachable.
    expect(SRC).toMatch(/type CycleResult = 'idle' \| 'more' \| 'halted'/);
  });
});
