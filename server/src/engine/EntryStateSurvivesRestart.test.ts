/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  A CASH ENTRY HOLD MUST SURVIVE A DEPLOY
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Dan 2026-08-30. `waitingForBB`, `postBBWhenClear` and `postingBBToEnter` are
 * `Set<string>` fields on the engine process, and every push touching
 * `server/**` redeploys that process (auto-deploy-hetzner.yml). It also recycles
 * on lease changes, killForRestart and the watchdog.
 *
 * WHAT A RESTART USED TO COST, which is more than "the prompt comes back":
 *
 * The dealing loop's first-iteration block adds every seated player to
 * `knownPlayerIds` AND `dealtInUserIds`. That is correct and deliberate for
 * someone who was genuinely playing before the restart — without it,
 * `buttonEligible()` falls back to the whole roster for a full orbit after every
 * deploy. But it swept up held players too, and a held player came back:
 *
 *   - not in waitingForBB, so dealt in on the very next hand;
 *   - having paid nothing, which is the free hand Dan reversed on 2026-08-26
 *     ("no free hands or coming in behind the blinds");
 *   - a button-eligible veteran, so eligible for the button on what is really
 *     their first hand.
 *
 * Three house rules, all switched off by a deploy, silently.
 *
 * These are source-text guards in the house style. They pin the SHAPE — write
 * on every transition, read once on boot, and the veteran exclusion — because
 * the shape is what regressed and what a future refactor would quietly drop.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { sliceMethod, sliceEnclosingBlock, sliceBlockAfter } from '../testHelpers/sourceWindow.js';

const strip = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
const read = (p: string) => readFileSync(resolve(__dirname, '../../', p), 'utf8');

const BASE = strip(read('src/engine/ServerTableEngineBase.ts'));
const DEALING = strip(read('src/engine/ServerTableEngineDealing.ts'));
const SEATING = strip(read('src/engine/ServerTableEngineSeating.ts'));
const TABLES = strip(read('src/services/supabase/tables.ts'));

/* RAW, not stripped, for the per-method windows below.
 *
 * `strip` removes block comments with a non-greedy /\*...*\/ pass, and this
 * file's comment blocks are dense enough that the result no longer lines up
 * with the method boundaries the slice helpers look for — a window came back
 * ending mid-method and the assertion failed on code that was demonstrably
 * present. Asserting on the raw text is the honest fix; each assertion below
 * pins an exact CALL form (`this.persistEntryHold(userId, { ... });`) that
 * cannot appear in prose, so a comment mentioning the method by name does not
 * satisfy it. */
const RAW_SEATING = read('src/engine/ServerTableEngineSeating.ts');
const between = (src: string, from: string, to: string): string => {
  const a = src.indexOf(from);
  if (a < 0) throw new Error(`window start "${from}" not found`);
  const b = src.indexOf(to, a + from.length);
  if (b < 0) throw new Error(`window end "${to}" not found after "${from}"`);
  return src.slice(a, b);
};

