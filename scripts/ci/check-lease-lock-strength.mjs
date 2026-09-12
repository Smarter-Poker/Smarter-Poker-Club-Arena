#!/usr/bin/env node
/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  A LEASE HOLDER DOES NOT STARVE THE HEARTBEAT THAT KEEPS ITS LEASE ALIVE
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * WHY THIS EXISTS (2026-09-12)
 *
 * `heartbeat_table_leases_v4` renews with `FOR NO KEY UPDATE ... SKIP LOCKED`,
 * deliberately, so that it never queues behind a settlement. The price is that
 * a row it cannot lock comes back `busy` and is extended by nothing.
 *
 * `fn_ca_commit_hand_settlement_exact_before_obligations` locked the lease row
 * with `FOR SHARE` before committing a hand. `FOR SHARE` conflicts with
 * `FOR NO KEY UPDATE`, so for the length of a settlement that table's
 * heartbeat could not renew that table's lease.
 *
 * THIS IS LATENT, NOT AN INCIDENT, AND SAYING OTHERWISE IS THE MISTAKE THIS
 * HEADER EXISTS TO NOT REPEAT. It was found while chasing a restart loop in
 * which every cash table re-claimed about every twenty seconds, and the first
 * draft of this file claimed it was the cause. It is not. Measured contention
 * across the 78 cash lease rows was a mean of 0.63 skipped, 0.8% of rows, and
 * an expiry needs FOUR consecutive misses - about one chance in two billion.
 * On every row `heartbeat_at` equalled `acquired_at`, meaning no renewal had
 * ever succeeded, which is not the shape of intermittent contention at all.
 *
 * What the conflict does cost is real and grows with settlement volume, and it
 * is one keyword to remove. That is reason enough to refuse it.
 *
 * ── WHY FOR SHARE IS THE ONE LOCK THAT IS ALWAYS WRONG HERE ──────────────────
 *
 * The primary key of `engine_table_leases` is `table_id` alone, so a takeover
 * (an upsert of `instance_id`/`lease_generation`) is a NON-KEY update and takes
 * exactly the same lock strength as the heartbeat. No lock a holder can take
 * will block a takeover and admit a heartbeat - they are indistinguishable at
 * the row-lock level. So FOR SHARE does not buy the exclusion it looks like it
 * buys. It only costs the heartbeat:
 *
 *     holder takes FOR SHARE      -> heartbeat sees 0 rows  (skipped -> busy)
 *     holder takes FOR KEY SHARE  -> heartbeat sees 1 row   (renews normally)
 *
 * measured twice each against production on an inert row, 2026-09-12.
 *
 * Exclusion has to be asserted by the TAKEOVER, not inferred by the holder:
 * `claim_tournament_lease_v2` (2026-09-10) and `claim_table_lease_v2`
 * (2026-09-12) each take an explicit FOR UPDATE before their upsert, which
 * FOR KEY SHARE does block.
 *
 * ── WHAT THIS REFUSES ───────────────────────────────────────────────────────
 *
 * A new migration that takes FOR SHARE on `engine_table_leases` or
 * `engine_tournament_leases`. The other three locks are all legitimate and are
 * left alone:
 *
 *   FOR KEY SHARE                      a holder: excludes the takeover, admits
 *                                      the heartbeat. This is what you want.
 *   FOR NO KEY UPDATE ... SKIP LOCKED  the heartbeat itself.
 *   FOR UPDATE                         a takeover or a lifecycle change, which
 *                                      is entitled to exclude everything.
 *
 * The tournament half of this was fixed on 2026-09-10 and the cash half was
 * missed, which is how it survived: the two branches sit eleven lines apart in
 * one function, one carrying a comment explaining exactly why the other was
 * wrong. A reviewer reading either branch alone sees nothing.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { stripNoise } from './check-unqualified-writes.mjs';

const REPO = process.cwd();
const DIR = 'supabase/migrations/';
const ALL = process.argv.includes('--all');

const LEASE_RELATIONS = ['engine_table_leases', 'engine_tournament_leases'];
const NOT_AN_ALIAS =
  /^(where|set|on|using|for|join|left|right|inner|outer|cross|group|order|limit|having|returning|as|and|or|values)$/i;

function git(args) {
  return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function baseRef() {
  const explicit = process.argv.slice(2).find((a) => !a.startsWith('--'));
  if (explicit) return explicit;
  const b = process.env.GITHUB_BASE_REF;
  if (b) {
    for (const ref of [`origin/${b}`, b]) {
      try {
        git(['rev-parse', '--verify', ref]);
        return ref;
      } catch {
        /* try the next form */
      }
    }
  }
  return 'HEAD~1';
}

function changedMigrations(base) {
  let out;
  try {
    out = git(['diff', '--name-only', '--diff-filter=AM', `${base}...HEAD`]);
  } catch {
    try {
      out = git(['diff', '--name-only', '--diff-filter=AM', base, 'HEAD']);
    } catch {
      // A gate that silently skips reports success for a check it never ran.
      console.error(
        `[check-lease-lock-strength] cannot diff against "${base}" - the checkout is ` +
          'probably shallow. Give the job fetch-depth: 0, or pass an explicit base ref.'
      );
      process.exit(2);
    }
  }
  return out
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.startsWith(DIR) && l.endsWith('.sql'));
}

/**
 * An explicit, reasoned exemption, in the shape this directory already uses for
 * `unqualified-write-ok`. The reason has to be a real one: 40+ characters,
 * continued over as many comment lines as it takes.
 */
