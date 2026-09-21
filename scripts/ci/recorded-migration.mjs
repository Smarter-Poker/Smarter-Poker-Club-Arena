#!/usr/bin/env node
/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  A MIGRATION FILE THAT RECORDS IS NOT A MIGRATION FILE THAT PROPOSES
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * WHY THIS EXISTS (2026-09-21, issue #5008)
 *
 * This estate applies schema straight to production through the Supabase MCP
 * and does not always commit the .sql file. Measured 2026-09-21 against
 * `supabase_migrations.schema_migrations`: 4,399 applied migrations carry
 * non-empty statements, and 2,460 of them have no file in EITHER repo. The
 * database can regress with no source-control record and no guard able to see
 * it, which is what `Applied Migrations Are Recorded` exists to shout about.
 *
 * Closing that gap means adding files whose ONLY purpose is to record what
 * production already ran. Four checks refused to let that happen, and each
 * refused for a reason that is correct about a PROPOSAL and meaningless about
 * a RECORD:
 *
 *   check-definer-authorization    "this migration creates 11 SECURITY DEFINER
 *                                  functions a browser could call". Live ACLs
 *                                  are `{postgres=X, service_role=X}`;
 *                                  `has_function_privilege('anon', ...)` is
 *                                  false for all 11. The file's creation-time
 *                                  grants were superseded by a later sweep.
 *   check-money-trigger-declared   "these 2 triggers are undeclared". Both are
 *                                  rows in `ca_declared_money_triggers`, live
 *                                  and enabled. It reads the file, never the
 *                                  register.
 *   check-no-new-band-aids         refuses `fn_tournament_payout_reconcile`,
 *                                  which CLAUDE.md 10.9 names as the
 *                                  platform's own idempotent settlement path.
 *   a-declared-guard-change-is-... pardons an undeclared guard change only if
 *   recorded-not-raised.law        a SUCCESSOR FILE exists - and the plausible
 *                                  successors are themselves inside the gap.
 *                                  The mechanism is unreachable from inside
 *                                  the gap it exists to close.
 *
 * One defect with four faces: **a check treating an added file as a prediction
 * about what production will become, when the file is a record of what
 * production already is.**
 *
 * ── THE DISTINCTION, AND WHY IT CANNOT BE FORGED ───────────────────────────
 *
 * A file is a RECORD when its bytes are exactly what production recorded for
 * its version:
 *
 *     sha256(file with trailing newlines stripped)
 *       == sha256(rtrim(array_to_string(statements, E'\n'), E'\n'))
 *
 * That is not a marker, a header, a promise or an allowlist entry. It is a
 * falsifiable statement about a row in production, and to satisfy it for a
 * migration production has NOT run you would have to run it first - at which
 * point the file is a record, the security question the check was asking is
 * already moot, and refusing the file removes the record rather than the
 * danger.
 *
 * Anything else is a PROPOSAL and gets the full judgment, unchanged. One byte
 * different - a fixed typo, an added header, a "harmless" extra GRANT - and it
 * is a proposal again, which is the correct answer: an edited record is not a
 * record.
 *
 * THE DIGESTS ARE READ FROM `origin/main`, NEVER THE WORKING TREE. A pull
 * request cannot add its own entry, because the copy in its own diff is
 * ignored. Same reasoning as CLAUDE.md 10.8 ("confirm it exists on current
 * origin/main, never in your local tree") and
 * `tests/unit/doctrineIsReadFromMain.test.ts`. The files under
 * `installed-migration-digests.d/` are generated from production by
 * `gen-installed-migration-digests.mjs`, which runs in a trusted
 * default-branch workflow with credentials; nobody hand-writes one.
 *
 * COULD NOT TELL IS ITS OWN OUTCOME (CLAUDE.md 10.86 rule 1). If the digests
 * cannot be read - no `origin/main`, a shallow checkout, a malformed shard -
 * this reports `unknown`, and every caller treats unknown as PROPOSAL. Failing
 * closed is the only safe direction: the cost of judging a record as a
 * proposal is one blocked file, and the cost of the reverse is an unjudged
 * migration.
 *
 * THE LEGACY `-- BACKFILLED` MARKER IS NO LONGER PROOF. It was a first line of
 * text, so anything could claim it; `check-definer-authorization` honoured it
 * outright. It is now a hint that produces a better error message, never a
 * pardon. Only the digest pardons.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';

export const DIGEST_DIR = 'scripts/ci/installed-migration-digests.d';
export const MIGRATIONS_DIR = 'supabase/migrations/';

/** git, with any inherited GIT_* stripped: a hook exports GIT_DIR, and a child
 *  git that inherits it silently answers about the hook's repository. */
function git(args) {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_'))
  );
  return execFileSync('git', args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
    maxBuffer: 64 * 1024 * 1024,
    env,
  });
}

