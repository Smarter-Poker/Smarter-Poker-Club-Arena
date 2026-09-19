#!/usr/bin/env node
/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  A MIGRATION THAT MERGED MUST BE LIVE
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * WHY THIS EXISTS (2026-09-19)
 *
 * Two checks already watch migrations and neither asks this question.
 *
 *   check-migrations-applied.mjs asks it only of the migrations a PULL REQUEST
 *   ADDS, only about the OBJECTS they declare, and only against a nightly
 *   snapshot. Once a branch merges, nothing ever asks again.
 *
 *   check-applied-migrations-are-recorded.mjs asks the OPPOSITE direction -
 *   what production applied that the repo has no file for.
 *
 * So a migration can merge to main, never be applied, and nothing anywhere
 * says so. It looks shipped: merged, green, closed.
 *
 * MEASURED 2026-09-19 across the 202 migrations merged in the preceding seven
 * days. THREE had never reached the database:
 *
 *   20260913172658_a_player_can_see_their_own_responsible_gaming_state
 *     The policy was absent, fn_rg_require_not_excluded is not SECURITY
 *     DEFINER, so it read the table with the caller's privileges, the
 *     player's own row was invisible to the player, and the "no row means no
 *     limits" branch turned that invisibility into permission: a self-excluded
 *     player asking about themselves was told ok: true. Six days.
 *
 *   20260918121836_anon_executes_only_what_it_needs
 *     Thirteen anon grants the repository described as gone were still live,
 *     and docs/security/anon-executable-definers.json described a state the
 *     database could not reach.
 *
 *   20260919025445_early_bird_original_fee_custody_after_player_finality
 *     27 fees still held in escrow.
 *
 * Two of the three are player protection or money.
 *
 * WHY IT IS NOT ENOUGH TO MATCH ON NAMES. Supabase's apply transport stamps
 * its own version and agents submit a condensed blob, so a migration is
 * routinely recorded under a different version and sometimes a different NAME:
 * the cash-lease lock fix of 20260912012000 was applied as
 * `cash_lease_canonical_ownership_and_heartbeat`. On that same sweep, name
 * matching produced TEN candidates of which SEVEN were false. A check that
 * accuses at a 70% false rate gets switched off, which is how this estate
 * already lost `Applied Migrations Are Recorded`.
 *
 * WHY IT IS NOT ENOUGH TO LOOK, EITHER - the reason step 3 exists. The author
 * of this file classified that cash-lease migration as unapplied by reading
 * its function for the wrong lock mode: the edit produces FOR KEY SHARE, and
 * counting FOR SHARE and FOR NO KEY UPDATE by hand said the opposite of the
 * truth. What corrected it was the migration's OWN assertion, which refused on
 * apply with "has 0 cash-lease lock sites, expected exactly 1" - the end state
 * it wanted, stated precisely enough to be machine-checked. Human
 * pattern-matching over a money path is exactly the thing that should not be
 * load-bearing here.
 *
 * HOW THIS DECIDES, cheapest first, and it only accuses when it can prove:
 *
 *   1. NAME. A schema_migrations row whose name matches the file's slug (or
 *      its 55-character truncation, which is how long names are stored).
 *   2. OBJECTS. Otherwise, every object the file CREATEs - function, table,
 *      view, index, trigger, policy - must exist in the live catalogue. This
 *      is what clears the six false positives.
 *   3. PROOF. A file that creates no object cannot be checked that way: it
 *      patches a function body, changes a lock mode, revokes a grant. Those
 *      declare their own proof, one or more lines of:
 *
 *          -- @live-proof: <a boolean SQL expression>
 *
 *      run read-only against production. Every one must come back true. The
 *      four real misses above were all in this class, which is exactly why
 *      the convention exists.
 *
 * VERDICTS. `not-applied` (objects missing, or a declared proof is false) is
 * a failure. `unverifiable` (creates nothing and declares no proof) is
 * reported and, with --require-proof, is also a failure - which is how the
 * convention becomes load-bearing for new migrations without failing on the
 * 3,000 files that predate it.
 *
 * IT NEVER PASSES SILENTLY WHEN IT CANNOT ASK (CLAUDE.md 10.86). No database
 * URL, an unreadable catalogue, an empty answer: exit 2, not 0.
 *
 * Usage:
 *   SUPABASE_DB_URL=postgres://... node scripts/ci/check-migrations-are-live.mjs
 *   ... --days 30            how far back to look (default 21)
 *   ... --since 20260901     absolute floor, wins over --days
 *   ... --require-proof      an unverifiable migration also fails
 * Exit: 0 every migration in the window is live · 1 one is not · 2 could not ask
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const DIR = join(ROOT, 'supabase', 'migrations');

/** How long schema_migrations stores a name before it truncates. */
const NAME_PREFIX = 55;

const argv = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};
const REQUIRE_PROOF = argv.includes('--require-proof');
const DAYS = Number(flag('days', '21'));

