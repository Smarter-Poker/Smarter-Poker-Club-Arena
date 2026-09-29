/**
 * ===========================================================================
 *  LAW: AN INCIDENT IS BORN WITH THE REPAIR STATUS IT WILL ACTUALLY GET
 * ===========================================================================
 *
 * Until 20260922141524 every row in ca_drift_incidents was born with
 * auto_repair_status = 'pending', the column default. 'pending' claims that an
 * automatic repair is queued. For every classification except incorrect_rake
 * and bbj_error none existed, and the only code that acted on the claim was
 * fn_ca_auto_reconcile_tick, a pg_cron job that ran every minute to:
 *
 *   - wait ten minutes and rewrite 'pending' to 'manual_needed'
 *     (139 rewrites in the 7 days measured, 4,952 ever), and
 *   - for the two rake classifications, call fn_redrive_unbanked_rake and
 *     fn_bbj_repair_unbanked every minute the incident stayed open: 7,774
 *     re-drive pairs in 7 days, 9,176 for one rake-spec incident no re-drive
 *     could touch, and zero chips moved by any of them in 13 days.
 *
 * The page a person received at birth said "Auto-repair: pending." about an
 * incident nothing would ever repair.
 *
 * The fix is one column default: an incident is born 'manual_needed'. The tick
 * selects only ('pending','running'), so it has no work from then on, and the
 * owner's rule (no repair loop may compensate for a defect) can retire it.
 *
 * WHAT THIS LAW PINS
 *
 *   1. The fix: the default is manual_needed and the migration proves it live,
 *      in both directions (the writers inherit it; the column was not
 *      loosened to get there).
 *   2. THE ONE THAT MATTERS LATER: from 20260922141524 no migration may make an
 *      incident claim an automatic repair again - no 'pending' or 'running'
 *      default, no write of either value, and no DROP DEFAULT (which would not
 *      free anything: the column is NOT NULL, so every insert would fail and
 *      no incident would ever be filed).
 *   3. The detector is live: it is run against the shapes it refuses and the
 *      shapes it must allow, so a regex that stopped matching cannot pass
 *      silently.
 *
 * NOTE ON ASSERTING THE NEGATIVE (CLAUDE.md 7.3): the fix's own header quotes
 * the values it retires, so every scan below runs on a copy with SQL comments
 * blanked. String literals are KEPT, because the values being policed are
 * literals.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { sliceDollarQuoted, sliceSqlStatement } from './helpers/sourceWindow';

const MIGRATIONS = join(__dirname, '..', 'supabase', 'migrations');
const FIX = '20260922141524_an_incident_is_born_with_the_repair_status_it_will_get.sql';
const FORWARD_GUARD_FROM = '20260922141524';

const read = (file: string): string => readFileSync(join(MIGRATIONS, file), 'utf8');

/**
 * `sql` with every SQL comment blanked and everything else - string literals,
 * dollar-quoted bodies - left exactly where it was. Length and newlines are
 * preserved.
 *
 * A left-to-right scanner. Dollar quotes are deliberately transparent: a
 * function body is code, and a comment inside it is still a comment. A quote
 * that opens a literal hides any `--` inside that literal; a `--` or a `/*`
 * reached outside a literal hides any quote inside the comment.
 */
const withoutComments = (sql: string): string => {
  const out = sql.split('');
  const n = sql.length;
  const blank = (from: number, to: number): void => {
    for (let k = from; k < to && k < n; k++) {
      if (out[k] !== '\n') out[k] = ' ';
    }
  };
  let i = 0;
  while (i < n) {
    if (sql.startsWith('--', i)) {
      const nl = sql.indexOf('\n', i);
      const to = nl < 0 ? n : nl;
      blank(i, to);
      i = to;
      continue;
    }
    if (sql.startsWith('/*', i)) {
      const close = sql.indexOf('*/', i + 2);
      const to = close < 0 ? n : close + 2;
      blank(i, to);
      i = to;
      continue;
    }
    if (sql[i] === "'") {
      let j = i + 1;
      while (j < n) {
        if (sql[j] === "'" && sql[j + 1] === "'") {
          j += 2;
          continue;
        }
        if (sql[j] === "'") {
          j++;
          break;
        }
        j++;
      }
      i = j;
      continue;
    }
    i++;
  }
  return out.join('');
};

/** The values that claim an automatic repair is queued or in flight. */
const CLAIMS = /'(pending|running)'/i;

/** Every way a migration could make an incident claim a repair again. */
const offendersIn = (sqlSource: string): string[] => {
  const code = withoutComments(sqlSource);
  const found: string[] = [];

  for (const m of code.matchAll(
    /\bALTER\s+(?:COLUMN\s+)?auto_repair_status\s+SET\s+DEFAULT\s+'([A-Za-z_]+)'/gi
  )) {
    if (m[1].toLowerCase() !== 'manual_needed') {
      found.push(`sets the auto_repair_status default to '${m[1]}'`);
    }
  }
  if (/\bALTER\s+(?:COLUMN\s+)?auto_repair_status\s+DROP\s+DEFAULT\b/i.test(code)) {
    found.push('drops the auto_repair_status default (NOT NULL then refuses every incident)');
  }
  if (/\bauto_repair_status\s+text\b[^,;]*?\bDEFAULT\s+'(pending|running)'/i.test(code)) {
    found.push('declares auto_repair_status with a pending or running default');
  }
  for (const m of code.matchAll(
    /\bUPDATE\s+(?:public\.)?ca_drift_incidents\b[\s\S]*?\bSET\b([\s\S]*?)(?:\bWHERE\b|\bRETURNING\b|;)/gi
  )) {
    if (/\bauto_repair_status\s*=\s*'(pending|running)'/i.test(m[1])) {
      found.push('updates an incident to claim a pending or running repair');
    }
  }
  if (/\bNEW\s*\.\s*auto_repair_status\s*:?=\s*'(pending|running)'/i.test(code)) {
    found.push('assigns a pending or running repair status in a trigger');
  }
  let at = code.search(/\bINSERT\s+INTO\s+(?:public\.)?ca_drift_incidents\b/i);
  while (at >= 0) {
    const statement = sliceSqlStatement(code.substring(at), code.substring(at).split(/\s/)[0]);
    if (/\bauto_repair_status\b/i.test(statement) && CLAIMS.test(statement)) {
      found.push('inserts an incident that names a pending or running repair status');
    }
    const next = code
      .substring(at + statement.length)
      .search(/\bINSERT\s+INTO\s+(?:public\.)?ca_drift_incidents\b/i);
    at = next < 0 ? -1 : at + statement.length + next;
  }
  return found;
};

