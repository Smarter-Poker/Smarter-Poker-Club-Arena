/**
 * LAW: a stats bypass names its writer.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * WHAT THIS IS ABOUT. Four AFTER INSERT trigger functions on `hand_history`
 * open with the same statement:
 *
 *     IF coalesce(current_setting('app.atomic_hand_commit',true),'')='on'
 *       THEN RETURN NEW; END IF;
 *
 * and `fn_ca_commit_hand_settlement` sets that GUC immediately before the hand
 * is inserted. It is deliberate and it is correct: migration
 * `20260908042100_an_accepted_hand_is_one_commit_and_stats_leave_the_hot_path`
 * put it there because those triggers were CANCELLING the hand they described
 * (726 hand_history INSERTs cancelled in one five-minute window on
 * 2026-09-07). The work moved behind a durable outbox and
 * `fn_project_hand_side_effects` does it after the commit.
 *
 * THE DANGER IS NOT THE BYPASS. It is a bypass whose compensating writer has
 * quietly gone, because the two halves live in different languages, different
 * files and different transactions, and NOTHING connected them. On 2026-09-12
 * an agent - working from a checkout 732 commits behind `main`, in which
 * `services/supabase/handProjection.ts` and the 2026-09-08/09 migrations do
 * not exist - read production, found the trigger returning on its first
 * statement, grepped its own tree for the callers of
 * `fn_project_hand_side_effects`, found none, and concluded the writer was
 * dead code that should be deleted and the GUC guard removed. Both changes
 * would have re-shipped the 2026-09-07 incident: five synchronous triggers
 * back on the hot path, plus the deletion of the function that had written
 * 548,234 of the previous day's 548,235 hands.
 *
 * So this law connects them, and it is deliberately cheap to read:
 *
 *   1. the GUC exists IN THE REPO (it was reported as existing nowhere in it);
 *   2. a migration that turns the bypass on carries the compensating work in
 *      the same file - either the stat write itself, or the durable outbox row
 *      a writer drains;
 *   3. the compensating writer really writes `ca_hand_player_stat`;
 *   4. the compensating writer is CALLED, by name, from the engine - the pin
 *      that answers "this function has no callers" with the file and line;
 *   5. the bypass branch is not silent, and the trigger still cannot block a
 *      hand.
 *
 * Registered in docs/laws.d/.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { migrationCorpus, migrationsMentioning } from './helpers/migrationCorpus';

const GUC = 'app.atomic_hand_commit';
const SETS_GUC = `set_config('${GUC}'`;
const READS_GUC = `current_setting('${GUC}'`;

/** The engine source that drains the outbox. */
const HAND_PROJECTION = readFileSync(
  resolve(__dirname, '..', 'server', 'src', 'services', 'supabase', 'handProjection.ts'),
  'utf8'
);

/** The body of the newest migration that (re)defines `fn`, by version order. */
function newestDefinition(fn: string): { file: string; body: string } {
  const re = new RegExp(`create\\s+(or\\s+replace\\s+)?function\\s+public\\.${fn}\\s*\\(`, 'i');
  let found: { file: string; body: string } | null = null;
  for (const { name: file, sql: text } of migrationCorpus()) {
    const m = re.exec(text);
    if (!m) continue;
    const start = m.index;
    const tagMatch = /AS\s+(\$[a-zA-Z_]*\$)/i.exec(text.slice(start));
    if (!tagMatch) continue;
    const tag = tagMatch[1];
    const bodyStart = start + tagMatch.index + tagMatch[0].length;
    const bodyEnd = text.indexOf(tag, bodyStart);
    if (bodyEnd < 0) continue;
    found = { file, body: text.slice(bodyStart, bodyEnd) };
  }
  if (!found) throw new Error(`no migration defines public.${fn}`);
  return found;
}

/** The four trigger functions the GUC actually gates, live, on hand_history. */
const GATED_TRIGGER_FUNCTIONS = [
  'fn_fold_hand_winnings',
  'trg_hand_history_position_stats',
  'trg_ca_stats_live_from_hand',
  'trg_hand_history_club_member_stats',
] as const;

/** The writer that owns those effects once the bypass is on. */
const COMPENSATING_WRITER = 'fn_project_hand_side_effects';
const WRITER_IMPLEMENTATION = 'fn_project_hand_side_effects_after_post_commit_20260908';