/** The byte form a record file must have: the applied statements, joined by
 *  newlines, with trailing newlines stripped. Mirrors the SQL side exactly. */
export function normaliseForDigest(text) {
  return String(text).replace(/\n+$/, '');
}

export function digestOf(text) {
  return createHash('sha256').update(normaliseForDigest(text), 'utf8').digest('hex');
}

/** The 14-digit version a migration path claims, or null. */
export function versionOf(path) {
  const m = /(?:^|\/)(\d{14})(?:[_.]|$)/.exec(String(path));
  return m ? m[1] : null;
}

/**
 * version -> sha256, as recorded on origin/main.
 *
 * Returns { ok: true, digests } or { ok: false, reason } - never a silently
 * empty map, because an empty map and an unreadable one lead to opposite
 * verdicts and only one of them is honest.
 */
export function installedDigestsFromMain() {
  for (const ref of ['origin/main', 'main']) {
    let listing;
    try {
      listing = git(['ls-tree', '--name-only', `${ref}:${DIGEST_DIR}`]);
    } catch {
      continue;
    }
    const digests = new Map();
    let shards = 0;
    for (const name of listing
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)) {
      if (!name.endsWith('.txt')) continue;
      let body;
      try {
        body = git(['show', `${ref}:${DIGEST_DIR}/${name}`]);
      } catch {
        return { ok: false, reason: `${ref}:${DIGEST_DIR}/${name} is listed but unreadable` };
      }
      shards += 1;
      for (const line of body.split('\n')) {
        const t = line.trim();
        if (!t || t.startsWith('#')) continue;
        const m = /^(\d{14})\s+([0-9a-f]{64})$/.exec(t);
        if (!m) {
          return { ok: false, reason: `${name} has a malformed line: ${t.slice(0, 60)}` };
        }
        digests.set(m[1], m[2]);
      }
    }
    if (shards === 0) continue;
    return { ok: true, digests, ref };
  }
  return {
    ok: false,
    reason:
      `no readable ${DIGEST_DIR} on origin/main (fetch it, or give the job fetch-depth: 0). ` +
      'Until it is readable every migration is judged as a proposal.',
  };
}

/**
 * 'record' | 'proposal', for one file whose bytes are `sql`.
 *
 * `digests` is the map from installedDigestsFromMain(). Pass null for "could
 * not tell", which yields 'proposal'.
 */
export function classify(path, sql, digests) {
  if (!digests) return 'proposal';
  const version = versionOf(path);
  if (!version) return 'proposal';
  const expected = digests.get(version);
  if (!expected) return 'proposal';
  return digestOf(sql) === expected ? 'record' : 'proposal';
}

/** True when the file carries the legacy machine-written backfill marker.
 *  A HINT ONLY - it pardons nothing. */
export function claimsToBeABackfill(sql) {
  return /^--\s*(BACKFILLED|UNRECOVERABLE STUB)\b/.test(String(sql));
}

/**
 * Partition changed migration files into records and proposals.
 *
 * `readFile` takes a repo-relative path and returns its bytes as a string, or
 * null when it cannot be read. Returns { records, proposals, digests, note }
 * where `note` is non-null when the digests could not be read at all - the
 * caller should PRINT it, because a check that cannot tell and says nothing is
 * the thing 10.86 is about.
 */
export function partition(files, readFile, preloaded = null) {
  // `preloaded` is for a caller that already asked (and for the law test, which
  // has to prove the POSITIVE case before the shards exist on main). Every
  // production call site passes two arguments, and the law pins that.
  const loaded = preloaded ?? installedDigestsFromMain();
  const digests = loaded.ok ? loaded.digests : null;
  const records = [];
  const proposals = [];
  for (const file of files) {
    const sql = readFile(file);
    if (sql == null) {
      proposals.push(file); // unreadable: judge it rather than skip it
      continue;
    }
    if (classify(file, sql, digests) === 'record') records.push(file);
    else proposals.push(file);
  }
  return {
    records,
    proposals,
    digests,
    note: loaded.ok ? null : `[recorded-migration] COULD NOT TELL: ${loaded.reason}`,
  };
}

/** The sentence every caller prints when it refuses a file that says it is a
 *  record but is not one. Kept here so all four say the same thing. */
export function whyNotARecord(file, sql, digests) {
  const version = versionOf(file);
  if (!version) return 'its name carries no 14-digit version, so no applied migration can match it';
  if (!digests) return 'the installed digests on origin/main could not be read';
  const expected = digests.get(version);
  if (!expected) {
    return (
      `production has no applied migration ${version} with recordable statements, so this file ` +
      'proposes a change rather than recording one'
    );
  }
  return (
    `production applied ${version}, but this file is not byte-identical to what ran ` +
    `(file ${digestOf(sql).slice(0, 12)}..., applied ${expected.slice(0, 12)}...). ` +
    'An edited record is not a record'
  );
}
