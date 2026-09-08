/**
 * ═════════════════════════════════════════════════
 *  AN ID LIST GOES IN THE URL, SO IT HAS A CEILING
 * ═════════════════════════════════════════════════
 *
 * Found 2026-09-03 auditing the club-programme work, and it was already live:
 * HorseSessionRotator handed one `.in()` 713 seated user ids, PostgREST
 * answered HTTP 400 (its ceiling on this table is 675 ids, ~25 KB of URL),
 * the error was discarded, and `horseIds` came back EMPTY. That does not read
 * as "the query failed", it reads as "nobody in the room is a horse" - so the
 * whole humanisation service went silent with no log at all: no session ends,
 * no breaks, no top-ups, no table changes, and no retirement drain.
 *
 * The sweep that followed found seven more of the same shape, three already
 * past the ceiling at the floor size of the day (1,131 tables).
 *
 * These pins hold the rule at the call sites where an id list grows with the
 * ROOM rather than with one table, because the failure is invisible: the
 * feature simply stops, and every symptom looks like "there was nothing to do".
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { IN_LIST_CHUNK, selectInChunks } from './supabase/chunkedIn.js';

// cwd is server/ when this suite runs (server/vitest.config.ts)
const src = (rel: string) => readFileSync(join(process.cwd(), rel), 'utf8');

describe('the shared helper', () => {
  it('chunks at the estate convention of 200', () => {
    expect(IN_LIST_CHUNK).toBe(200);
  });

  it('splits a list into chunks and concatenates the rows', async () => {
    const ids = Array.from({ length: 450 }, (_, i) => `id-${i}`);
    const seen: number[] = [];
    const out = await selectInChunks<{ id: string }>(
      ids,
      (batch) => {
        seen.push(batch.length);
        return Promise.resolve({ data: batch.map((id) => ({ id })), error: null });
      },
      'test'
    );
    expect(seen).toEqual([200, 200, 50]);
    expect(out.complete).toBe(true);
    expect(out.rows).toHaveLength(450);
  });

  it('de-duplicates and drops blanks before it counts', async () => {
    const seen: string[][] = [];
    const out = await selectInChunks<{ id: string }>(
      ['a', 'a', '', null, undefined, 'b'],
      (batch) => {
        seen.push(batch);
        return Promise.resolve({ data: [], error: null });
      },
      'test'
    );
    expect(seen).toEqual([['a', 'b']]);
    expect(out.complete).toBe(true);
  });

  it('an empty list asks nothing and is complete', async () => {
    let called = 0;
    const out = await selectInChunks(
      [],
      () => {
        called++;
        return Promise.resolve({ data: [], error: null });
      },
      'test'
    );
    expect(called).toBe(0);
    expect(out).toEqual({ rows: [], complete: true });
  });

  it('THE POINT: a failure is never an empty answer', async () => {
    const out = await selectInChunks<{ id: string }>(
      Array.from({ length: 300 }, (_, i) => `id-${i}`),
      (batch) =>
        batch[0] === 'id-0'
          ? Promise.resolve({ data: batch.map((id) => ({ id })), error: null })
          : Promise.resolve({ data: null, error: { message: 'URI too long' } }),
      'test'
    );
    expect(out.complete).toBe(false);
    // the rows it did read are still returned, but `complete` is the answer
    expect(out.rows).toHaveLength(200);
  });

  it('a throw is caught and reported as incomplete, never as empty', async () => {
    const out = await selectInChunks<{ id: string }>(
      ['a'],
      () => {
        throw new Error('socket hang up');
      },
      'test'
    );
    expect(out.complete).toBe(false);
    expect(out.rows).toEqual([]);
  });
});

describe('the call sites whose id list grows with the room', () => {
  it('the session rotator resolves horse identity in chunks and declines a failed pass', () => {
    const rotator = src('src/services/HorseSessionRotator.ts');
    expect(rotator).toMatch(/selectInChunks<\{ id: string \}>\(\s*userIds,/);
    expect(rotator).toMatch(/if \(!horseRead\.complete\) return;/);
    // and it never goes back to the one-shot read that failed at 713 ids
    expect(rotator).not.toMatch(/\.in\('id', userIds\)/);
  });

  it('the rotator reads bankrolls in chunks too - that one uncapped a top-up', () => {
    const rotator = src('src/services/HorseSessionRotator.ts');
    expect(rotator).toMatch(/'HorseSessionRotator\.bankrollRolls'/);
    expect(rotator).not.toMatch(/\.in\('user_id', horseSeatIds\)/);
  });

  it('the fleet-death watchdog counts hands in chunks', () => {
    const verifier = src('src/services/DealRateVerifier.ts');
    expect(verifier).toMatch(/for \(let i = 0; i < tableIds\.length; i \+= IN_LIST_CHUNK\)/);
    expect(verifier).toMatch(/DealRateVerifier\.hand_count_chunk_failed/);
    expect(verifier).not.toMatch(/\.in\('table_id', tableIds\)/);
  });

  it('the cash-floor reserve counts seats in chunks and reports a failure', () => {
    const recurring = src('src/services/TournamentRecurringService.ts');
    expect(recurring).toMatch(/TournamentRecurring\.cash_floor_reserve_read_failed/);
    expect(recurring).not.toMatch(/\.in\('table_id', ids\);/);
  });

  it('the horse lifecycle reset reads a finished field in chunks', () => {
    const lifecycle = src('src/services/HorseLifecycleManager.ts');
    expect(lifecycle).toMatch(/HorseLifecycle\.horsesInField/);
    expect(lifecycle).toMatch(/if \(!profileRead\.complete\) continue;/);
    expect(lifecycle).not.toMatch(/\.in\('id', playerIds\)/);
  });

  it('late-reg seating never reads a failed seat query as an empty room', () => {
    const manager = src('src/tournament/TournamentManager.ts');
    expect(manager).toMatch(/Tournament\.lateRegSeated/);
    expect(manager).toMatch(
      /if \(!seatRead\.complete\) \{[\s\S]*?requestUrgentEliminationSweepAfter\(TournamentManagerBase\.LATE_REG_REDRIVE_MS\);[\s\S]*?return;[\s\S]*?\}/
    );
  });

  it('the busted seat release is chunked, and reaches the error reporter', () => {
    const elim = src('src/tournament/TournamentManagerEliminations.ts');
    expect(elim).toMatch(/tableIds\.slice\(offset, offset \+ IN_LIST_CHUNK\)/);
    expect(elim).toMatch(/'Tournament\.committed_cleanup_seat_release_failed'/);
  });

  it('fleet add-ons read the field in chunks', () => {
    const base = src('src/tournament/TournamentManagerBase.ts');
    expect(base).toMatch(/Tournament\.addOnHorses/);
    expect(base).toMatch(
      /if \(!horseRead\.complete\) \{[\s\S]*?requestUrgentEliminationSweepAfter\(TournamentManagerBase\.ADD_ON_RETRY_MS\);[\s\S]*?return;[\s\S]*?\}/
    );
    expect(base).not.toMatch(/\.in\('id', candidates\)/);
  });
});