describe('LAW: a stats bypass names its writer', () => {
  it('the GUC that gates the live writers is declared in this repo, not only in production', () => {
    // It was reported on 2026-09-12 as appearing "nowhere in the repo - not in
    // supabase/migrations/, not in server/src/" while being the first line of
    // four live trigger functions. That reading came from a stale checkout.
    // This pin is what makes the claim checkable from now on.
    const declaring = migrationsMentioning(GUC);
    expect(
      declaring.map((m) => m.name),
      `no migration in this repo mentions ${GUC}, yet it gates four triggers on hand_history`
    ).not.toEqual([]);
  });

  it('every migration that turns the bypass ON carries the compensating work in the same file', () => {
    const setters = migrationCorpus().filter((m) => m.sql.includes(SETS_GUC));
    expect(setters.length, `no migration sets ${GUC}`).toBeGreaterThan(0);
    for (const m of setters) {
      const writesTheStat = /INSERT\s+INTO\s+public\.ca_hand_player_stat\b/i.test(m.sql);
      const enqueuesTheClaim = /INSERT\s+INTO\s+public\.hand_projection_outbox\b/i.test(m.sql);
      expect(
        writesTheStat || enqueuesTheClaim,
        `${m.name} sets ${GUC}, which makes four triggers decline to write, but it neither ` +
          'writes ca_hand_player_stat itself nor enqueues a hand_projection_outbox row for ' +
          `${COMPENSATING_WRITER} to drain. A bypass with no compensating writer is how stats ` +
          'stop being written without one test going red.'
      ).toBe(true);
    }
  });

  it('each gated trigger function really is gated, so the set is not stale', () => {
    for (const fn of GATED_TRIGGER_FUNCTIONS) {
      const def = newestDefinition(fn);
      expect(def.body, `${fn} (newest definition, ${def.file}) no longer reads ${GUC}`).toContain(
        READS_GUC
      );
    }
  });

  it('the compensating writer writes ca_hand_player_stat and the player index', () => {
    // The body has moved once already: 20260908042100 wrote the projections
    // inline in fn_project_hand_side_effects, and production has since split
    // the tail into fn_project_hand_side_effects_after_post_commit_20260908.
    // Pin the CHAIN, not whichever function currently holds the statements -
    // a law that pins the shape breaks on the next honest refactor and teaches
    // people to delete it.
    const entry = newestDefinition(COMPENSATING_WRITER);
    const writer = entry.body.includes(WRITER_IMPLEMENTATION)
      ? newestDefinition(WRITER_IMPLEMENTATION)
      : entry;
    expect(
      writer.body,
      `neither ${COMPENSATING_WRITER} (${entry.file}) nor the helper it delegates to writes ` +
        'ca_hand_player_stat. With the bypass on, nothing would.'
    ).toMatch(/INSERT\s+INTO\s+public\.ca_hand_player_stat\b/i);
    expect(writer.body).toMatch(/INSERT\s+INTO\s+public\.ca_hand_player_idx\b/i);
    // and it clears its own claim, or the outbox grows for ever
    expect(writer.body).toMatch(/DELETE\s+FROM\s+public\.hand_projection_outbox\b/i);
  });

  it('the compensating writer is CALLED by the engine - it is not dead code', () => {
    // The exact question that was answered "zero callers" from a stale tree.
    // The caller is TypeScript, over RPC, not another SQL function.
    expect(
      HAND_PROJECTION.includes(`'${COMPENSATING_WRITER}'`),
      `server/src/services/supabase/handProjection.ts no longer calls ${COMPENSATING_WRITER}. ` +
        'If the drain moved, move this pin with it in the same commit; if it was deleted, the ' +
        'atomic-commit path has no stats writer at all.'
    ).toBe(true);
    expect(HAND_PROJECTION).toContain('hand_projection_outbox');
  });

  it('the engine holds EXECUTE on the writer, or the drain is a permission error every hand', () => {
    const granted = migrationCorpus().some((m) =>
      new RegExp(
        `GRANT\\s+EXECUTE\\s+ON\\s+FUNCTION\\s+public\\.${COMPENSATING_WRITER}\\s*\\([^)]*\\)\\s*\\n?\\s*TO[^;]*service_role`,
        'i'
      ).test(m.sql)
    );
    expect(granted, `no migration grants service_role EXECUTE on ${COMPENSATING_WRITER}`).toBe(
      true
    );
  });

  it('the bypass branch says so, and says it at a bounded rate', () => {
    const trigger = newestDefinition('trg_ca_stats_live_from_hand');
    const bypass = trigger.body.slice(
      0,
      trigger.body.indexOf('RETURN NEW;') + 'RETURN NEW;'.length
    );
    expect(
      /RAISE\s+WARNING/i.test(bypass),
      'the bypass branch of trg_ca_stats_live_from_hand returns without writing and without ' +
        'saying so. A branch that is silent about declining is what turned a fifteen-second ' +
        'question into a full investigation on 2026-09-11.'
    ).toBe(true);
    // ... but not once per hand: this path carries ~550k hands a day, and a
    // per-hand log line is the hot-path cost 20260908042100 removed.
    expect(bypass).toContain('ca_stats_bypass_said_at');
  });

  it('a stat row still cannot block a hand', () => {
    // The reason the trigger has a catch-all at all. Whatever else changes
    // here, the hand lands.
    const trigger = newestDefinition('trg_ca_stats_live_from_hand');
    expect(trigger.body).toMatch(/EXCEPTION\s+WHEN\s+OTHERS\s+THEN/i);
    expect(trigger.body.trimEnd().endsWith('RETURN NEW;\nEND;')).toBe(true);
  });
});
