#!/usr/bin/env node
/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  A MIGRATION THIS BRANCH ADDS MUST ALREADY EXIST IN THE LIVE SCHEMA
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * WHY THIS EXISTS (2026-08-22)
 *
 * `supabase/migrations/20260821_club_tournament_stats.sql` was committed on
 * 2026-08-21 and never applied. The service code that called the function it
 * declared was reverted by a bad merge the same day. The repo therefore claimed
 * a feature the database had never heard of, the leaderboard quietly kept
 * serving numbers computed from an arbitrary half of each club's history, and
 * nothing anywhere went red. It was found a day later by hand.
 *
 * Every gate in this repo checks the CODE against the live schema. Nothing
 * checked the MIGRATIONS against it. This does.
 *
 * SCOPE: only migrations this branch ADDS or MODIFIES. The 432 files already in
 * the directory are intentionally stale — CLAUDE.md is explicit that schema is
 * applied straight to production via the Supabase MCP and the older files are
 * history, not truth (68 functions and 80 tables in them no longer exist).
 * Auditing those is a separate archaeology project; letting a NEW one slip is a
 * bug that ships today.
 *
 * HOW IT DECIDES: `scripts/ci/supabase-schema-manifest.json` is a snapshot of
 * the live public schema, regenerated with `gen-schema-manifest.mjs`. If a new
 * migration declares an object that is not in it, either the migration was
 * never applied (apply it with the Supabase MCP `apply_migration`) or the
 * manifest is stale (regenerate it in the same PR). Both are things the author
 * must do; neither is something to discover a day later.
 *
 * A FRAGMENT IS A PROMISE, NOT AN OBSERVATION (2026-09-22).
 *
 * The manifest this gate reads is the nightly base snapshot UNION every
 * scripts/ci/schema-manifest.d/*.json fragment. The base is generated FROM the
 * live schema, so a name in it was seen in production. A fragment is a line the
 * branch author typed. Unioned, they are indistinguishable, and this gate then
 * answered a question it had not asked: on 2026-09-22 it printed
 *
 *     3 changed migration(s); 0 unapplied object(s).
 *     OK - every object these migrations declare exists in the live schema.
 *
 * about `20260922143541_club_and_union_diamond_commerce.sql`, whose fourteen
 * tables and thirty-five functions production had never heard of. The fragment
 * even said "Applied as 20260922143541" in its own _owner field. It had not
 * been. The merge landed, and because the engine build calls three of those
 * functions, `Prove The Exact Engine Has Every Production Door` then refused
 * every engine release - which is the correct behaviour of that gate and the
 * first true thing anybody was told.
 *
 * This is CLAUDE.md 10.86 rule 2 exactly: an answer that could not be read was
 * coerced into a good one. So the two sources are now kept apart:
 *
 *   OBSERVED  - in the base snapshot. Production was asked. Silent, as before.
 *   PROMISED  - present only because a fragment says so. Reported BY NAME, and
 *               never described as existing in the live schema.
 *   ABSENT    - in neither. Unapplied. Exit 1, exactly as before.
 *
 * PROMISED does not block, and that is deliberate. The fragment mechanism
 * exists precisely so a branch can reference an object it HAS applied before
 * the nightly base regenerates, and 75 tables and 214 functions are legitimately
 * mid-promise on main as this is written. A guard that can wedge every
 * migration author is worse than the staleness it reports - the same ruling
 * CLAUDE.md 10.87 makes about the freshness guard. What PROMISED does is stop
 * this gate from CLAIMING the object is live, and name the file whose author is
 * the one person who can say whether it is.
 *
 * WHERE A CREDENTIAL EXISTS, IT ASKS PRODUCTION INSTEAD OF GUESSING. If
 * SUPABASE_DB_URL or DATABASE_URL is set, the promised names are looked up in
 * the live catalog and an absent one is a hard failure with the true reason. A
 * URL that is set but unreadable is exit 2, COULD NOT TELL - never green. This
 * script never contains, derives or writes a credential (CLAUDE.md 10.84).
 *
 * Usage:  node scripts/ci/check-migrations-applied.mjs [baseRef]
 * Exit:   0 clean · 1 an unapplied object · 2 script error or could-not-tell
 */