function windowFloor() {
  const since = flag('since', null);
  if (since) return String(since);
  const d = new Date(Date.now() - DAYS * 86_400_000);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}000000`;
}

function die(message) {
  console.error(`[migrations-are-live] COULD NOT ASK: ${message}`);
  console.error('   This is not a pass.');
  process.exit(2);
}

function psql(sql) {
  const url = process.env.SUPABASE_DB_URL || process.env.DATABASE_URL || '';
  if (!url) die('no SUPABASE_DB_URL / DATABASE_URL in the environment.');
  try {
    return execFileSync(process.env.PSQL_BIN || 'psql', [url, '-Atc', sql], {
      encoding: 'utf8',
      timeout: 60_000,
      maxBuffer: 32 * 1024 * 1024,
    });
  } catch (err) {
    die(err.message);
    return '';
  }
}

const rows = (out) =>
  out
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);

/** Blank `--` comments and dollar-quoted bodies so prose is not read as DDL. */
export function code(sql) {
  let out = sql.replace(/--[^\n]*/g, (m) => ' '.repeat(m.length));
  const tag = /\$[A-Za-z_]*\$/g;
  let m;
  while ((m = tag.exec(out)) !== null) {
    const close = out.indexOf(m[0], m.index + m[0].length);
    if (close < 0) break;
    const span = close + m[0].length - m.index;
    out = out.slice(0, m.index) + ' '.repeat(span) + out.slice(m.index + span);
    tag.lastIndex = m.index + span;
  }
  return out;
}

/**
 * Every persistent object a migration creates, as {kind, name, on}. pg_temp
 * objects are skipped: they are apply-time scaffolding and are gone by design.
 */
export function declaredObjects(sql) {
  const src = code(sql);
  const out = [];
  const push = (kind, name, on) => {
    if (!name || /^pg_temp\./i.test(name)) return;
    out.push({ kind, name: name.replace(/"/g, ''), on: (on || '').replace(/"/g, '') });
  };
  for (const m of src.matchAll(
    /\bCREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+([A-Za-z_"][\w."]*)\s*\(/gi
  ))
    push('function', m[1]);
  for (const m of src.matchAll(
    /\bCREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?([A-Za-z_"][\w."]*)/gi
  ))
    push('table', m[1]);
  for (const m of src.matchAll(
    /\bCREATE\s+(?:OR\s+REPLACE\s+)?(?:MATERIALIZED\s+)?VIEW\s+(?:IF\s+NOT\s+EXISTS\s+)?([A-Za-z_"][\w."]*)/gi
  ))
    push('view', m[1]);
  for (const m of src.matchAll(
    /\bCREATE\s+(?:UNIQUE\s+)?INDEX\s+(?:CONCURRENTLY\s+)?(?:IF\s+NOT\s+EXISTS\s+)?([A-Za-z_"][\w."]*)/gi
  ))
    push('index', m[1]);
  for (const m of src.matchAll(
    /\bCREATE\s+(?:OR\s+REPLACE\s+)?(?:CONSTRAINT\s+)?TRIGGER\s+([A-Za-z_"][\w."]*)/gi
  ))
    push('trigger', m[1]);
  for (const m of src.matchAll(
    /\bCREATE\s+POLICY\s+([A-Za-z_"][\w."]*)\s+ON\s+([A-Za-z_"][\w."]*)/gi
  ))
    push('policy', m[1], m[2]);
  const seen = new Set();
  return out.filter((o) => {
    const k = `${o.kind}:${o.name}:${o.on}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/** The `-- @live-proof:` lines a migration declares, in file order. */
export function declaredProofs(sql) {
  return [...sql.matchAll(/--\s*@live-proof:\s*(.+?)\s*$/gim)].map((m) => m[1].trim());
}

const sqlLiteral = (s) => `'${String(s).replace(/'/g, "''")}'`;

/** The executable half. Importing this file runs nothing; the helpers above
 *  are exported so tests/a-merged-migration-must-be-live.law.test.ts parses a
 *  migration exactly the way the check does, instead of a lookalike regex. */
