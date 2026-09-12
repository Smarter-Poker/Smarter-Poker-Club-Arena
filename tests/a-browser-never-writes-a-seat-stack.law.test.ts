/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  A BROWSER NEVER WRITES A SEAT STACK (2026-09-12)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * 268 `Auto-rebuy failed` reports, 2026-03-25 to 2026-04-14, 160 distinct
 * horses, 55,472.80 chips of top-up that never reached a seat. Every one of
 * them: `Could not complete stack update of N chips: TypeError: Failed to
 * fetch`.
 *
 * The mechanism was the deleted `src/services/AutoRebuyService.ts`, which
 * said so in its own comment:
 *
 *     // Direct stack UPDATE - atomic_table_rebuy RPC has UUID type mismatch
 *     // bug. This achieves the same result: add chips to horse's stack.
 *     const newStack = (currentSeat.stack || 0) + amount;
 *     await supabase.from('table_seats').update({ stack: newStack })...
 *
 * It does NOT achieve the same result. `atomic_table_rebuy` is one plpgsql
 * SECURITY DEFINER function that checks the seat, debits the wallet, raises
 * on an insufficient balance, credits `table_seats.stack` and writes the
 * `wallet_transactions` row - one transaction, so a failure anywhere rolls
 * the whole thing back. The browser's substitute was a read-modify-write of
 * a money column with no wallet leg, no idempotency key and no atomicity: two
 * clients watching the same table raced the same top-up (the double-debit and
 * over-stack that commit 6d5cbfdaf4/b0c95f0635 removed the service to end).
 *
 * Those 268 failures cost nobody a chip - the path that failed moved no money
 * in either direction, and the seat row was never touched, so no seat was
 * lost either. What it cost was 160 horses playing short. Under CLAUDE.md
 * 10.5 a horse is a player and `autoRebuyHorse` is its input device, so a
 * horse left short is a real defect, not an accounting rounding error.
 *
 * Chips reach a seat through the server's atomic doors now
 * (`fn_horse_fund_from_treasury` for a horse, `atomic_table_addon` /
 * `atomic_table_buyin` for a human). This law pins the browser out of the
 * money column, so the shortcut cannot be reintroduced the next time an RPC
 * looks broken.
 *
 * SCOPE: `src/` - the browser. `server/src/tournament/TournamentManagerBase.ts`
 * still writes `stack` directly for tournament chips, which are not wallet
 * chips and are not funded from a wallet; that path is deliberately out of
 * scope here rather than silently included.
 */
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(__dirname, '..');

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry.startsWith('.')) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...sourceFiles(full));
    else if (/\.(ts|tsx)$/.test(entry) && !/\.test\./.test(entry)) out.push(full);
  }
  return out;
}

/** Strip line and block comments, preserving newlines so line numbers hold.
 *  Without this the quoted AutoRebuyService snippet in this file's own header
 *  - and any postmortem comment quoting it - reads as a live violation. */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:])\/\/[^\n]*/g, (_m, p1) => p1);
}

/** A write to table_seats that sets `stack`. The chain between `.from(
 *  'table_seats')` and the mutation is short in every real call site, so a
 *  600-char window catches the write without spanning unrelated statements. */
function seatStackWrites(dir: string): string[] {
  const hits: string[] = [];
  for (const file of sourceFiles(join(ROOT, dir))) {
    const src = stripComments(readFileSync(file, 'utf8'));
    const from = /\.from\s*\(\s*['"`]table_seats['"`]\s*\)/g;
    let m: RegExpExecArray | null;
    while ((m = from.exec(src))) {
      const window = src.slice(m.index, m.index + 600);
      const write = /\.(update|insert|upsert)\s*\(\s*[[{]/.exec(window);
      if (!write) continue;
      const payload = window.slice(write.index, write.index + 400);
      if (/[{,[]\s*stack\s*:/.test(payload) || /\bstack\s*:\s*\w/.test(payload)) {
        hits.push(`${file.replace(ROOT + '/', '')}:${src.slice(0, m.index).split('\n').length}`);
      }
    }
  }
  return hits;
}

describe('a browser never writes a seat stack', () => {
  it('has no client-side write to table_seats.stack', () => {
    expect(
      seatStackWrites('src'),
      'A file under src/ writes `stack` on table_seats directly. That column is\n' +
        'money on the felt. A browser read-modify-write of it has no wallet leg,\n' +
        'no idempotency key and no atomicity - it is the deleted AutoRebuyService\n' +
        'verbatim, which produced 268 failed top-ups and the double-debit that\n' +
        'commit 6d5cbfdaf4 removed the service to stop.\n\n' +
        'Chips reach a seat through the server doors: fn_horse_fund_from_treasury\n' +
        '(horse), atomic_table_addon / atomic_table_buyin (human). If one of them\n' +
        'looks broken, fix the door - do not go around it.\n\n' +
        'Offending sites:\n' +
        seatStackWrites('src').join('\n')
    ).toEqual([]);
  });

  it('funds a horse through the atomic treasury door, keyed for idempotency', () => {
    const wallets = readFileSync(join(ROOT, 'server/src/services/supabase/wallets.ts'), 'utf8');
    const fn = wallets.slice(wallets.indexOf('export async function autoRebuyHorse'));
    expect(
      fn.length,
      'autoRebuyHorse has gone from server/src/services/supabase/wallets.ts'
    ).toBeGreaterThan(0);
    const body = fn.slice(0, 4000);
    expect(
      body,
      'the horse rebuy must go through the atomic treasury RPC, not a table write'
    ).toContain("supabase.rpc('fn_horse_fund_from_treasury'");
    expect(
      body,
      'the rebuy must carry a derived op_id so a retry cannot fund the horse twice'
    ).toMatch(/p_op_id:\s*opId/);
    expect(
      body,
      'the op_id must be derived from table+user+hand, not random, or a retry mints chips'
    ).toMatch(/uuidv5\(\s*'horse-rebuy:'/);
    expect(body, 'autoRebuyHorse must not write table_seats itself').not.toMatch(
      /\.from\s*\(\s*['"`]table_seats['"`]\s*\)[\s\S]{0,300}\.update\s*\(/
    );
  });
});