import { execFileSync } from "node:child_process";
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  SQL_IDENTIFIER,
  SQL_QUALIFIED,
  identifierParts,
  manifestIdentity,
} from "./sql-manifest-identifiers.mjs";
import { loadSchemaManifest, loadColumnsManifest } from "./schema-manifest.mjs";
import { classifyMigration } from "./recording-only.mjs";

const REPO = process.cwd();
const MANIFEST = join(REPO, "scripts/ci/supabase-schema-manifest.json");
const DIR = "supabase/migrations/";

function git(args) {
  return execFileSync("git", args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

/** The commit this branch grew from. PRs get it from GitHub; a push compares to
 *  its own parent, which is the smallest honest unit of "what this adds". */
function baseRef() {
  if (process.argv[2]) return process.argv[2];
  const b = process.env.GITHUB_BASE_REF;
  if (b) {
    for (const ref of [`origin/${b}`, b]) {
      try {
        git(["rev-parse", "--verify", ref]);
        return ref;
      } catch {
        /* try the next form */
      }
    }
  }
  return "HEAD~1";
}

function changedMigrations(base) {
  let out;
  try {
    out = git(["diff", "--name-only", "--diff-filter=AM", `${base}...HEAD`]);
  } catch {
    try {
      out = git(["diff", "--name-only", "--diff-filter=AM", base, "HEAD"]);
    } catch {
      /* A gate that silently skips is worse than no gate: it reports success
         for a check it never ran. Fail loudly instead, so a shallow checkout
         is fixed rather than quietly disabling this. */
      console.error(
        `[check-migrations-applied] cannot diff against "${base}" — the checkout is ` +
          "probably shallow. Give the job fetch-depth: 0, or pass an explicit base ref.",
      );
      process.exit(2);
    }
  }
  return (
    out
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.startsWith(DIR) && l.endsWith(".sql"))
      // BACKFILL EXEMPTION (2026-09-01). A file whose first line marks it as a
      // recovered record of an ALREADY-APPLIED migration is history, not a new
      // migration awaiting apply. This gate asks "does what this migration
      // declares exist in the live schema NOW" - the right question for new
      // work, a false positive for a backfill of an old migration whose object
      // was since dropped, renamed or superseded (backup tables, a removed
      // column, a replaced function). Those objects genuinely ran and are
      // genuinely gone; the byte-exact record is correct and the live schema is
      // correct. The gate stays strict on every genuinely new migration. Marker
      // written by scripts/ci/backfill-unrecorded-migrations.mjs.
      // SUPERSEDED EXEMPTION (2026-09-07), and it is deliberately narrower than
      // the one above. A migration can be applied and then correctly undone in
      // the SAME session: 20260907192843 added three columns to hand_history so
      // a repair job could rebuild rake attribution, the root fix landed in the
      // engine two hours later, and 20260907195116 dropped them again because
      // 1.3 GB a month to feed a job that must never run is the band-aid 10.12
      // forbids. Both files must stay - both ran, and
      // check-applied-migrations-are-recorded demands a file for each - but the
      // first one declares columns that are deliberately gone, so this gate
      // failed the branch for doing exactly the right thing.
      //
      // The marker is NOT a free pass, because "this was superseded" is the
      // easiest possible lie to tell about a migration that simply never
      // applied. It must NAME the migration that superseded it, and that file
      // must exist in this directory, or the exemption does not apply and the
      // file is checked as strictly as any other:
      //
      //   -- SUPERSEDED BY 20260907195116
      .filter((f) => {
        let head;
        try {
          head = readFileSync(join(REPO, f), "utf8").slice(0, 400);
        } catch {
          return true; // unreadable: check it rather than skip it
        }
        // 2026-09-23: the marker alone is no longer the answer. Below the
        // freeze it still is (577 historical files, newest 20260914130826);
        // at or after it a recording needs a verified row in
        // scripts/ci/recorded-migrations.manifest.json, so the escape this
        // header already called out - "a BACKFILLED marker on a file that was
        // not backfilled" - is closed for everything written from here on.
        const recording = classifyMigration(f, { repo: REPO });
        if (recording.state === "recorded") return false;
        if (recording.state === "unknown") {
          console.error(
            `[check-migrations-applied] COULD NOT TELL whether ${f} is a recording ` +
              `(${recording.reason}); checking it as new work.`,
          );
        }
        const superseded = head.match(/^--\s*SUPERSEDED BY\s+(\d{14})\b/m);
        if (superseded) {
          const named = migrationFileFor(superseded[1]);
          if (named) return false;
          console.error(
            `[check-migrations-applied] ${f} claims "SUPERSEDED BY ${superseded[1]}" ` +
              "but no migration with that version exists in this tree. A superseding " +
              "migration that is not here is a migration that did not run.",
          );
        }
        return true;
      })
  );
}

/** Does a migration with this version exist on disk? The superseded marker is
 *  worthless without it - see the exemption above. */
function migrationFileFor(version) {
  try {
    return (
      readdirSync(join(REPO, DIR)).find((n) => n.startsWith(`${version}_`)) ??
      null
    );
  } catch {
    return null;
  }
}

/** Objects a migration CREATES or ADDS. Drops and alters of existing objects
 *  are out of scope: this asks "did the thing you added actually land", not
 *  "is the schema perfect".
 *
 *  ADD COLUMN was missing here until 2026-08-22, and the omission cost a
 *  feature. In World Hub, 20260821210000_user_avatars_cosmetics.sql and
 *  20260821210001_profiles_cosmetics.sql sat unapplied for a day while the
 *  avatar frames-and-auras feature was fully built around the columns they
 *  declare - every write failed 42703 into a catch block and nothing went red.
 *  A CREATE-only version of this gate watches that go straight past: the table
 *  already exists, so every other check stays green. A column is the most
 *  common thing a migration adds and the easiest thing to strand. */
export function executableSql(sql) {
  // Preserve quoted identifiers while removing comments and string contents.
  // Dollar-quoted function bodies remain visible, as in the existing gate.
  let out = "",
    i = 0;
  while (i < sql.length) {
    if (sql[i] === '"') {
      const start = i++;
      while (i < sql.length) {
        if (sql[i++] === '"') {
          if (sql[i] === '"') i++;
          else break;
        }
      }
      out += sql.slice(start, i);
      continue;
    }
    if (sql.startsWith("--", i)) {
      while (i < sql.length && sql[i] !== "\n") i++;
      out += " ";
      continue;
    }
    if (sql.startsWith("/*", i)) {
      let depth = 1;
      i += 2;
      while (i < sql.length && depth) {
        if (sql.startsWith("/*", i)) {
          depth++;
          i += 2;
        } else if (sql.startsWith("*/", i)) {
          depth--;
          i += 2;
        } else i++;
      }
      out += " ";
      continue;
    }
    if (sql[i] === "'") {
      const escaped =
        i > 0 &&
        /[eE]/.test(sql[i - 1]) &&
        (i < 2 || !/[a-z0-9_$]/i.test(sql[i - 2]));
      i++;
      while (i < sql.length) {
        if (escaped && sql[i] === "\\") {
          i += 2;
          continue;
        }
        if (sql[i++] === "'") {
          if (sql[i] === "'") i++;
          else break;
        }
      }
      out += "''";
      continue;
    }
    out += sql[i++];
  }
  return out;
}
function objectMatches(clean, prefix, suffix = "") {
  // Preserve exact identifier spelling, but never interpret keywords inside one.
  const quoted = new Uint8Array(clean.length);
  for (let i = 0; i < clean.length; i++) {
    if (clean[i] !== '"') continue;
    const start = i++;
    while (i < clean.length) {
      if (clean[i++] === '"') {
        if (clean[i] === '"') i++;
        else break;
      }
    }
    quoted.fill(1, start, i);
    i--;
  }
  // A following identifier character or dot cannot be silently left behind.
  const end = "(?![a-z0-9_$\\u0080-\\uffff]|\\s*\\.)";
  return [
    ...clean.matchAll(new RegExp(prefix + SQL_QUALIFIED + end + suffix, "gi")),
  ].filter(
    (m) =>
      !quoted[m.index] &&
      (m.index === 0 || !/[a-z0-9_$\u0080-\uffff]/i.test(clean[m.index - 1])),
  );
}
// Explicit pg_temp objects belong to this migration's database session. They
// cannot be present in a later live-schema snapshot, even when a helper is not
// explicitly dropped. Keep manifestIdentity strict for all persistent schemas.
function persistentMatches(clean, prefix, suffix = "") {
  return objectMatches(clean, prefix, suffix).filter((m) => {
    const parts = identifierParts(m[1]);
    return parts.length !== 2 || parts[0] !== "pg_temp";
  });
}
export function declaredObjects(sql) {
  const clean = executableSql(sql);
  const fns = persistentMatches(
    clean,
    "create\\s+(?:or\\s+replace\\s+)?function\\s+",
    "\\s*\\(",
  ).map((m) => manifestIdentity(m[1]));
  const tables = persistentMatches(
    clean,
    "create\\s+table\\s+(?:if\\s+not\\s+exists\\s+)?",
  ).map((m) => manifestIdentity(m[1]));
  const views = persistentMatches(
    clean,
    "create\\s+(?:or\\s+replace\\s+)?(?:materialized\\s+)?view\\s+(?:if\\s+not\\s+exists\\s+)?",
  ).map((m) => manifestIdentity(m[1]));
  const columns = persistentMatches(
    clean,
    "alter\\s+table\\s+(?:if\\s+exists\\s+)?(?:only\\s+)?",
    `\\s+add\\s+(?:column\\s+)?(?:if\\s+not\\s+exists\\s+)?(${SQL_IDENTIFIER})`,
  )
    .filter(
      (m) => !/^(constraint|primary|foreign|unique|check|exclude)$/i.test(m[2]),
    )
    .map((m) => [manifestIdentity(m[1]), identifierParts(m[2])[0]]);
  return {
    fns: [...new Set(fns)],
    tables: [...new Set([...tables, ...views])],
    columns: [...new Map(columns.map((c) => [JSON.stringify(c), c])).values()],
  };
}

/** Objects the branch DROPS.
 *
 * A branch that creates a table and then drops it again declares nothing, and
 * this gate used to report both halves as missing from the live schema - which
 * is true, and is exactly what the author intended.
 *
 * Found 2026-09-06. A migration scheduled two repair sweeps and a roster table
 * to watch them; Dan ruled that no cron may monitor or repair chip drift, so a
 * later migration in the same branch dropped all of it. Both objects genuinely
 * ran and are genuinely gone, the live schema is correct, and the gate failed
 * anyway - so the only ways past it were to lie in a schema-manifest fragment
 * (which the nightly refresh would turn red within a day) or to put a
 * BACKFILLED marker on a file that was not backfilled. A gate whose only
 * escapes are dishonest is a gate somebody routes around.
 *
 * Strict parsing for a changed migration. The ordered lifecycle lookup below
 * decides whether a removal actually follows the declaration being checked. */
export function droppedObjects(sql) {
  const clean = executableSql(sql);
  return {
    fns: new Set(
      persistentMatches(clean, "drop\\s+function\\s+(?:if\\s+exists\\s+)?").map(
        (m) => manifestIdentity(m[1]),
      ),
    ),
    tables: new Set(
      persistentMatches(
        clean,
        "drop\\s+(?:materialized\\s+)?(?:table|view)\\s+(?:if\\s+exists\\s+)?",
      ).map((m) => manifestIdentity(m[1])),
    ),
  };
}

/** Ordered lifecycle events are only used for a missing declaration. A later
 * migration may already be on main while its older predecessor arrives in this
 * branch. Its removal/rename must count, but a drop before a new CREATE must not.
 * Historical schemas outside the manifest's scope cannot match a scoped target;
 * changed migrations still pass the strict declaredObjects parser above. */
function lifecycleEvents(sql) {
  const clean = executableSql(sql);
  const events = [];
  const collect = (kind, prefix, suffix, removed, column = false) => {
    for (const m of objectMatches(clean, prefix, suffix)) {
      let identity;
      try {
        identity = manifestIdentity(m[1]);
      } catch {
        continue;
      }
      const name = column
        ? JSON.stringify([identity, identifierParts(m[2])[0]])
        : identity;
      events.push({ kind, name, removed, index: m.index });
    }
  };
  collect(
    "fns",
    "create\\s+(?:or\\s+replace\\s+)?function\\s+",
    "\\s*\\(",
    false,
  );
  collect("fns", "drop\\s+function\\s+(?:if\\s+exists\\s+)?", "", true);
  collect(
    "tables",
    "create\\s+table\\s+(?:if\\s+not\\s+exists\\s+)?",
    "",
    false,
  );
  collect(
    "tables",
    "create\\s+(?:or\\s+replace\\s+)?(?:materialized\\s+)?view\\s+(?:if\\s+not\\s+exists\\s+)?",
    "",
    false,
  );
  collect(
    "tables",
    "drop\\s+(?:materialized\\s+)?(?:table|view)\\s+(?:if\\s+exists\\s+)?",
    "",
    true,
  );
  const alter = "alter\\s+table\\s+(?:if\\s+exists\\s+)?(?:only\\s+)?";
  collect(
    "columns",
    alter,
    `\\s+add\\s+(?:column\\s+)?(?:if\\s+not\\s+exists\\s+)?(${SQL_IDENTIFIER})`,
    false,
    true,
  );
  collect(
    "columns",
    alter,
    `\\s+drop\\s+column\\s+(?:if\\s+exists\\s+)?(${SQL_IDENTIFIER})`,
    true,
    true,
  );
  for (const m of objectMatches(
    clean,
    alter,
    `\\s+rename\\s+column\\s+(${SQL_IDENTIFIER})\\s+to\\s+(${SQL_IDENTIFIER})`,
  )) {
    let identity;
    try {
      identity = manifestIdentity(m[1]);
    } catch {
      continue;
    }
    for (const [i, removed] of [
      [2, true],
      [3, false],
    ])
      events.push({
        kind: "columns",
        name: JSON.stringify([identity, identifierParts(m[i])[0]]),
        removed,
        index: m.index,
      });
  }
  return events.sort((a, b) => a.index - b.index);
}

function retirementLookup() {
  const files = readdirSync(join(REPO, DIR))
    .filter((f) => f.endsWith(".sql"))
    .sort();
  const cache = new Map();
  return (source, kind, name) => {
    let removed = false;
    for (const file of files) {
      const path = DIR + file;
      if (path < source) continue;
      if (!cache.has(path))
        cache.set(
          path,
          lifecycleEvents(readFileSync(join(REPO, path), "utf8")),
        );
      for (const event of cache.get(path))
        if (event.kind === kind && event.name === name) removed = event.removed;
    }
    return removed;
  };
}

/** What this file already declared at the base commit, as lookup sets.
 *  null when the file is new on this branch — then everything in it is new. */
function declaredAtBase(base, file) {
  let prior;
  try {
    prior = git(["show", `${base}:${file}`]);
  } catch {
    return null; // added by this branch
  }
  const d = declaredObjects(prior);
  return {
    fns: new Set(d.fns),
    tables: new Set(d.tables),
    columns: new Set(d.columns.map((pair) => JSON.stringify(pair))),
  };
}

/**
 * ASK PRODUCTION ABOUT THE NAMES A FRAGMENT PROMISED.
 *
 * Only runs when the environment already carries a connection string, the same
 * way scripts/ci/check-anon-definer-grants.mjs does it. This file never holds,
 * derives, prints or writes a credential (CLAUDE.md 10.84).
 *
 * Three outcomes, never two (CLAUDE.md 10.86 rule 1):
 *   { asked: false }               no credential here - caller must SAY so
 *   { asked: true, absent: [] }    production really has them
 *   { asked: true, absent: [...] } production does not - a hard failure
 *
 * A URL that is present but unreadable exits 2. An unreadable answer is not an
 * empty one (10.86 rule 2), and an environment that deliberately supplied a
 * credential is one where silence would be a lie.
 */
function verifyPromises(promises) {
  const url = process.env.SUPABASE_DB_URL || process.env.DATABASE_URL;
  if (!url) return { asked: false, absent: [] };

  const wantedTables = [...new Set(promises.filter((p) => p[1] !== "function").map((p) => p[2]))];
  const wantedFns = [...new Set(promises.filter((p) => p[1] === "function").map((p) => p[2]))];
  const lit = (xs) => (xs.length ? xs.map((x) => `'${x.replace(/'/g, "''")}'`).join(",") : "''");
  const query =
    `SELECT 't:'||c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace ` +
    `WHERE n.nspname='public' AND c.relname IN (${lit(wantedTables)}) ` +
    `UNION ALL ` +
    `SELECT 'f:'||p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace ` +
    `WHERE n.nspname='public' AND p.proname IN (${lit(wantedFns)});`;

  let out;
  try {
    out = execFileSync("psql", [url, "-At", "-c", query], {
      encoding: "utf8",
      timeout: 60_000,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (err) {
    console.error("[check-migrations-applied] COULD NOT ASK THE DATABASE.");
    console.error(`   ${err?.message || err}`);
    console.error("   A connection string was set, so silence here would be a lie. This is not a pass.");
    process.exit(2);
  }

  const seen = new Set(out.split("\n").map((l) => l.trim()).filter(Boolean));
  const absent = promises.filter(([, kind, name]) =>
    kind === "function" ? !seen.has(`f:${name}`) : !seen.has(`t:${name}`),
  );
  return { asked: true, absent };
}

function main() {
  if (!existsSync(MANIFEST)) {
    console.error(
      "[check-migrations-applied] missing schema manifest — cannot judge.",
    );
    process.exit(2);
  }
  /* Base snapshot UNION scripts/ci/schema-manifest.d/*.json. A migration's own
     branch declares its new functions in its own fragment file, which is what
     stopped this gate from forcing every migration through one shared array. */
  let manifest;
  try {
    manifest = loadSchemaManifest(REPO);
  } catch (err) {
    console.error(`[check-migrations-applied] ${err.message}`);
    process.exit(2);
  }
  const liveFns = new Set(manifest.functions || []);
  const liveTables = new Set(manifest.tables || []);
  /* Only a fragment vouches for these; nothing has asked production. */
  const promisedFns = new Set(manifest.promisedFunctions || []);
  const promisedTables = new Set(manifest.promisedTables || []);

  /* The column manifest is a separate snapshot ({table: [columns]}) and the
     phantom-column gate already depends on it. If it is absent this checks
     what it can rather than exiting 2 - a missing companion file should not
     turn off the function and table checks that do not need it. */
  const liveColumns = loadColumnsManifest(REPO).columns;

  const base = baseRef();
  const files = changedMigrations(base);
  if (files.length === 0) {
    console.log(
      `[check-migrations-applied] no new migrations against ${base} — nothing to check.`,
    );
    return;
  }

  const retiredLater = retirementLookup();

  const problems = [];
  const promises = [];
  for (const file of files) {
    if (!existsSync(join(REPO, file))) continue;
    const sql = readFileSync(join(REPO, file), "utf8");
    const now = declaredObjects(sql);
    droppedObjects(sql); // Preserve strict schema validation for changed drops.

    /* WHAT THIS BRANCH ACTUALLY ADDS (2026-08-22).
     *
     * The diff filter is AM, so a MODIFIED migration is in scope — correct,
     * because appending a CREATE FUNCTION to an old file strands it exactly
     * like a new one. But it judged the file's WHOLE contents, so touching a
     * historical migration at all re-asserted every object it had ever
     * declared.
     *
     * That made a whole class of file permanently untouchable. A migration
     * that was applied and then legitimately rolled back — the helpers dropped
     * on purpose — can no longer receive so much as a comment: the gate
     * re-asserts the objects that were deliberately removed and fails. Found
     * by adding a STATUS header to 20260821_library_only_avatars.sql, which
     * ran on 2026-08-21 and was rolled back afterwards.
     *
     * A gate that blocks a comment is a gate somebody starts bypassing, so
     * scope it to the DIFFERENCE. Objects already declared at the base commit
     * are that commit's business, not this branch's; only what this branch
     * newly declares gets checked. Appending a CREATE is still caught — that
     * is a new declaration — and a comment is correctly a no-op. */
    const before = declaredAtBase(base, file);
    const isNew = (kind, key) => !before || !before[kind].has(key);

    for (const fn of now.fns) {
      if (
        isNew("fns", fn) &&
        !liveFns.has(fn) &&
        !retiredLater(file, "fns", fn)
      ) {
        problems.push([file, "function", fn]);
      } else if (isNew("fns", fn) && promisedFns.has(fn)) {
        promises.push([file, "function", fn]);
      }
    }
    for (const t of now.tables) {
      if (
        isNew("tables", t) &&
        !liveTables.has(t) &&
        !retiredLater(file, "tables", t)
      ) {
        problems.push([file, "table/view", t]);
      } else if (isNew("tables", t) && promisedTables.has(t)) {
        promises.push([file, "table/view", t]);
      }
    }
    if (liveColumns) {
      for (const [t, c] of now.columns) {
        if (!isNew("columns", JSON.stringify([t, c]))) continue;
        // A column on a table the manifest does not know cannot be judged; the
        // table itself is either brand new above or genuinely absent.
        if (!liveColumns[t]) continue;
        if (
          !liveColumns[t].includes(c) &&
          !retiredLater(file, "columns", JSON.stringify([t, c]))
        )
          problems.push([file, "column", `${t}.${c}`]);
      }
    }
  }

  console.log(
    `[check-migrations-applied] ${files.length} changed migration(s) vs ${base}; ` +
      `${problems.length} unapplied object(s); ${promises.length} declared by a fragment only.`,
  );

  /* A promise this branch made about its own new objects. Ask production if we
     can; say so plainly if we cannot. Never call it "exists in the live schema". */
  if (promises.length) {
    const verdict = verifyPromises(promises);
    if (verdict.absent.length) {
      console.error(
        "\nTHE LIVE DATABASE DOES NOT HAVE WHAT THIS BRANCH'S FRAGMENT PROMISED:\n",
      );
      for (const [file, kind, name] of verdict.absent)
        console.error(`  ${file}\n    ${kind} ${name}`);
      console.error(
        "\nA fragment in scripts/ci/schema-manifest.d/ is a note that an object is" +
          "\nalready applied and the nightly base has not caught up yet. It is not a" +
          "\nway to declare one that has never run. Apply the migration with the" +
          "\nSupabase MCP `apply_migration`, which is the only sanctioned path.",
      );
      process.exit(1);
    }
    if (verdict.asked) {
      console.log(
        `[check-migrations-applied] asked production: all ${promises.length} fragment-declared object(s) are really there.`,
      );
    } else {
      console.warn(
        `\n[check-migrations-applied] ${promises.length} object(s) below are in the manifest ONLY because` +
          "\nthis branch's own fragment says so. NOTHING HAS ASKED PRODUCTION, so this" +
          "\ngate cannot tell whether they are live:\n",
      );
      for (const [file, kind, name] of promises)
        console.warn(`  ${file}\n    ${kind} ${name}`);
      console.warn(
        "\nIf you have already applied the migration, this is the expected note and" +
          "\nthe nightly schema-manifest refresh will absorb the fragment. If you have" +
          "\nnot, apply it now with the Supabase MCP `apply_migration`: a merged" +
          "\nmigration that never ran strands every engine release that calls it.",
      );
    }
  }

  if (problems.length === 0) {
    console.log(
      promises.length
        ? "OK — nothing this branch declares is missing from the manifest."
        : "OK — every object these migrations declare exists in the live schema.",
    );
    return;
  }

  console.error(
    "\nA MIGRATION IN THIS BRANCH DECLARES SOMETHING THE LIVE SCHEMA DOES NOT HAVE:\n",
  );
  for (const [file, kind, name] of problems)
    console.error(`  ${file}\n    ${kind} ${name}`);
  console.error(
    "\nEither the migration was never applied — apply it with the Supabase MCP" +
      "\n`apply_migration`, which is the only sanctioned path — or the manifest is" +
      "\nstale: regenerate it with scripts/ci/gen-schema-manifest.mjs in this same PR." +
      "\nA migration file that never ran is a feature the code believes in and the" +
      "\ndatabase has never heard of.",
  );
  process.exit(1);
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  try {
    main();
  } catch (err) {
    console.error(
      "[check-migrations-applied] script error:",
      err?.message || err,
    );
    process.exit(2);
  }
