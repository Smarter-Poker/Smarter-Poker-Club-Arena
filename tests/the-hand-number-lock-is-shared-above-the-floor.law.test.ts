/**
 * THE HAND-NUMBER LOCK IS SHARED ABOVE THE FLOOR (2026-09-26)
 *
 * smarter_private.f06_allocate_number_above allocates every hand number in
 * the fleet. It took one global advisory lock EXCLUSIVE, held to COMMIT, so a
 * single commit flush stall queued every hand start behind it; with the
 * function's lock_timeout of 2 s each waiter past two seconds was a refused
 * hand start (09:25 UTC: 860 waits over 1 s and 408 lock timeouts in five
 * minutes).
 *
 * The lock only has to exclude one thing: a setval, the one operation that
 * can move the sequence backward, interleaving with other allocations. So:
 *   - when the sequence already stands at or above the caller's floor, the
 *     lock is taken SHARED and only nextval runs, and a result below the
 *     floor is refused, never returned;
 *   - setval stays on the EXCLUSIVE path, and nowhere else.
 *
 * These laws read the LATEST migration that defines the function, so a later
 * redefinition is held to the same rules. Each rule has a planted regression
 * that the same check must refuse. Real concurrency (48 clients, a planted
 * rewind that must produce duplicates) is exercised by
 * scripts/ci/probes/hand-number-lock/concurrency.sh.
 *
 * 20260926131732. docs/changelog/2026-09-26-the-hand-number-lock-is-shared-above-the-floor.md
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const MIGRATIONS = join(__dirname, '..', 'supabase', 'migrations');
const DEFINES = /CREATE (?:OR REPLACE )?FUNCTION smarter_private\.f06_allocate_number_above\(/;

function latestDefinition(): { file: string; body: string } {
  const files = readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith('.sql'))
    .sort();
  let found: { file: string; body: string } | null = null;
  for (const file of files) {
    const sql = readFileSync(join(MIGRATIONS, file), 'utf8');
    const m = sql.match(
      /CREATE (?:OR REPLACE )?FUNCTION smarter_private\.f06_allocate_number_above\([\s\S]*?AS (\$[a-z_]*\$)([\s\S]*?)\1;/
    );
    if (m) found = { file, body: m[2] };
  }
  if (!found) throw new Error('no migration defines smarter_private.f06_allocate_number_above');
  return found;
}

const code = (s: string) =>
  s
    .split('\n')
    .map((l) => l.replace(/--.*$/, ''))
    .join('\n');

const SHARED =
  "pg_advisory_xact_lock_shared(hashtextextended('f06:global-hand-number-allocation',0))";
const EXCLUSIVE = "pg_advisory_xact_lock(hashtextextended('f06:global-hand-number-allocation',0))";

/** Every violation of the rules, empty when the body keeps them. */
function violations(raw: string): string[] {
  const body = code(raw);
  const out: string[] = [];
  const branch = body.indexOf('IF prior>=floor_number THEN');
  const shared = body.indexOf(SHARED);
  const exclusive = body.indexOf(EXCLUSIVE);
  const setvals = [...body.matchAll(/setval\(/g)].map((m) => m.index ?? -1);
  if (branch < 0) out.push('no above-the-floor branch reading the sequence before the lock');
  if (shared < 0) out.push('the above-the-floor branch does not take the lock shared');
  if (exclusive < 0) out.push('the setval path does not take the lock exclusive');
  if (branch >= 0 && shared >= 0 && exclusive >= 0) {
    // The shared branch is the text from the branch to its RETURN, and it
    // must end before the exclusive lock is taken.
    const ret = body.indexOf('RETURN n;', branch);
    const sharedBranch = body.slice(branch, ret);
    if (!(branch < shared && shared < ret && ret < exclusive))
      out.push('the shared lock is not confined to the above-the-floor branch');
    if (/setval\(/.test(sharedBranch)) out.push('setval runs under the shared lock');
    if (!/n<floor_number/.test(sharedBranch.replace(/\s+/g, '')))
      out.push('the shared branch returns a number without refusing one below the floor');
    if (!/RAISE EXCEPTION 'F06_HAND_NUMBER_UNSAFE'/.test(sharedBranch))
      out.push('the shared branch does not refuse');
    if (sharedBranch.indexOf(SHARED) > sharedBranch.indexOf('nextval('))
      out.push('nextval runs before the shared lock is held');
    for (const at of setvals)
      if (at < exclusive) out.push('a setval runs before the exclusive lock');
  }
  if (setvals.length !== 1) out.push(`expected exactly one setval, found ${setvals.length}`);
  if ((body.match(/pg_advisory_xact_lock\(/g) ?? []).length !== 1)
    out.push('the exclusive lock is taken more or less than once');
  if (/pg_advisory_unlock|pg_advisory_lock\(|pg_advisory_lock_shared\(/.test(body))
    out.push('a session-level advisory lock can outlive the transaction on a pooled connection');
  return out;
}

describe('the hand-number lock is shared above the floor', () => {
  const { file, body } = latestDefinition();

  it('the latest definition keeps every rule', () => {
    expect(file >= '20260926131732', file).toBe(true);
    expect(violations(body)).toEqual([]);
  });

  it('keeps the range guard and the setval-to-floor on the exclusive path', () => {
    const c = code(body);
    expect(c).toContain('floor_number<1000000 OR floor_number>9007199254740991');
    expect(c).toContain("n:=setval('public.global_hand_number_seq',floor_number,true)");
    expect(c.indexOf(EXCLUSIVE)).toBeLessThan(c.indexOf('setval('));
  });

  it('keeps SECURITY DEFINER, the search_path and the two-second lock timeout', () => {
    const sql = readFileSync(join(MIGRATIONS, file), 'utf8');
    const head = sql.slice(sql.search(DEFINES), sql.indexOf(body));
    expect(head).toMatch(/SECURITY DEFINER/);
    expect(head).toMatch(/lock_timeout TO '2s'|lock_timeout='2s'/);
    expect(head).toMatch(/search_path TO 'pg_catalog', 'public'|search_path=pg_catalog,public/);
  });

  describe('planted regressions are refused', () => {
    const plant = (from: string, to: string) => {
      expect(body.includes(from), from).toBe(true);
      return body.replace(from, to);
    };

    it('the whole function back on the exclusive lock (the 2026-09-12 shape)', () => {
      expect(violations(plant(SHARED, EXCLUSIVE)).length).toBeGreaterThan(0);
    });

    it('the setval path on the shared lock', () => {
      expect(violations(plant(EXCLUSIVE, SHARED)).length).toBeGreaterThan(0);
    });

    it('a setval inside the shared branch', () => {
      const bad = plant(
        "   n:=nextval('public.global_hand_number_seq');\n   IF n>9007199254740991 OR n<floor_number",
        "   n:=nextval('public.global_hand_number_seq');\n   IF n<floor_number THEN n:=setval('public.global_hand_number_seq',floor_number,true); END IF;\n   IF n>9007199254740991 OR n<floor_number"
      );
      expect(violations(bad)).toContain('setval runs under the shared lock');
    });

    it('the shared branch returning a number below the floor', () => {
      const bad = plant(
        'IF n>9007199254740991 OR n<floor_number THEN',
        'IF n>9007199254740991 THEN'
      );
      expect(violations(bad)).toContain(
        'the shared branch returns a number without refusing one below the floor'
      );
    });

    it('nextval before the shared lock', () => {
      const bad = plant(`   PERFORM ${SHARED};\n`, '').replace(
        "   n:=nextval('public.global_hand_number_seq');\n   IF n>9007199254740991 OR",
        `   n:=nextval('public.global_hand_number_seq');\n   PERFORM ${SHARED};\n   IF n>9007199254740991 OR`
      );
      expect(violations(bad)).toContain('nextval runs before the shared lock is held');
    });

    it('a session-level lock', () => {
      const bad = plant(
        SHARED,
        SHARED.replace('pg_advisory_xact_lock_shared', 'pg_advisory_lock_shared')
      );
      expect(violations(bad).length).toBeGreaterThan(0);
    });
  });
});
