/**
 * D5 — A SPIN MULTIPLIER IS EITHER DRAWN OR UNKNOWN. IT IS NEVER INVENTED.
 *
 * Defect (found 2026-08-25, in TournamentManagerBase.start()):
 *
 *   const { data: draw } = await supabase.rpc('fn_spin_draw_multiplier', {...});
 *   ...
 *   } catch { /* handled below *\/ }
 *   if (!spinMultiplier || spinMultiplier <= 0) {
 *     spinMultiplier = SPIN_TIERS[0].multiplier;   // <- the lie
 *
 * The RPC's `error` was discarded and the catch was empty, so any failure to
 * READ the draw silently resolved the player DOWN to the lowest tier. Three
 * players then watched a genuine-looking wheel chase five laps and land on a
 * 2x that the database had never told anyone it drew, and fn_spin_settle_game
 * moved real money against that number. This is the same house rule already
 * enforced on the elimination count ('remaining_count_unavailable' in
 * TournamentManagerEliminations): an unreadable result is UNKNOWN, never a
 * value.
 *
 * The second guard covers the row write. `spin_multiplier` NULL means every
 * client gate for the wheel (all of which require `> 0`) fails forever, so a
 * write that never lands does not merely lose a ledger row — it removes the
 * feature from that game for everyone. It must self-heal, and only ever into
 * an empty column.
 *
 * These are source guards, in the style of TournamentFixes.guard.test.ts:
 * start() is a ~600-line method against live Supabase and cannot be exercised
 * in a unit test, but the shapes that made the lie possible can be forbidden.
 * If a rule here is deliberately superseded, delete the guard IN THE SAME
 * COMMIT and say why.
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { sliceEnclosingBlock } from '../testHelpers/sourceWindow.js';

const BASE = fs.readFileSync(
  path.join(process.cwd(), 'src/tournament/TournamentManagerBase.ts'),
  'utf8'
);

/** Strip comments so a guard cannot pass on a mention in prose. */
const code = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
const CODE = code(BASE);

describe('a spin draw that could not be read is UNKNOWN, not the lowest tier', () => {
  it('never assigns a multiplier from the tier table as a fallback', () => {
    // The exact line that made the wheel lie: `spinMultiplier = SPIN_TIERS[0].multiplier`.
    expect(CODE).not.toMatch(/spinMultiplier\s*=\s*SPIN_TIERS\s*\[\s*0\s*\]/);
  });

  it('reads the RPC error instead of destructuring only `data`', () => {
    const call = CODE.slice(CODE.indexOf('fn_spin_draw_multiplier') - 400);
    expect(call).toMatch(/error:\s*drawErr/);
    expect(CODE).toMatch(/if\s*\(\s*drawErr\s*\)\s*throw/);
  });

  it('has no empty catch around the draw', () => {
    // `catch { }` / `catch (e) { }` with nothing in it is what swallowed it.
    const drawBlock = CODE.slice(
      CODE.indexOf('fn_spin_draw_multiplier'),
      CODE.indexOf('spin_draw_unavailable')
    );
    expect(drawBlock).not.toMatch(/catch\s*(\([^)]*\))?\s*\{\s*\}/);
  });

  it('stands the start down rather than resolving to a value', () => {
    expect(CODE).toMatch(/spin_draw_unavailable/);
    const failure = sliceEnclosingBlock(CODE, 'spin_draw_unavailable');
    // The stand-down pattern the short-field and unpaid-seat gates already use.
    expect(failure).toMatch(/this\.running\s*=\s*false/);
    // And the old error tag, which named a state that no longer exists, is gone.
    expect(CODE).not.toMatch(/spin_draw_rpc_down/);
  });

  it('rejects a response it cannot read a positive multiplier out of', () => {
    expect(CODE).toMatch(/no usable multiplier/);
  });
});

describe('the drawn multiplier reaches the row, or keeps trying', () => {
  it('schedules a bounded background repair when the write never lands', () => {
    expect(CODE).toMatch(/scheduleSpinRowRepair/);
    expect(CODE).toMatch(/spin_row_repair_exhausted/);
  });

  it('the repair only ever fills an empty column', () => {
    const repair = CODE.slice(CODE.indexOf('private scheduleSpinRowRepair'));
    expect(repair).toMatch(/spin_multiplier\.is\.null,spin_multiplier\.eq\.0/);
  });

  it('the repair confirms by re-reading, not by the absence of an error', () => {
    const repair = CODE.slice(
      CODE.indexOf('private scheduleSpinRowRepair'),
      CODE.indexOf('spin_row_repair_exhausted')
    );
    expect(repair).toMatch(/Number\(after\?\.spin_multiplier\)\s*>\s*0/);
  });

  it('the repair re-applies the patch this start drew, not a fresh draw', () => {
    const repair = CODE.slice(CODE.indexOf('private scheduleSpinRowRepair'));
    const body = repair.slice(0, repair.indexOf('spin_row_repair_exhausted'));
    expect(body).not.toMatch(/fn_spin_draw_multiplier/);
  });
});

describe('the reveal asks the hub to hold it (D3)', () => {
  it('the wheel event carries its own replay deadline, and it is the REAL one', () => {
    /* PIN MOVED, NOT WEAKENED (2026-09-02, §10.6). It read
       `/replay_until:\s*holdUntil/`. The engine holds dealing until
       `effectiveHold = Math.max(holdUntil, now + spinPostRevealMs())`, so
       pinning the PLANNED hold pinned the bug: on the overrun path the hub
       dropped the replay packet while the cards were still legally undealt,
       and a player reconnecting in that window lost the reveal entirely.
       The deadline must be the hold the engine actually keeps. */
    /* THERE ARE TWO PACKETS AND THEY ARE NOT THE SAME (2026-09-02). The
       first `type: 'spin_reveal'` in this file is the EARLY emit, fired
       before the engine exists; the second is the main pass. The old pin
       sliced occurrence 0 and asserted `holdUntil`, which passed against
       either - so it never noticed they had to differ. Both are pinned now,
       each to the deadline it actually owes. */
    const early = sliceEnclosingBlock(CODE, "type: 'spin_reveal'", 0);
    expect(early).toMatch(
      /replay_until: Math\.max\(holdUntil, Date\.now\(\) \+ spinPostRevealMs\(\)\)/
    );

    const main = sliceEnclosingBlock(CODE, "type: 'spin_reveal'", 1);
    expect(main).toMatch(/replay_until:\s*effectiveHold/);
    expect(main).not.toMatch(/replay_until:\s*holdUntil\b/);
  });

  it('the post-reveal beats carry one too, ending when dealing may start', () => {
    expect(CODE).toMatch(/const replayUntil = revealAt \+ spinRevealToDealMs\(\)/);
    const post = CODE.slice(CODE.indexOf('private scheduleSpinPostReveal'));
    expect(post.match(/replay_until:\s*replayUntil/g) ?? []).toHaveLength(2);
  });
});
