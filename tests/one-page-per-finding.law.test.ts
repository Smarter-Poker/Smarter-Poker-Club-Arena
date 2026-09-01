/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  ONE PAGE PER FINDING — LAW (Dan, 2026-09-01, binding)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Dan: "im getting double push notifications for every chip drift again,
 * thats has to stop, one notification one time is all that i need."
 *
 * AGAIN is the word this file exists for. Two previous attempts both reached
 * for a clock, and a clock cannot solve this:
 *
 *   * fn_ca_raise_drift_incident suppresses at >= 10 incidents in 2 minutes.
 *     A pair never reaches ten, so it has never once fired for Dan's case.
 *   * fn_ca_incident_notify collapsed at >= 3 pushes to a recipient in 5
 *     minutes, counted BEFORE sending. Pushes one and two therefore ALWAYS
 *     went out. A double is structurally immune to a three-in-five digest,
 *     which is exactly why Dan received precisely two, every time.
 *
 * The real defect was that the send was keyed to the incident ROW, not to the
 * finding. Production evidence, all of it real:
 *
 *   17:28:48.927063 / .927145  two incident rows 82 microseconds apart,
 *                              identical to a reader, differing only in an
 *                              md5 salt inside dedupe_key -> two pushes
 *   13:42:17.910620            three "Resolved: treasury_error" at ONE
 *                              instant, from one bulk resolve loop
 *   20:10:20.800684 (08-31)    twenty-plus of the same, same instant
 *   17:30 and 18:00            'suspense-regression:YYYY-MM-DD-HH24' puts the
 *                              HOUR in the key, so an unchanged condition
 *                              minted a new incident and paged on the hour
 *
 * So the law is about the SHAPE of the key, not about how loud the alarm is:
 *
 *   1. The send is recorded against the FINDING (ca_incident_notify_ledger),
 *      and a second send for an unchanged finding is a no-op.
 *   2. No clock may appear in a notification dedupe key. A key containing
 *      to_char(now(), ...) re-pages a standing condition forever, one bucket
 *      at a time.
 *   3. No time window may be reintroduced into fn_ca_incident_notify as the
 *      dedupe. Both that were tried let every double through.
 *
 * Verified against production 2026-09-01 with rolled-back probes:
 *   two rows, one finding      -> raises=1
 *   three rows, one finding    -> raises=1, resolves=1
 *   amount jitters, same state -> 0
 *   severity warning->critical -> 1  (a changed drift still pages at once)
 *   resolved, then recurs      -> 1  (a resolved finding re-arms)
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

const MIGRATIONS = path.join(process.cwd(), 'supabase', 'migrations');

/** Migration filenames are timestamps, so lexical order is chronological. */
function migrationFiles(): string[] {
  return fs
    .readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith('.sql'))
    .sort();
}

/**
 * The definition that actually wins: the LAST `CREATE OR REPLACE FUNCTION
 * public.<name>(` block across every migration, in chronological order.
 * Matched at line start so a definition quoted inside a DO/replace() patch
 * block cannot be mistaken for the real one.
 */
function latestDefinition(name: string): string {
  let found = '';
  for (const file of migrationFiles()) {
    const sql = fs.readFileSync(path.join(MIGRATIONS, file), 'utf8');
    const re = new RegExp(
      `^CREATE OR REPLACE FUNCTION public\\.${name}\\s*\\([\\s\\S]*?\\$function\\$;`,
      'gm'
    );
    const hits = sql.match(re);
    if (hits && hits.length) found = hits[hits.length - 1];
  }
  return found;
}

/** Strip SQL comments, so prose describing the old bug cannot fail a guard. */
function code(sql: string): string {
  return sql.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*--.*$/gm, '');
}

describe('one page per finding, not one per row', () => {
  it('the send is recorded against the finding, in a ledger', () => {
    const notify = code(latestDefinition('fn_ca_incident_notify'));
    expect(notify).not.toBe('');
    expect(notify).toContain('ca_incident_notify_ledger');
    expect(notify).toContain('fn_ca_finding_key');
  });

  it('no time window is the dedupe inside the sender', () => {
    const notify = code(latestDefinition('fn_ca_incident_notify'));
    // Both failed fixes counted recent notifications and collapsed on a
    // threshold. Neither can stop a double, because the count is taken before
    // the send. If this line ever comes back, read the header of this file.
    expect(notify).not.toMatch(/interval\s*'\s*\d+\s*minutes?\s*'/);
    expect(notify).not.toMatch(/FROM\s+public\.notifications/i);
  });

  it('a finding key never contains a clock', () => {
    const key = code(latestDefinition('fn_ca_finding_key'));
    expect(key).not.toBe('');
    expect(key).not.toMatch(/now\s*\(\s*\)/);
    expect(key).not.toMatch(/current_(date|timestamp)/i);
  });

  it('no drift producer buckets its dedupe key by the clock', () => {
    // A dedupe key that carries YYYY-MM-DD or the hour mints a fresh incident
    // when the bucket rolls over, and pages again for a condition nobody has
    // resolved. Resolving the incident is what re-arms the alarm - not
    // midnight, and not the top of the hour.
    for (const fn of ['fn_ca_journal_append_only', 'fn_ca_suspense_regression_check']) {
      const def = code(latestDefinition(fn));
      expect(def, `${fn} has no definition in supabase/migrations`).not.toBe('');
      expect(def, `${fn} still buckets its dedupe key by the clock`).not.toMatch(
        /to_char\s*\(\s*now\s*\(\s*\)/
      );
    }
  });
});
