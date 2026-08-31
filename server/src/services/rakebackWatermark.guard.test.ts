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
import { sliceMethod } from '../testHelpers/sourceWindow.js';

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
      'the watermark advances past a failed recompute - those rake_records are then never settled'
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

/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  THE SENTINEL'S WINDOW MEANS FINISHED, NOT CREATED (2026-08-31)
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Second time. The payout sweep had this exact defect and it was fixed on
 * 2026-08-29 in `20260829125035_payout_sweep_window_means_finished_not_created`;
 * the tournament invariant sentinel three hundred lines above kept it.
 *
 * `tournaments.updated_at` is maintained by NOTHING — no trigger, no engine
 * write. Measured 2026-08-31: 2,286 of 2,286 tournaments created in 24 hours had
 * `updated_at = created_at`, and `updated_at < started_at` on every one. So a
 * watermark on that column is a CREATION time, and each batch advanced it past
 * every lobby opened before the one it happened to finish on.
 *
 * A tournament created before the mark and finished after it was therefore never
 * checked — not late, NEVER. Measured at the live watermark: 63 COMPLETED events
 * created before it and ended after it, 44 of them Spins. It recurs every batch.
 *
 * What went unchecked is the point: payout conservation (chips destroyed or
 * minted), stranded players, and raked tournament hands.
 */
describe('the tournament sentinel window', () => {
  // Bounded by the method, via the sanctioned extractor — never by a character
  // count. See tests/unit/noFixedSizeSourceWindows.test.ts for why.
  const sentinel = sliceMethod(code, 'private async runTournamentSentinel(');

  it('filters and orders on ended_at, never on updated_at', () => {
    // updated_at holds row-CREATION time, so a lobby opened before the mark and
    // finished after it is skipped permanently.
    expect(sentinel).not.toMatch(/\.gt\(\s*'updated_at'/);
    expect(sentinel).not.toMatch(/\.order\(\s*'updated_at'/);
    expect(sentinel).toMatch(/\.gt\(\s*'ended_at'/);
    expect(sentinel).toMatch(/\.order\(\s*'ended_at'/);
  });

  it('advances the watermark by the finish time it just processed', () => {
    expect(sentinel).toMatch(/newWatermark\s*=\s*t\.ended_at/);
    expect(sentinel).not.toMatch(/newWatermark\s*=\s*t\.updated_at/);
  });

  it('selects the column it windows on, so the watermark cannot read undefined', () => {
    // The row type and the select list have to move together: selecting
    // updated_at while reading t.ended_at would advance the mark to undefined
    // and re-scan the same batch forever.
    expect(sentinel).toMatch(/\.select\([^)]*ended_at/);
  });
});
