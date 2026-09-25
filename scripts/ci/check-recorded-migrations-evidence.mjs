#!/usr/bin/env node
/**
 * ===========================================================================
 *  THE RECORDING'S EVIDENCE IS ASKED OF PRODUCTION, NOT OF THE FILE
 * ===========================================================================
 *
 * WHY THIS EXISTS (2026-09-23, issue #5008)
 *
 * scripts/ci/recording-only.mjs lets three file-text guards stop predicting
 * what a migration WILL do when the migration in question ran against
 * production days ago. That is only honest if somebody asks production what
 * actually happened. This is that somebody (CLAUDE.md 10.86 rule 3: a guard
 * must have a reader, and you must name them).
 *
 * It runs inside the `Applied Migrations Are Recorded` workflow, which already
 * carries SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY and already files an issue
 * when it goes red, so a finding here reaches a person by the same path.
 *
 * WHAT IT ASKS, per row of scripts/ci/recorded-migrations.manifest.json:
 *
 *   1. the file exists and hashes to the md5 the row records      (offline)
 *   2. production's schema_migrations holds that version, and its
 *      md5(statements) is the SAME md5                            (live)
 *   3. nothing the file declares is a browser-reachable SECURITY DEFINER
 *      that cannot tell who is asking - read from
 *      fn_definer_exposure_audit(), which is the live sweep the daily
 *      audit uses                                                 (live)
 *   4. every trigger the file creates on a money table is absent from
 *      fn_undeclared_money_triggers()                             (live)
 *   5. every repair-shaped function name it declares already has a row in
 *      docs/BAND-AIDS-REGISTER.md or scripts/ci/band-aid.allowlist.json,
 *      so the recording is not smuggling in new debt             (offline)
 *
 * (2) is the lock on the whole mechanism. A row whose md5 is not what
 * production ran is not a recording, it is a claim, and this refuses it.
 *
 * THREE FAILURE SHAPES, EACH WITH ITS OWN CODE (10.86 rule 1):
 *
 *   0  every recording still checks out
 *   1  a recording's evidence is WRONG - the md5 disagrees with production,
 *      or a finding the file-text guards raised is still true of the live
 *      schema. That is a real exposure and it wants its own pull request.
 *   2  this script broke
 *   3  COULD NOT TELL - no credentials, or production did not answer. Never
 *      folded into 0. "No answer" is not "no findings".
 *
 * Usage:
 *   SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... \
 *     node scripts/ci/check-recorded-migrations-evidence.mjs
 *   node scripts/ci/check-recorded-migrations-evidence.mjs --offline
 */
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import process from 'node:process';
import { loadManifest, md5OfFile } from './recording-only.mjs';
import { declaredFunctions, stripComments } from './check-definer-authorization.mjs';
import { offenders as moneyTriggerOffenders } from './check-money-trigger-declared.mjs';
import { declaredFunctions as bandAidNames, isBandAidName } from './check-no-new-band-aids.mjs';
import { supabaseServerHeaders } from './supabase-auth-headers.mjs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const OFFLINE = process.argv.includes('--offline');
const REGISTER = 'docs/BAND-AIDS-REGISTER.md';
const BAND_AID_ALLOWLIST = 'scripts/ci/band-aid.allowlist.json';
const DEFINER_ALLOWLIST = 'scripts/ci/definer-authorization.allowlist.json';

const findings = [];
const unknowns = [];

function readIfPresent(rel) {
  const path = join(REPO, rel);
  return existsSync(path) ? readFileSync(path, 'utf8') : null;
}

