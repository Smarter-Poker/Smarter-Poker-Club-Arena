#!/usr/bin/env node
/**
 * check-discarded-read-then-write — the pattern that created 33,309 duplicate rows
 * ═══════════════════════════════════════════════════════════════════════════
 * WHY THIS EXISTS
 *
 * `training_user_achievements` reached 33,353 rows for 44 real
 * (user, achievement) pairs — 99.87% duplicates, the worst single pair at
 * 13,047 rows and still growing one per page load. The mechanism was four
 * characters wide:
 *
 *     const { data: existing } = await supabase        // <- error DISCARDED
 *       .from('training_user_achievements')
 *       .select(...).eq(user).eq(achievement).maybeSingle();
 *     if (existing) update(...) else insert(...)
 *
 * `.maybeSingle()` ERRORS when more than one row matches. Only `data` was
 * destructured, so "I could not read it" became "it does not exist", and the
 * branch inserted. One duplicate begat the next, and the rate compounded.
 *
 * A Supabase query builder RESOLVES with `{data: null, error}` rather than
 * rejecting, so nothing throws, no catch fires, and no test that stubs a happy
 * path can see it. That is what makes this shape worth a gate rather than a
 * code review: it is invisible at every level except the one where you read the
 * destructuring.
 *
 * WHAT IT FLAGS
 *
 * Only the compound that can actually duplicate a row: within one function,
 *
 *   1. a read from table T whose `error` is not destructured, AND
 *   2. an `.insert(` or `.upsert(` into the SAME table T.
 *
 * A discarded error on a read that only paints a screen is untidy; a discarded
 * error on a read that GATES A WRITE is a data-integrity bug. There are ~345
 * of the former in src/ and this gate deliberately ignores them.
 *
 * WHY A UNIQUE INDEX IS NOT ENOUGH ON ITS OWN
 *
 * It is the better fix and most of these tables now have one. But an index
 * turns silent duplication into a 23505 the caller must handle, and a caller
 * that discarded the READ error usually discards that one too. Both halves.
 *
 * USAGE   node scripts/ci/check-discarded-read-then-write.mjs
 *         exit 1 on a finding.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';

const files = execFileSync('git', ['ls-files', 'src/**/*.ts', 'src/**/*.tsx'], {
  encoding: 'utf8',
})
  .trim()
  .split('\n')
  .filter((file) => file && existsSync(file));

/** Comment bodies blanked, length preserved, so line numbers stay true. */
function maskComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/^([ \t]*)\/\/.*$/gm, (m, indent) => indent + ' '.repeat(m.length - indent.length));
}

/**
 * How far after a read a write still counts as gated by it.
 *
 * A PROXIMITY WINDOW RATHER THAN FUNCTION BOUNDARIES. The first version of this
 * gate tried to split the file into functions and relate a read to a write
 * inside the same one. The heuristic for "a function starts here" also matched
 * `if (existingErr) {` — an `if` at low indent has the same shape as a method
 * signature — so inserting a comment and a guard between a read and its write
 * pushed them into different "functions" and the gate went quiet on a call site
 * it had flagged five minutes earlier. A gate that stops seeing a bug when
 * somebody adds a comment is worse than no gate: it reports clean.
 *
 * Lines, not characters, so a long explanatory comment above the write cannot
 * push it out of range the way a character budget did.
 */
const WINDOW_LINES = 60;

/** `.from('T')` chained directly to `.insert(`/`.upsert(`, no other .from( between. */
const WRITE_CHAIN =
  /\.from\(\s*['"`]([\w.]+)['"`]\s*\)(?:(?!\.from\()[\s\S]){0,400}?\.(insert|upsert)\(/g;

/** `const { … } = await supabase … .from('T') … ;` */
const READ =
  /const\s*\{([^}]*)\}\s*=\s*await\s+supabase[\s\S]{0,600}?\.from\(\s*['"`]([\w.]+)['"`]\s*\)([\s\S]{0,800}?);/g;

const findings = [];

for (const file of files) {
  const raw = readFileSync(file, 'utf8');
  if (!raw.includes('.from(')) continue;
  const src = maskComments(raw);
  const lineOf = (index) => src.slice(0, index).split('\n').length;

  // Every write, with the line it happens on.
  const writes = [];
  let m;
  WRITE_CHAIN.lastIndex = 0;
  while ((m = WRITE_CHAIN.exec(src))) writes.push({ table: m[1], line: lineOf(m.index) });
  if (writes.length === 0) continue;

  READ.lastIndex = 0;
  while ((m = READ.exec(src))) {
    const [whole, destructured, table, tail] = m;
    if (/\berror\b/.test(destructured)) continue; // handled, or at least visible
    /**
     * A COUNT IS NOT AN EXISTENCE GATE. `const { count } = …head: true` reads a
     * number for a badge; it is not the `if (existing) … else insert(…)` shape
     * this gate is about. NotificationService reads an unread count and, forty
     * lines later in a different method, inserts a notification — related by
     * proximity and by nothing else.
     */
    if (!/\bdata\b/.test(destructured)) continue;
    if (!/\.(select|maybeSingle|single)\(/.test(tail) && !/\.select\(/.test(whole)) continue;
    const readLine = lineOf(m.index);
    const gated = writes.some(
      (w) => w.table === table && w.line > readLine && w.line - readLine <= WINDOW_LINES
    );
    if (!gated) continue;
    findings.push(
      `${file}:${readLine}  reads '${table}' with the error discarded, then writes to '${table}'`
    );
  }
}

if (findings.length) {
  console.error(
    'DISCARDED READ ERROR GATING A WRITE\n\n' +
      'A Supabase builder resolves with {data: null, error}; it does not reject.\n' +
      'Destructuring only `data` turns "the read failed" into "the row is not\n' +
      'there", and the next branch inserts. That is how training_user_achievements\n' +
      'reached 33,353 rows for 44 real pairs.\n\n' +
      'Destructure `error`, handle it, and do not fall through to the write:\n\n' +
      findings.map((f) => '  ' + f).join('\n') +
      '\n'
  );
  process.exit(1);
}

console.log(
  `check-discarded-read-then-write: clean (${files.length} files, no read-gated write discards its error)`
);
