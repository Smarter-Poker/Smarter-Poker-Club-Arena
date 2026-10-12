/**
 * A TOURNAMENT START LOCKS THE BANK WITHOUT BLOCKING FOREIGN KEYS (2026-09-29).
 *
 * fn_guard_tournament_start_readiness (BEFORE UPDATE OF status on every
 * tournament start) locked its bank row - public.clubs or public.union_wallets -
 * FOR UPDATE, and fn_ca_fund_overlay_on_lock did the same in the same
 * transaction. FOR UPDATE is the only row lock that also conflicts with FOR KEY
 * SHARE, the lock each foreign-key check takes on the club row an INSERT
 * references (agent_commissions, rake_records, table_seats, tournament_players
 * and more). Every start therefore drained every open writer that named the
 * club, and every later writer, and every finish, queued behind the start.
 * Measured 2026-09-29 07:09-07:15 UTC: a launch held or queued FOR UPDATE on
 * Deep Stack Society's clubs row in 47 of 80 samples (one waited 21.7 s behind
 * a commission batch), and the finish that waited behind them held the global
 * finish lane, so every finish on the platform waited too.
 *
 * FOR NO KEY UPDATE keeps every exclusion the guard exists for (a competing
 * start, the overlay, every treasury write) and drops only the one it never
 * needed. The native proof is scripts/dev/probe-start-readiness-lock.py.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

const root = resolve(__dirname, '..');
const migrations = join(root, 'supabase/migrations');
const MIGRATION = '20260929071925_a_tournament_start_locks_the_bank_without_blocking_foreign_k.sql';

/** The body of the LAST migration that (re)defines public.<name>(), comments stripped. */
function latestBody(name: string): { file: string; code: string } {
  const files = readdirSync(migrations)
    .filter((f) => f.endsWith('.sql'))
    .sort();
  const header = new RegExp(
    `CREATE OR REPLACE FUNCTION public\\.${name}\\(\\)[\\s\\S]*?\\$function\\$([\\s\\S]*?)\\$function\\$`
  );
  for (let i = files.length - 1; i >= 0; i -= 1) {
    const match = header.exec(readFileSync(join(migrations, files[i]), 'utf8'));
    if (match) {
      const code = match[1]
        .split('\n')
        .map((line) => line.replace(/--.*$/, ''))
        .join('\n');
      return { file: files[i], code };
    }
  }
  throw new Error(`no migration defines public.${name}()`);
}

describe('a tournament start locks the bank without blocking foreign-key checks', () => {
  it.each([
    ['fn_guard_tournament_start_readiness', 2],
    ['fn_ca_fund_overlay_on_lock', 3],
  ])('%s takes FOR NO KEY UPDATE on every bank row and never FOR UPDATE', (name, locks) => {
    const { file, code } = latestBody(name);
    expect(file >= MIGRATION, `${file} predates the fix`).toBe(true);
    expect(code).not.toMatch(/\bFOR\s+UPDATE\b/i);
    expect(code).not.toMatch(/\bFOR\s+SHARE\b/i);
    expect(code.match(/\bFOR\s+NO\s+KEY\s+UPDATE\b/gi)?.length).toBe(locks);
  });

  it('keeps the start guard serialising on the bank the overlay debits', () => {
    const { code } = latestBody('fn_guard_tournament_start_readiness');
    expect(code).toContain('FROM public.clubs c WHERE c.id = NEW.club_id FOR NO KEY UPDATE');
    expect(code).toContain('WHERE uw.union_id = NEW.union_id FOR NO KEY UPDATE');
    expect(code).toContain('COALESCE(NEW.is_private, false) OR NEW.union_id IS NULL');
  });

  it('is installed only over the reviewed production pre-image and asserts its post-image', () => {
    const sql = readFileSync(join(migrations, MIGRATION), 'utf8');
    expect(sql).toContain("'f2ee43657b769c37527ae2974101bb06'");
    expect(sql).toContain("'93f3e46a957abb7a42d4a2cfaff42fcb'");
    expect(sql).toContain('DO $post$');
    expect(sql).toContain("position('FOR UPDATE;' in p.prosrc) = 0");
    expect(sql.match(/^BEGIN;$/gm)).toHaveLength(1);
    expect(sql.match(/^COMMIT;$/gm)).toHaveLength(1);
    expect(sql).toContain('SET LOCAL lock_timeout');
  });

  it('is proved against real PostgreSQL in the accounting job', () => {
    const probe = readFileSync(join(root, 'scripts/dev/probe-start-readiness-lock.py'), 'utf8');
    expect(probe).toContain('expect("pre-image", fk_blocks_start=True, start_blocks_fk=True)');
    expect(probe).toContain('expect("post-image", fk_blocks_start=False, start_blocks_fk=False)');
    expect(probe).toContain('two starts of one club bank must serialize');
    const runner = readFileSync(join(root, 'scripts/dev/probe-departure-postgres.sh'), 'utf8');
    expect(runner).toContain('python3 "$repo/scripts/dev/probe-start-readiness-lock.py"');
    const ci = parse(readFileSync(join(root, '.github/workflows/ci.yml'), 'utf8'));
    const step = ci.jobs.accounting_postgres.steps.find(
      (s: { run?: string }) => s.run === 'bash scripts/dev/probe-departure-postgres.sh'
    );
    expect(step, 'the accounting job must run the probe runner').toBeDefined();
    expect(step.if).toBe('matrix.shard == 3');
  });
});
