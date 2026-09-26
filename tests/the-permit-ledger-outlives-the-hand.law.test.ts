/**
 * ===========================================================================
 *  LAW: THE PERMIT LEDGER OUTLIVES THE HAND, SO IT IS NEVER PRUNED
 * ===========================================================================
 *
 * On 2026-09-25 smarter_private.f06_hand_permits was reported as having
 * exploded: "open hand permits" measured 1,139,125, against roughly 685 four
 * days earlier. A 1,600x jump in a table that gates dealing reads as a leak,
 * and the obvious repair reads as a retention policy. Both readings are wrong,
 * and this law exists so the second one is never shipped.
 *
 * WHAT THE ROWS SAID. Of the 1,139,125, exactly 1,138,606 were 'accepted' and
 * 524 were 'reserved'. 'accepted' is not an open state: the trigger
 * zzzz_f06_accepted_hand on public.hand_atomic_commits writes it the moment a
 * hand's post_commit_completed_at lands, and public.fn_f06_finish_hand then
 * refuses to move it ever again (F06_CHANGED_HAND_OUTCOME). It is the TERMINAL
 * SUCCESS record of one dealt hand. Counting it as open compares a permanent
 * receipt against a work queue, which is how a healthy ledger came to look
 * like an outage.
 *
 * It was organic, not a backfill: pg_stat_user_tables reported ins=1,140,433,
 * upd=1,140,224 and, decisively, count(*) = count(DISTINCT xmin) exactly, in
 * both halves of the population. Every row was written by its own transaction,
 * one per hand, back to the subsystem's first hand at 2026-09-18 02:03:22 UTC.
 * And del=0: nothing has ever removed a row.
 *
 * WHY del=0 IS THE DESIGN AND NOT AN OVERSIGHT. This is the part nobody had
 * written down, and it is the reason for this file.
 *
 * public.fn_f06_begin_hand refuses to re-use a hand number on a table
 * ("hand_number_already_used") if ANY of three witnesses still says it was
 * used: the permit, public.hand_atomic_commits, or public.hand_history. Two of
 * those three are pruned. public.sp_prune_hand_history deletes BOTH
 * hand_atomic_commits and hand_history for horse-only hands at
 * hand_history_retention_policy.horse_retention_days, eight days by Dan's
 * instruction of 2026-09-17.
 *
 * So eight days after a hand is dealt, THE PERMIT IS THE ONLY SURVIVING RECORD
 * THAT ITS HAND NUMBER WAS EVER USED. Measured 2026-09-25: no permit had yet
 * lost its commit or its history row, and the first crossing was 12.4 hours
 * away, at 2026-09-26 02:03:20 UTC. From that moment the ledger is load
 * bearing. Prune it and a hand number becomes re-usable on a table that has
 * already dealt it, on a platform where (table_id, hand_number) is the key
 * every settlement, rake attribution and custody proof is filed under.
 *
 * smarter_private.f06_movement_permits says the same thing from the other
 * side, in its own comment: "Every permit this table ever held must be DECIDED
 * before its players move." It reads them all, and for an 'accepted' permit it
 * refuses when the commit row is absent. A pruning pass would not only allow a
 * re-used hand number, it would wedge player movement on the tables it touched.
 *
 * THE GROWTH IS REAL AND IT IS ONLY STORAGE. 326 MB for 1.14M rows over 7.45
 * days, about 44 MB/day, unbounded. It costs no hot query: 45,862,493 index
 * scans against 413 sequential ones, f06_hand_dispatch_guard looks the permit
 * up by the unique (table_id, hand_number), and the widest per-table fan-out
 * in the whole table was 443 rows (p50 35, p95 95, zero tables over 1,000)
 * because a tournament table lives hours. If that bill ever has to be paid,
 * the answer is an archive that keeps (table_id, hand_number, state) for ever,
 * or Dan's decision to let hand numbers be re-used. It is not a DELETE.
 *
 * WHAT THIS LAW DOES NOT SAY. It does not say the reserved set is healthy. On
 * the same day 492 of the 524 reserved permits carried a dead lease generation
 * and wedged 492 live tables holding 2,061 seated players and 14,210,568
 * chips. That is a different defect with a different fix, already merged as
 * #5163 (server/src/tournament/abandonedGenerationDoor.ts, calling
 * public.fn_f06_abort_abandoned_generation) and waiting only on the engine
 * cutover. The open set cannot be the source of unbounded growth in any case,
 * because f06_one_hand caps it at one reserved permit per table; the cap pin
 * below keeps that declared.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(__dirname, '..');
const PERMITS = 'f06_hand_permits';

/** Directories where a write against the ledger could be authored. */
const SCANNED = ['supabase/migrations', 'server/src', 'src', 'scripts'];

/**
 * DELETE FROM [smarter_private.]f06_hand_permits, allowing the schema
 * qualifier and arbitrary whitespace. Deliberately anchored on the DELETE verb
 * so a DELETE against another table that merely mentions permits in a
 * subquery, a comment or a WHERE clause is not a finding.
 */
const DELETE_PERMITS = new RegExp(
  String.raw`delete\s+from\s+(?:only\s+)?(?:smarter_private\s*\.\s*)?"?${PERMITS}"?`,
  'i'
);

/**
 * TRUNCATE [TABLE] [ONLY] [smarter_private.]f06_hand_permits. Anchored the
 * same way: the access-catalog fixtures under scripts/ci carry hundreds of
 * `TRUNCATE ON TABLE <other table> TO <role>` GRANT lines, which name the
 * privilege and not this relation, and must not read as findings.
 */