function main() {
// ── read the window ────────────────────────────────────────────────────────
  if (!existsSync(DIR)) die(`${DIR} does not exist`);
  const floor = windowFloor();
  const files = readdirSync(DIR)
    .filter((f) => f.endsWith('.sql'))
    .filter((f) => f.slice(0, f.indexOf('_')) >= floor)
    .sort();

  if (files.length === 0) {
    console.log(`[migrations-are-live] no migrations at or after ${floor}; nothing to check.`);
    process.exit(0);
  }

  // ── 1. names ───────────────────────────────────────────────────────────────
  const recorded = new Set(
    rows(psql(`select name from supabase_migrations.schema_migrations where name is not null`))
  );
  if (recorded.size === 0) die('schema_migrations returned no names at all');
  const recordedPrefixes = new Set([...recorded].map((n) => n.slice(0, NAME_PREFIX)));

  const unmatched = [];
  for (const file of files) {
    const slug = file.slice(file.indexOf('_') + 1, -4);
    if (recorded.has(slug) || recordedPrefixes.has(slug.slice(0, NAME_PREFIX))) continue;
    unmatched.push({ file, slug, sql: readFileSync(join(DIR, file), 'utf8') });
  }

  console.log(
    `[migrations-are-live] ${files.length} migration(s) at or after ${floor}; ` +
      `${files.length - unmatched.length} matched by name, ${unmatched.length} to prove another way.`
  );
  if (unmatched.length === 0) process.exit(0);

  // ── 2. objects ─────────────────────────────────────────────────────────────
  const checks = [];
  for (const m of unmatched) {
    m.objects = declaredObjects(m.sql);
    m.proofs = declaredProofs(m.sql);
    for (const o of m.objects) checks.push({ m, o });
  }

  const missing = new Set();
  if (checks.length > 0) {
    const values = checks
      .map(({ o }) => `(${sqlLiteral(o.kind)},${sqlLiteral(o.name)},${sqlLiteral(o.on)})`)
      .join(',');
    const probe = `
  with want(kind, name, on_rel) as (values ${values}),
       norm as (
         select kind,
                name,
                on_rel,
                position('.' in name) > 0 as qualified,
                case when position('.' in name) > 0 then split_part(name,'.',1) else 'public' end as nsp,
                case when position('.' in name) > 0 then split_part(name,'.',2) else name end as obj
           from want)
  select distinct kind || E'\\t' || name || E'\\t' || on_rel
    from norm w
   where not exists (
     select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where w.kind = 'function' and n.nspname = w.nsp and p.proname = w.obj)
     and not exists (
     select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where w.kind in ('table','view') and n.nspname = w.nsp and c.relname = w.obj)
     -- An index named without a schema takes its TABLE's schema, which the DDL
     -- does not state, so an unqualified one is looked up by name anywhere.
     -- Measured 2026-09-19 against production: f06_one_source, f06_one_active
     -- and f06_one_winner all live in smarter_private, and assuming public
     -- accused all three of not being live.
     and not exists (
     select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where w.kind = 'index' and c.relname = w.obj and c.relkind = 'i'
        and (not w.qualified or n.nspname = w.nsp))
     and not exists (
     select 1 from pg_trigger t where w.kind = 'trigger' and not t.tgisinternal and t.tgname = w.obj)
     and not exists (
     select 1 from pg_policy pol where w.kind = 'policy' and pol.polname = w.obj);`;
    for (const line of rows(psql(probe))) missing.add(line.split('\t').slice(0, 2).join('\t'));
  }

  // ── 3. declared proofs ─────────────────────────────────────────────────────
  const falseProofs = new Map();
  const proofChecks = unmatched.flatMap((m) => m.proofs.map((p) => ({ m, p })));
  if (proofChecks.length > 0) {
    const probe = proofChecks
      .map(
        ({ p }, i) =>
          `select ${i} as i, coalesce((select (${p}))::text, 'null') as answer`
      )
      .join(' union all ');
    for (const line of rows(psql(probe))) {
      const [i, answer] = line.split('|');
      if (answer !== 'true') {
        const { m, p } = proofChecks[Number(i)];
        if (!falseProofs.has(m.file)) falseProofs.set(m.file, []);
        falseProofs.get(m.file).push(`${p}  ->  ${answer}`);
      }
    }
  }

  // ── the verdict ────────────────────────────────────────────────────────────
  const notApplied = [];
  const unverifiable = [];
  for (const m of unmatched) {
    const gone = m.objects.filter((o) => missing.has(`${o.kind}\t${o.name}`));
    const bad = falseProofs.get(m.file) || [];
    if (gone.length > 0 || bad.length > 0) {
      notApplied.push({ ...m, gone, bad });
    } else if (m.objects.length === 0 && m.proofs.length === 0) {
      unverifiable.push(m);
    }
  }

  if (unverifiable.length > 0) {
    console.log(
      `\n[migrations-are-live] ${unverifiable.length} migration(s) create no object and declare no proof,\n` +
        '  so whether production carries them cannot be decided from here. Add a line\n' +
        '  "-- @live-proof: <boolean SQL>" to each - the expression a reader would run\n' +
        '  to see the change is there:\n'
    );
    for (const m of unverifiable) console.log(`    ${m.file}`);
  }

  if (notApplied.length > 0) {
    console.error('\n[migrations-are-live] MERGED BUT NOT LIVE:\n');
    for (const m of notApplied) {
      console.error(`  ${m.file}`);
      for (const o of m.gone) console.error(`      missing ${o.kind} ${o.name}`);
      for (const b of m.bad) console.error(`      proof false: ${b}`);
    }
    console.error(
      '\n  These are in the repository and not in the database. Apply each one with the\n' +
        '  Supabase MCP apply_migration, or - if it was superseded - delete the file in\n' +
        '  the same pull request that says why.\n'
    );
    process.exit(1);
  }

  if (REQUIRE_PROOF && unverifiable.length > 0) {
    console.error('[migrations-are-live] --require-proof: every migration must be checkable.');
    process.exit(1);
  }

  console.log('[migrations-are-live] OK - every migration in the window is live in production.');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
