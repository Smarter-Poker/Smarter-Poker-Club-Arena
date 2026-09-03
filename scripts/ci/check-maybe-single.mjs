#!/usr/bin/env node
/**
 * CI GATE — .single() ban on Supabase reads
 *
 * CLAUDE.md section 5 rule 1 has said "use .maybeSingle() never .single()"
 * since this repo had rules, and the World Hub enforces it in CHECK 1 of its
 * build-safety-gate. Club Arena never enforced it anywhere. On 2026-08-26 a
 * sweep found two live violations that had been sitting on main:
 *
 *   src/pages/ClubSettingsPage.tsx  profiles.player_number
 *   src/pages/InvitePage.tsx        profiles.player_number
 *
 * Both read a profile row that does not necessarily exist yet. PostgREST
 * answers zero rows with PGRST116, supabase-js turns that into
 * `{ data: null, error }` rather than throwing, and both call sites read only
 * `data` — so the failure was completely silent. The settings page simply
 * never rendered the player number; the invite page fell back to pasting the
 * raw user uuid into the referral link.
 *
 * That is the whole shape of this bug: it does not crash, it does not go red,
 * it just quietly serves worse data. Which is exactly why it needs a gate
 * rather than a rule in a document.
 *
 * WHAT IS ALLOWED
 *   .maybeSingle()  — a read that may legitimately return zero rows
 *   a multi-row select with neither
 *
 * Comments are exempt: the rule is discussed by name in several files, and
 * an earlier grep-based check would have flagged five comments and no code.
 *
 * Escape hatch, if a read genuinely must have exactly one row and a missing
 * one is a real error you want raised: append on the same line
 *   // single-allow: <why a zero-row result is an error here>
 *
 * Exit codes: 0 clean · 1 violations found · 2 script error
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';

const ROOTS = ['src', 'server/src'];
const EXT = /\.(ts|tsx)$/;
const SKIP_DIR = new Set(['node_modules', 'dist', 'build', '.git']);

function* walk(dir) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of entries) {
    if (SKIP_DIR.has(name)) continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) yield* walk(full);
    else if (EXT.test(name)) yield full;
  }
}

/**
 * Blank out block comments, line comments and string literals so `.single()`
 * inside any of them cannot be mistaken for a call. Replacing with spaces
 * rather than deleting keeps column numbers honest.
 */
function stripNonCode(src) {
  let out = '';
  let i = 0;
  const n = src.length;
  while (i < n) {
    const two = src.slice(i, i + 2);
    if (two === '/*') {
      const end = src.indexOf('*/', i + 2);
      const stop = end === -1 ? n : end + 2;
      for (let k = i; k < stop; k++) out += src[k] === '\n' ? '\n' : ' ';
      i = stop;
    } else if (two === '//') {
      let stop = src.indexOf('\n', i);
      if (stop === -1) stop = n;
      out += ' '.repeat(stop - i);
      i = stop;
    } else if (src[i] === '"' || src[i] === "'" || src[i] === '`') {
      const quote = src[i];
      let k = i + 1;
      while (k < n && src[k] !== quote) {
        if (src[k] === '\\') k++;
        k++;
      }
      const stop = Math.min(k + 1, n);
      for (let j = i; j < stop; j++) out += src[j] === '\n' ? '\n' : ' ';
      i = stop;
    } else {
      out += src[i];
      i++;
    }
  }
  return out;
}

let violations = 0;
try {
  for (const root of ROOTS) {
    for (const file of walk(join(process.cwd(), root))) {
      const raw = readFileSync(file, 'utf8');
      if (!raw.includes('.single()')) continue;
      const code = stripNonCode(raw);
      const codeLines = code.split('\n');
      const rawLines = raw.split('\n');
      codeLines.forEach((line, idx) => {
        if (!line.includes('.single()')) return;
        if ((rawLines[idx] || '').includes('single-allow:')) return;
        violations++;
        const rel = file.replace(process.cwd() + '/', '');
        console.error(`SINGLE VIOLATION: ${rel}:${idx + 1}`);
        console.error(`  ${(rawLines[idx] || '').trim()}`);
      });
    }
  }
} catch (err) {
  console.error(`check-maybe-single: script error: ${err.message}`);
  process.exit(2);
}

if (violations > 0) {
  console.error(
    `\n${violations} .single() call(s) on a Supabase read.` +
      `\nZero rows resolves as { data: null, error: PGRST116 } — it does not throw,` +
      `\nso a call site that reads only \`data\` fails silently and serves worse data.` +
      `\nUse .maybeSingle(), or annotate with // single-allow: <why zero rows is an error>.`
  );
  process.exit(1);
}
console.log('check-maybe-single: clean — no .single() calls in src or server/src.');