const TRUNCATE_PERMITS = new RegExp(
  String.raw`truncate\s+(?:table\s+)?(?:only\s+)?(?:smarter_private\s*\.\s*)?"?${PERMITS}"?`,
  'i'
);

function walk(dir: string, out: string[] = []): string[] {
  const abs = path.join(ROOT, dir);
  if (!fs.existsSync(abs)) return out;
  for (const entry of fs.readdirSync(abs, { withFileTypes: true })) {
    const rel = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === '.git') continue;
      walk(rel, out);
    } else if (/\.(sql|ts|tsx|js|mjs|cjs)$/.test(entry.name)) {
      out.push(rel);
    }
  }
  return out;
}

const FILES = SCANNED.flatMap((d) => walk(d));

/** Read once: the migration tree alone is thousands of files. */
const CONTENTS = new Map<string, string>(
  FILES.map((f) => [f, fs.readFileSync(path.join(ROOT, f), 'utf8')])
);

const MIGRATIONS = FILES.filter((f) => f.startsWith(path.join('supabase', 'migrations')));

describe('the permit ledger outlives the hand, so it is never pruned', () => {
  it('scans a real tree (guards against a silently empty sweep)', () => {
    // 10.86 rule 2: a check that found no files must not read as a pass.
    expect(FILES.length).toBeGreaterThan(1000);
    expect(MIGRATIONS.length).toBeGreaterThan(1000);
  });

  it('nothing anywhere DELETEs from the permit ledger', () => {
    const offenders = [...CONTENTS]
      .filter(([, body]) => DELETE_PERMITS.test(body))
      .map(([file]) => file);
    expect(
      offenders,
      'A permit is the last witness that a hand number was used once retention ' +
        'has taken hand_atomic_commits and hand_history (eight days). Deleting one ' +
        'lets fn_f06_begin_hand re-issue a hand number the table already dealt, and ' +
        'makes f06_movement_permits refuse that table for ever. Archive the row, do ' +
        'not delete it. See docs/changelog/2026-09-25-the-permit-ledger-outlives-the-hand.md'
    ).toEqual([]);
  });

  it('nothing anywhere TRUNCATEs the permit ledger', () => {
    const offenders = [...CONTENTS]
      .filter(([, body]) => TRUNCATE_PERMITS.test(body))
      .map(([file]) => file);
    expect(offenders, 'TRUNCATE is a DELETE that skips the triggers as well.').toEqual([]);
  });

  it('the hand-history retention job never names the permit ledger as a delete target', () => {
    // sp_prune_hand_history is the ONE job that deletes hand evidence on a
    // clock. EVERY migration that has ever defined it is checked for the
    // negative, so a later redefinition cannot slip past a hardcoded filename.
    const definers = MIGRATIONS.filter((f) =>
      /create\s+or\s+replace\s+function\s+(?:public\s*\.\s*)?sp_prune_hand_history/i.test(
        CONTENTS.get(f) as string
      )
    ).sort();
    expect(definers.length, 'sp_prune_hand_history must be defined in a migration').toBeGreaterThan(
      0
    );
    for (const f of definers) {
      expect(
        DELETE_PERMITS.test(CONTENTS.get(f) as string),
        `${f} must not delete ${PERMITS}`
      ).toBe(false);
    }

    // The POSITIVE is asserted only against the CURRENT definer, because the
    // premise of this law is about what retention takes away TODAY. The first
    // version of this job (20260816_hand_history_90d_retention.sql, a 90-day
    // policy) deleted hand_history alone, and a rule that fails on history is
    // a rule somebody switches off (the same reasoning as
    // a-banned-character-must-not-reach-the-database).
    const current = definers[definers.length - 1];
    const body = CONTENTS.get(current) as string;
    expect(
      /delete\s+from\s+(?:public\s*\.\s*)?"?hand_atomic_commits"?/i.test(body),
      `${current} is the current retention job and is expected to prune hand_atomic_commits; ` +
        'if it no longer does, the permit is no longer the last surviving witness and the ' +
        'reasoning in this law needs rereading before it is relaxed'
    ).toBe(true);
    expect(
      /delete\s+from\s+(?:public\s*\.\s*)?"?hand_history"?/i.test(body),
      `${current} is the current retention job and is expected to prune hand_history`
    ).toBe(true);
  });

  it('the open set stays capped at one reserved permit per table', () => {
    // f06_one_hand is why the OPEN population can never be the source of
    // unbounded growth: it is a unique partial index keyed on the table alone.
    // Without it, "open permits exploded" would one day be a true sentence.
    const creates = MIGRATIONS.filter((f) =>
      /create\s+unique\s+index[^;]*f06_one_hand[^;]*\(\s*table_id\s*\)[^;]*where[^;]*'reserved'/is.test(
        CONTENTS.get(f) as string
      )
    );
    expect(
      creates.length,
      'f06_one_hand must remain a UNIQUE index on (table_id) WHERE state = reserved'
    ).toBeGreaterThan(0);
  });

  it('an accepted permit is immutable, which is what makes it a terminal record', () => {
    // If accepted could be rewritten, it would be a work state and the count
    // would mean something else entirely. fn_f06_finish_hand is where that is
    // refused, by name.
    const guarded = MIGRATIONS.filter((f) =>
      /F06_CHANGED_HAND_OUTCOME/.test(CONTENTS.get(f) as string)
    );
    expect(
      guarded.length,
      'fn_f06_finish_hand must keep refusing a changed outcome (F06_CHANGED_HAND_OUTCOME)'
    ).toBeGreaterThan(0);
  });
});