export function declaredExceptions(sql) {
  const out = new Map();
  const lines = String(sql).split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    const m = /^\s*--\s*lease-lock-ok:\s*([A-Za-z0-9_."]+)\s+because\s+(.*)$/i.exec(lines[i]);
    if (!m) continue;
    let reason = m[2].trim();
    for (let j = i + 1; j < lines.length; j += 1) {
      const c = /^\s*--\s?(.*)$/.exec(lines[j]);
      if (!c) break;
      if (/lease-lock-ok:/i.test(c[1])) break;
      reason += ` ${c[1].trim()}`;
    }
    if (reason.trim().length >= 40) {
      out.set(m[1].replace(/\s+/g, '').replace(/^public\./i, '').replace(/"/g, ''), reason.trim());
    }
  }
  return out;
}

/**
 * Every FOR SHARE taken on a statement that reads a lease relation.
 *
 * Statements are split on `;` so a lock clause is only ever attributed to the
 * statement it terminates. `FOR SHARE OF <target>` is read: when it names
 * targets, only those are locked, so a statement that joins a lease table and
 * locks some OTHER alias is not an offence. A lease table referenced with no
 * alias can still be named directly in the OF list, so both are matched.
 *
 * `FOR KEY SHARE` and `FOR NO KEY UPDATE` do not match `\bfor\s+share\b` and
 * are never reported.
 */
export function offenders(sql) {
  const exempt = declaredExceptions(sql);
  const clean = stripNoise(String(sql));
  const found = new Map();

  for (const stmt of clean.split(';')) {
    if (!/\bfor\s+share\b/i.test(stmt)) continue;

    for (const rel of LEASE_RELATIONS) {
      if (exempt.has(rel)) continue;

      const relRe = new RegExp(
        `\\b(?:public\\.)?${rel}\\b(?:\\s+(?:as\\s+)?([a-z_][a-z0-9_]*))?`,
        'gi'
      );
      let m;
      while ((m = relRe.exec(stmt)) !== null) {
        const alias = m[1] && !NOT_AN_ALIAS.test(m[1]) ? m[1].toLowerCase() : null;

        for (const lock of stmt.matchAll(/\bfor\s+share\b(?:\s+of\s+([a-z0-9_,.\s"]+?))?(?=\s|$)/gi)) {
          const listed = lock[1]
            ? lock[1]
                .split(',')
                .map((s) => s.trim().toLowerCase().replace(/"/g, '').replace(/^public\./, ''))
                .filter(Boolean)
            : null;
          // No OF list: the lock covers every table in the statement, lease included.
          if (listed && !listed.includes(alias ?? rel) && !listed.includes(rel)) continue;
          if (!found.has(rel)) found.set(rel, { relation: rel, alias });
        }
      }
    }
  }

  return [...found.values()];
}

function main() {
  const base = baseRef();
  const files = ALL
    ? git(['ls-files', `${DIR}*.sql`])
        .split('\n')
        .filter(Boolean)
    : changedMigrations(base);

  if (files.length === 0) {
    console.log(`[check-lease-lock-strength] no new migrations against ${base} - nothing to check.`);
    return;
  }

  const hits = [];
  let inspected = 0;
  for (const file of files) {
    const path = join(REPO, file);
    if (!existsSync(path)) continue;
    inspected += 1;
    for (const o of offenders(readFileSync(path, 'utf8'))) hits.push({ ...o, file });
  }

  if (hits.length > 0) {
    console.error('');
    console.error('[check-lease-lock-strength] BLOCKED - FOR SHARE on an engine lease row.');
    console.error('');
    for (const h of hits) {
      console.error(`  FOR SHARE on public.${h.relation}`);
      console.error(`    in ${h.file}`);
    }
    console.error('');
    console.error('  The heartbeat renews with FOR NO KEY UPDATE ... SKIP LOCKED so that it');
    console.error('  never queues behind a settlement. FOR SHARE conflicts with that, so the');
    console.error('  heartbeat SKIPS the row, reports `busy`, and extends nothing. Four skips');
    console.error('  inside the twenty-second proof window is an expiry: the table restarts,');
    console.error('  the generation changes, and every horse turn in flight there is folded');
    console.error('  by the clock. On 2026-09-11 this was 923 restarts in five minutes.');
    console.error('');
    console.error('  FOR SHARE does not even buy exclusion. The PK is the id alone, so a');
    console.error('  takeover is a NON-KEY update and takes the same strength as the');
    console.error('  heartbeat: no holder lock can block one and admit the other.');
    console.error('');
    console.error('  Pick one:');
    console.error('');
    console.error('  1. YOU ARE A HOLDER (a settlement, an addon, anything mid-transaction');
    console.error('     that must not have the lease change under it):');
    console.error('       FOR KEY SHARE;');
    console.error('     and rely on the lease-generation check you already make. The');
    console.error('     takeover excludes you, not the other way round.');
    console.error('');
    console.error('  2. YOU ARE A TAKEOVER OR A LIFECYCLE CHANGE and are entitled to exclude');
    console.error('     everything, heartbeat included:');
    console.error('       FOR UPDATE;');
    console.error('');
    console.error('  3. IT REALLY IS FOR SHARE AND YOU CAN SAY WHY. Name the relation and');
    console.error('     give a real reason (40+ characters):');
    console.error('       -- lease-lock-ok: <relation> because <why starving the heartbeat');
    console.error('       --   for the length of this transaction is acceptable here>');
    console.error('');
    process.exit(1);
  }

  console.log(
    `[check-lease-lock-strength] OK - ${inspected} migration(s) checked; no new holder ` +
      'takes FOR SHARE on a lease row, so none of them can starve its own heartbeat.'
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