describe('an incident is born with the repair status it will actually get', () => {
  describe('the fix', () => {
    const sql = read(FIX);
    const code = withoutComments(sql);

    it('defaults auto_repair_status to manual_needed', () => {
      expect(sliceSqlStatement(code, 'ALTER TABLE public.ca_drift_incidents')).toMatch(
        /ALTER\s+COLUMN\s+auto_repair_status\s+SET\s+DEFAULT\s+'manual_needed'/
      );
    });

    it('proves the new behaviour live: the default reads back as manual_needed', () => {
      const verify = sliceDollarQuoted(code, '$verify$');
      expect(verify).toContain("IF v_def IS DISTINCT FROM '''manual_needed''::text' THEN");
    });

    it('proves both incident writers inherit the default rather than naming the column', () => {
      const verify = sliceDollarQuoted(code, '$verify$');
      expect(verify).toContain("'fn_ca_raise_drift_incident'");
      expect(verify).toContain("'fn_capture_managed_game_contract'");
      expect(verify).toContain("position('auto_repair_status' in p.prosrc) > 0");
    });

    it('THE OTHER DIRECTION: it proves the column was not loosened to get there', () => {
      // Dropping NOT NULL or the CHECK would also stop anything being born
      // 'pending'. Neither is the fix, and the migration refuses both.
      const verify = sliceDollarQuoted(code, '$verify$');
      expect(verify).toContain('IF NOT v_notnull THEN');
      for (const value of ['pending', 'running', 'repaired', 'manual_needed', 'not_applicable']) {
        expect(verify).toContain(`position('''${value}''' in v_check) = 0`);
      }
      expect(code).not.toMatch(/\bDROP\s+CONSTRAINT\b/i);
      expect(code).not.toMatch(/\bDROP\s+NOT\s+NULL\b/i);
    });

    it('declares the read-only proof the live-migration check runs', () => {
      // Raw, not stripped: the proof is a SQL comment by convention.
      expect(sql).toMatch(/^-- @live-proof: .*position\('manual_needed' in pg_get_expr/m);
    });

    it('is not itself an offender', () => {
      expect(offendersIn(sql)).toEqual([]);
    });
  });

  describe('the detector is live', () => {
    it.each([
      ["UPDATE public.ca_drift_incidents SET auto_repair_status = 'running' WHERE id = inc.id;"],
      [
        "UPDATE public.ca_drift_incidents SET status = 'open', auto_repair_status = 'pending' WHERE id = x;",
      ],
      [
        "ALTER TABLE public.ca_drift_incidents ALTER COLUMN auto_repair_status SET DEFAULT 'pending';",
      ],
      ["ALTER TABLE public.ca_drift_incidents ALTER auto_repair_status SET DEFAULT 'running';"],
      ['ALTER TABLE public.ca_drift_incidents ALTER COLUMN auto_repair_status DROP DEFAULT;'],
      ["CREATE TABLE x (auto_repair_status text NOT NULL DEFAULT 'pending');"],
      ["BEGIN NEW.auto_repair_status := 'pending'; RETURN NEW; END"],
      [
        "INSERT INTO public.ca_drift_incidents (source, dedupe_key, auto_repair_status) VALUES ('s', 'k', 'running');",
      ],
    ])('refuses: %s', (shape) => {
      expect(offendersIn(shape).length).toBeGreaterThan(0);
    });

    it.each([
      // A READ of the value is not a claim.
      [
        "SELECT count(*) FILTER (WHERE status <> 'resolved' AND auto_repair_status = 'running') FROM public.ca_drift_incidents;",
      ],
      // Writing the truth is always allowed.
      ["UPDATE public.ca_drift_incidents SET auto_repair_status = 'manual_needed' WHERE id = x;"],
      [
        "ALTER TABLE public.ca_drift_incidents ALTER COLUMN auto_repair_status SET DEFAULT 'manual_needed';",
      ],
      // A writer that does not name the column inherits the default.
      [
        "INSERT INTO public.ca_drift_incidents (source, dedupe_key, suspected_cause) VALUES ('s', 'k', 'pending review');",
      ],
      // Prose about the old value is not code.
      ["-- UPDATE public.ca_drift_incidents SET auto_repair_status = 'running'\nSELECT 1;"],
    ])('allows: %s', (shape) => {
      expect(offendersIn(shape)).toEqual([]);
    });
  });

  it('THE ONE THAT MATTERS LATER: nothing from 20260922141524 makes an incident claim a repair', () => {
    const offenders: string[] = [];
    for (const file of readdirSync(MIGRATIONS)) {
      if (!file.endsWith('.sql')) continue;
      if (file < FORWARD_GUARD_FROM) continue;
      for (const why of offendersIn(read(file))) offenders.push(`${file}: ${why}`);
    }
    expect(offenders).toEqual([]);
  });
});
