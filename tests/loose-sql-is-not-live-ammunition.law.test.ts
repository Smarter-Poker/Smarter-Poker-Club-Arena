/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  LOOSE SQL IN supabase/ IS NOT LIVE AMMUNITION (2026-09-02)
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * The second audit pass after phase 7. Phase 7 dropped four objects and repointed
 * every surface that read them; the sweep afterwards found the surfaces clean and
 * the database clean. What it did NOT find, until this pass, was the loose SQL
 * sitting in `supabase/` beside the seeds, outside `supabase/migrations/`, where
 * nothing versions it, no CI check reads it, and the next agent to open the folder
 * finds it and runs it.
 *
 * Two files were removed here. Both were dangerous in the same way: they read as
 * instructions, and following them damaged production.
 *
 *   1. `APPLY_NOW_consolidated_realtime.sql` — its NAME is a command. Measured
 *      against production on 2026-09-02, running it would have issued THIRTEEN
 *      `ALTER PUBLICATION supabase_realtime ADD TABLE` statements, one of them
 *      for `hand_history`: 3.6 GB, ~221,000 rows a day, every insert then
 *      streamed through the WAL decoder to realtime subscribers. And each of
 *      those thirteen is a DDL statement outside a transaction, so each fires
 *      `pgrst_ddl_watch` and a ~28-second PostgREST schema-cache reload — the
 *      exact shape of the 2026-08-31 PGRST002 outage that 503'd up to 28% of
 *      live traffic, which CLAUDE.md's "Production DDL policy" is written to
 *      prevent. The file was dated 2026-03-14 and was NOT already applied: 16
 *      of its tables were published, 13 were not, 9 no longer exist.
 *
 *   2. `atomic_rake_increments.sql` — re-created `increment_agent_rake`, which
 *      phase 7 dropped, against `agents.rake_generated`, a column that does not
 *      exist; clobbered the live `increment_rake_generated` (three real
 *      overloads in production) with a body targeting `club_members.rake_generated`,
 *      which also does not exist; and ended with `CREATE POLICY IF NOT EXISTS`,
 *      which is not valid PostgreSQL in any version, attaching a `FOR ALL
 *      USING (TRUE) WITH CHECK (TRUE)` policy to `financial_alerts` under a
 *      comment claiming it restricted access to admins.
 *
 * This is the precedent CLAUDE.md section 1.3 already set when it deleted
 * `scripts/antigravity-deploy.sh`: "a file the rules name as forbidden, sitting
 * where an agent will find it, is a trap." The rule survives as a check.
 *
 * THE LAW: `supabase/` outside `migrations/` holds seeds and read-only
 * inspection scripts. Schema changes go in a numbered migration, in ONE
 * transaction, per CLAUDE.md's Production DDL policy. Nothing loose in there
 * may carry DDL, and nothing in there may name an object phase 7 dropped.
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

const SUPABASE_DIR = path.join(process.cwd(), 'supabase');

/** Every file directly in supabase/, excluding migrations/ and functions/. */
const looseFiles = fs
  .readdirSync(SUPABASE_DIR, { withFileTypes: true })
  .filter((e) => e.isFile())
  .map((e) => e.name);

const readLoose = (name: string) => fs.readFileSync(path.join(SUPABASE_DIR, name), 'utf8');

describe('the two trap files stay deleted', () => {
  it.each(['APPLY_NOW_consolidated_realtime.sql', 'atomic_rake_increments.sql'])(
    '%s is gone',
    (name) => {
      expect(fs.existsSync(path.join(SUPABASE_DIR, name))).toBe(false);
    }
  );

  it('and no replacement announces itself as something to run now', () => {
    const commanding = looseFiles.filter((n) => /^(APPLY|RUN|EXECUTE)[_-]?NOW/i.test(n));
    expect(commanding).toEqual([]);
  });
});

describe('loose SQL in supabase/ carries no DDL', () => {
  // A schema change belongs in supabase/migrations/, in one transaction, so
  // Postgres coalesces the schema-cache reload NOTIFYs. See CLAUDE.md,
  // "Production DDL policy (added 2026-08-31 after the PGRST002 503 outage)".
  const DDL =
    /\b(ALTER\s+PUBLICATION|CREATE\s+(OR\s+REPLACE\s+)?FUNCTION|CREATE\s+POLICY|ALTER\s+TABLE|DROP\s+(FUNCTION|TABLE|POLICY)|CREATE\s+TRIGGER)\b/i;

  it.each(looseFiles.filter((n) => n.endsWith('.sql') || n.endsWith('.mjs')))(
    '%s is data or inspection only',
    (name) => {
      const src = readLoose(name);
      const offending = src.split('\n').filter((line) => !/^\s*--/.test(line) && DDL.test(line));
      expect(offending).toEqual([]);
    }
  );
});

describe('nothing loose in supabase/ names an object phase 7 dropped', () => {
  // commission_records and commission_history held zero rows for their whole
  // lives while the app read them; agents.pending_commission was written by
  // one function and read by the UI; increment_agent_rake was that function.
  // All four went on 2026-09-01. A seed that still writes them fails on run
  // and leaves a fresh dev database with an empty agent dashboard.
  const DROPPED = /(commission_records|commission_history|pending_commission|increment_agent_rake)/;

  it.each(looseFiles.filter((n) => n.endsWith('.sql') || n.endsWith('.mjs')))(
    '%s reads the ledger, not the dropped tables',
    (name) => {
      const src = readLoose(name);
      const offending = src
        .split('\n')
        .filter((line) => !/^\s*(--|\/\/|\*)/.test(line) && DROPPED.test(line));
      expect(offending).toEqual([]);
    }
  );

  it('the seeds write agent_commissions instead', () => {
    expect(readLoose('run_seed_v2.mjs')).toMatch(/up\('agent_commissions'/);
    expect(readLoose('seed_jaqk_part3_financial_social.sql')).toMatch(
      /INSERT INTO agent_commissions \(id, club_id, user_id, amount, commission_rate, source_type, notes, settled_at, created_at\)/
    );
  });

  it('and seed rows land unclaimed, because nobody has claimed them', () => {
    // settled_at IS NULL is what the Records tab renders as Unclaimed and what
    // fn_agent_claim_commission pays out. Seeding them settled would seed a
    // dashboard showing money already taken.
    expect(readLoose('seed_jaqk_part3_financial_social.sql')).toMatch(/NULL, NOW\(\) - INTERVAL/);
    expect(readLoose('run_seed_v2.mjs')).toMatch(/settled_at: null/);
  });
});