describe('the entry hold is written down', () => {
  it('every transition that changes the hold also persists it', () => {
    // A writer that covers three of four transitions is worse than none: the
    // database then disagrees with memory and the restore puts back a state
    // the engine had already left.
    expect(BASE).toMatch(/protected persistEntryHold\(/);

    // ENTERING the hold.
    expect(between(RAW_SEATING, 'public registerWaitForBB', 'noteTournamentArrival')).toMatch(
      /this\.persistEntryHold\(userId, \{ hold: 'waiting' \}\);/
    );

    // AGREEING to post from a held seat, and POSTING for real.
    const post = between(RAW_SEATING, 'public postBBToEnter', 'protected queuePostToEnter');
    expect(post).toMatch(/this\.persistEntryHold\(userId, \{ hold: 'waiting', agreed: true \}\);/);
    expect(post).toMatch(/this\.persistEntryHold\(userId, \{ hold: 'posting', agreed: false \}\);/);

    // LEAVING the hold, both ways: the big blind arrives naturally, or the
    // owed live big blind is actually handed to the hand config.
    expect(DEALING).toMatch(/persistEntryHold\(userId, \{ hold: null, agreed: false \}\)/);
    const settle = sliceEnclosingBlock(DEALING, 'this.postingBBToEnter.clear()');
    expect(settle).toMatch(/persistEntryHold\(/);
  });

  it('the write is scoped to the LIVE seat', () => {
    // Without `left_at IS NULL` this can resurrect entry state onto a
    // historical row for a player who left and came back, and the restore
    // would then hold somebody the engine never held.
    const body = sliceMethod(BASE, 'protected persistEntryHold(');
    expect(body).toMatch(/const tableId = this\.tableId;/);
    expect(body).toMatch(/\.eq\('table_id', tableId\)/);
    expect(body).toMatch(/\.eq\('id', seatId\)/);
    expect(body).toMatch(/\.eq\('occupancy_id', occupancyId\)/);
    expect(body).toMatch(/\.eq\('user_id', userId\)/);
    expect(body).toMatch(/\.is\('left_at', null\)/);
  });

  it('the write never blocks the engine, and never fires on a tournament table', () => {
    // Durability is an improvement over a Set in memory; awaiting it would put
    // a network round trip between a player tapping a button and the engine
    // acting on it. And a tournament seat has no cash entry hold to record.
    const body = sliceMethod(BASE, 'protected persistEntryHold(');
    expect(body).toMatch(/if \(this\.isTournamentTable\(\)\) return;/);
    /* `Promise.resolve(supabase...)`, not bare `supabase...`. A PostgREST
       query builder is a THENABLE, not a Promise — it has `.then` and no
       `.catch` — so the fire-and-forget form the house style requires
       (`.then().catch()`, pinned by noUnhandledRejections.test.ts) does not
       typecheck against the builder directly. Promise.resolve is what gives it
       both halves; without it CI fails TS2339 on the missing `.catch`, which
       is exactly what happened on the first push of this change.

       2026-08-30: the write is now CHAINED PER USER rather than a bare
       `void` fire — two forgotten fires for the same player raced in
       production (register 'waiting' vs release null, same loop iteration:
       table 08746c1a seat 7) and the CLEAR lost, leaving a 'waiting' row on a
       player the engine was dealing. The chain keeps the fire-and-forget
       property (nothing awaits it) while making same-user writes land in
       decision order. */
    expect(body).toMatch(/entryHoldWriteChains\.get\(userId\)/);
    expect(body).toMatch(/Promise\.resolve\(\s*supabase/);
    expect(body).toMatch(/\.catch\(/);
    expect(body).not.toMatch(/await /);
  });

  it('the columns are actually read back - a write nobody reads is decorative', () => {
    // The exact failure mode this whole file exists for, and the third time
    // this same query has had it (is_sitting_out 2026-08-25, sit_out_at
    // 2026-08-28).
    expect(TABLES).toMatch(/entry_hold, entry_post_agreed/);
    expect(TABLES).toMatch(/entry_hold:/);
    expect(TABLES).toMatch(/entry_post_agreed:/);
  });
});

describe('the entry hold is put back on boot', () => {
  it('restores both the hold and any standing agreement', () => {
    const body = sliceMethod(BASE, 'protected restoreEntryHoldsFromSeats()');
    expect(body).toMatch(/waitingForBB\.add/);
    expect(body).toMatch(/postBBWhenClear\.add/);
    // 'posting' means they paid to come in and the restart landed before the
    // deal that bills it. The DEBT comes back, not the hold.
    expect(body).toMatch(/postingBBToEnter\.add/);
  });

  it('runs once per process, unlike the sit-out restore', () => {
    // restoreSitOutsFromSeats runs on every pass because the database owns
    // that fact continuously. An entry hold is released by the ENGINE
    // mid-orbit, so re-reading it every pass would race the fire-and-forget
    // write that clears it and re-hold a player already let in.
    const body = sliceMethod(BASE, 'protected restoreEntryHoldsFromSeats()');
    expect(body).toMatch(/if \(this\.entryHoldsRestored\) return;/);
    expect(body).toMatch(/this\.entryHoldsRestored = true;/);
    expect(BASE).toMatch(/protected entryHoldsRestored = false;/);
  });

  it('is reached from BOTH boot paths', () => {
    // A table below the minimum to deal never reaches the dealing loop, so the
    // wait loop needs it too or a held player on a quiet table is restored
    // only if and when the table fills.
    expect((DEALING.match(/restoreEntryHoldsFromSeats\(\)/g) || []).length).toBeGreaterThanOrEqual(
      1
    );
    expect(
      (BASE.match(/this\.restoreEntryHoldsFromSeats\(\)/g) || []).length
    ).toBeGreaterThanOrEqual(1);
  });

  it('restores BEFORE the veteran seeding, and a held player is not a veteran', () => {
    // This is the half that closes the free-button hole. Order matters: the
    // exclusion below reads waitingForBB, so the restore has to have run.
    expect(
      DEALING.indexOf('if (this.dealingLoopFirstIteration)'),
      'the first-iteration block moved'
    ).toBeGreaterThan(-1);
    // Bounded by the block's own braces, never a character count — a fixed
    // window drifts off the end of what it guards while staying green, which
    // is what noFixedSizeSourceWindows.test.ts exists to stop.
    const block = sliceBlockAfter(DEALING, 'if (this.dealingLoopFirstIteration)');
    const restore = block.indexOf('restoreEntryHoldsFromSeats()');
    const skip = block.indexOf('if (this.waitingForBB.has(p.user_id)) continue;');
    const veteran = block.indexOf('this.dealtInUserIds.add(p.user_id)');
    expect(restore, 'the boot restore is not in the first-iteration block').toBeGreaterThan(-1);
    expect(skip, 'held players are still seeded as veterans').toBeGreaterThan(-1);
    expect(restore).toBeLessThan(skip);
    expect(skip).toBeLessThan(veteran);
  });
});