async function rpc(name, body) {
  const url = process.env.SUPABASE_URL || '';
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
  if (!url || !key) throw new Error('SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are not set');
  const res = await fetch(`${url}/rest/v1/rpc/${name}`, {
    method: 'POST',
    headers: supabaseServerHeaders(key, { 'content-type': 'application/json' }),
    body: JSON.stringify(body ?? {}),
  });
  // 10.86 rule 2: never coerce an unreadable answer into an empty one.
  if (!res.ok) throw new Error(`${name} answered HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

async function main() {
  const { rows, error } = loadManifest(REPO);
  if (error) {
    console.error(`[recorded-evidence] COULD NOT TELL: ${error}`);
    return 3;
  }
  if (rows.size === 0) {
    console.log('[recorded-evidence] the manifest holds no recordings - nothing to verify.');
    return 0;
  }

  // ---- 1 and 5: offline, and they hold in every checkout -------------------
  const register = readIfPresent(REGISTER) ?? '';
  let allowedDebt = new Set();
  try {
    const parsed = JSON.parse(readIfPresent(BAND_AID_ALLOWLIST) ?? '{}');
    const names = Array.isArray(parsed) ? parsed : parsed.existing_debt || [];
    allowedDebt = new Set(names.map((e) => String(e.name || e).toLowerCase()));
  } catch (err) {
    unknowns.push(`${BAND_AID_ALLOWLIST} is unreadable (${err.message})`);
  }
  let anonSurface = new Set();
  try {
    const parsed = JSON.parse(readIfPresent(DEFINER_ALLOWLIST) ?? '{}');
    anonSurface = new Set(Object.keys(parsed.anonPublicSurface ?? {}));
  } catch (err) {
    unknowns.push(`${DEFINER_ALLOWLIST} is unreadable (${err.message})`);
  }

  const declaredByRecordings = new Map(); // function name -> version that records it
  const triggersByRecordings = new Map(); // `${table}.${trigger}` -> version

  for (const [version, row] of rows) {
    const path = join(REPO, row.file);
    if (!existsSync(path)) {
      findings.push(`${version}: ${row.file} is in the manifest and not in this tree.`);
      continue;
    }
    const actual = md5OfFile(path);
    if (actual !== row.md5) {
      findings.push(
        `${version}: ${row.file} hashes to ${actual}; the manifest records ${row.md5}. ` +
          'A recording is byte-identical to what production ran.'
      );
      continue;
    }
    const sql = readFileSync(path, 'utf8');
    for (const fn of declaredFunctions(stripComments(sql))) {
      if (!declaredByRecordings.has(fn.name)) declaredByRecordings.set(fn.name, version);
    }
    for (const hit of moneyTriggerOffenders(sql)) {
      triggersByRecordings.set(`${hit.table}.${hit.trigger}`, version);
    }
    for (const name of bandAidNames(sql)) {
      if (!isBandAidName(name)) continue;
      if (allowedDebt.has(name)) continue;
      if (register.includes(name)) continue;
      findings.push(
        `${version}: ${row.file} declares ${name}, which is repair-shaped and has no row in ` +
          `${REGISTER} and no entry in ${BAND_AID_ALLOWLIST}. A recording may describe existing ` +
          'debt; it may not introduce debt nobody wrote down.'
      );
    }
  }

  if (OFFLINE) {
    return report(true);
  }

  // ---- 2: production holds this version, with this md5 ---------------------
  for (const [version, row] of rows) {
    let answer;
    try {
      answer = await rpc('fn_ca_migration_text', { p_version: version });
    } catch (err) {
      unknowns.push(`could not read production's copy of ${version}: ${err.message}`);
      continue;
    }
    const record = Array.isArray(answer) ? answer[0] : answer;
    if (!record) {
      findings.push(
        `${version}: production's supabase_migrations.schema_migrations has NO such version. ` +
          'This file records nothing, so it is new work and must be judged as new work.'
      );
      continue;
    }
    if (String(record.md5) !== row.md5) {
      findings.push(
        `${version}: production's statements hash to ${record.md5}; the manifest and the file ` +
          `say ${row.md5}. These are not the same SQL.`
      );
    }
  }

  // ---- 3: is anything it declares still reachable and unable to ask who? ---
  try {
    const audit = await rpc('fn_definer_exposure_audit');
    const buckets = [
      ['unauthenticated_writers', 'SECURITY DEFINER, it writes, a browser role can reach it, and it never consults auth'],
      ['anon_writers', 'SECURITY DEFINER, it writes, and a caller with no account can reach it'],
      ['anon_readers', 'SECURITY DEFINER and a caller with no account can reach it'],
    ];
    for (const [bucket, why] of buckets) {
      for (const entry of audit?.[bucket] ?? []) {
        const name = entry?.function ?? entry?.proname;
        if (!name) continue;
        if (anonSurface.has(name)) continue;
        const version = declaredByRecordings.get(name);
        if (!version) continue;
        findings.push(
          `${version}: ${name} is LIVE in production and ${why}. The recording is not the ` +
            'place to settle this - fix the live grant, then re-run.'
        );
      }
    }
  } catch (err) {
    unknowns.push(`could not read fn_definer_exposure_audit(): ${err.message}`);
  }

  // ---- 4: is any money trigger it names still undeclared? ------------------
  if (triggersByRecordings.size > 0) {
    try {
      const undeclared = await rpc('fn_undeclared_money_triggers');
      for (const row of undeclared ?? []) {
        const key = `${row.table_name}.${row.trigger_name}`.toLowerCase();
        const version = triggersByRecordings.get(key);
        if (!version) continue;
        findings.push(
          `${version}: ${row.trigger_name} on public.${row.table_name} is live and is NOT in ` +
            'public.ca_declared_money_triggers. Declare it, then re-run.'
        );
      }
    } catch (err) {
      unknowns.push(`could not read fn_undeclared_money_triggers(): ${err.message}`);
    }
  }

  return report(false);
}

function report(offline) {
  for (const u of unknowns) console.error(`[recorded-evidence] COULD NOT TELL: ${u}`);
  for (const f of findings) console.error(`[recorded-evidence] FINDING: ${f}`);

  if (findings.length > 0) {
    console.error('');
    console.error('  A recording of an applied migration is exempt from the file-text guards');
    console.error('  because the SQL already ran; it is NOT exempt from being true. One of the');
    console.error('  claims above is not true of production right now.');
    console.error('');
    return 1;
  }
  if (unknowns.length > 0) return 3;
  console.log(
    `[recorded-evidence] OK - every recording in the manifest is byte-identical to what ` +
      `production applied${offline ? ' (offline: the live half was not asked)' : ''}, and every ` +
      'finding the file-text guards raised about them is closed in the live schema.'
  );
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
    .then((code) => process.exit(code))
    .catch((err) => {
      console.error(`[recorded-evidence] script error: ${err.stack || err.message}`);
      process.exit(2);
    });
}

export { main };
