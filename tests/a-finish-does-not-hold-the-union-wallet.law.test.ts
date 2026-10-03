/**
 * A FINISH DOES NOT HOLD THE UNION WALLET.
 *
 * fn_complete_tournament_terminal_pre_seat_guard pre-locked the union's ONE
 * union_wallets row FOR NO KEY UPDATE near the top of every tournament finish
 * and held it to COMMIT, through evidence locks, the cash authority, the
 * bounty close, the rake settlement and the lifecycle. Every raked cash hand
 * of the union credits that row (atomic_distribute_rake), so the union's hands
 * queued behind every finish. Production, 2026-10-03 03:00-05:04 UTC: 1,100+
 * statement timeouts and 31 deadlocks on the hand's union credit; the holder
 * was a finish in 7 of 10 samples, and every deadlock paired a hand with
 * fn_complete_tournament_terminal.
 *
 * The pre-lock's job is ORDER between finishes, not a balance guard: the two
 * finish paths that write the row lock it themselves before reading it. So
 * finishes of a union now serialize on an advisory lock only finishes take,
 * sorted, at the same point; the row is held from the finish's first real
 * write of it. scripts/ci/test-a-finish-does-not-hold-the-union-wallet.py
 * proves both arms on a disposable cluster with the shipped text.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';

const MIGRATIONS = join(__dirname, '..', 'supabase', 'migrations');
const ALL = readdirSync(MIGRATIONS).filter((f) => f.endsWith('.sql')).sort();
const NAME = ALL.filter((f) => f.endsWith('_a_finish_does_not_hold_the_union_wallet.sql')).at(-1);
if (!NAME) throw new Error('the finish union-wallet migration is missing');
const SQL = readFileSync(join(MIGRATIONS, NAME), 'utf8');
const CODE = SQL.split('\n')
  .filter((l) => !l.trimStart().startsWith('--'))
  .join('\n');
const side = (name: 'v_old' | 'v_new'): string => {
  const block = CODE.slice(CODE.indexOf('DO $subs$'), CODE.indexOf('END $subs$;'));
  const start = block.indexOf(`${name} := `);
  const end = block.indexOf(name === 'v_old' ? "';\n" : "END IF;\\n';", start);
  return [...block.slice(start, end + 12).matchAll(/E'((?:[^'\\]|\\.)*)'/g)]
    .map((m) => m[1].replace(/\\'/g, "'").replace(/\\n/g, '\n'))
    .join('');
};
const HARNESS = readFileSync(
  join(__dirname, '..', 'scripts', 'ci', 'test-a-finish-does-not-hold-the-union-wallet.py'),
  'utf8'
);
const UNION_ROW_LOCK = /FROM public\.union_wallets[^;]*FOR (NO KEY )?UPDATE/;

describe('a finish does not hold the union wallet', () => {
  it('replaces exactly the union wallet row pre-lock', () => {
    const oldText = side('v_old');
    expect(oldText).toMatch(/^ {4}PERFORM 1 FROM public\.union_wallets uw\n/);
    expect(oldText).toMatch(/ORDER BY uw\.union_id FOR NO KEY UPDATE;\n$/);
    expect(oldText).toMatch(UNION_ROW_LOCK);
  });

  it('claims each union with a finish-only advisory lock, sorted, and never the row', () => {
    const newText = side('v_new');
    expect(newText).not.toMatch(UNION_ROW_LOCK);
    const newCode = newText.replace(/\/\*[\s\S]*?\*\//g, '');
    expect(newCode).not.toMatch(/\bUPDATE\b[^;]*union_wallets|INSERT INTO public\.union_wallets/);
    expect(newText.match(/pg_advisory_xact_lock\(/g)?.length).toBe(2);
    expect(newText).toContain("'ca:union-finish-bank:v1:' || LEAST(v_event_union_id,v_current_union_id)::text");
    expect(newText).toContain("'ca:union-finish-bank:v1:' || GREATEST(v_event_union_id,v_current_union_id)::text");
    // LEAST before GREATEST: the same sorted order the row lock had.
    expect(newText.indexOf('LEAST(v_event_union_id')).toBeLessThan(newText.indexOf('GREATEST(v_event_union_id'));
    expect(newText).not.toMatch(/pg_try_advisory|_shared\(/);
  });

  it('keeps the claim after the club wallet and before the cash authority', () => {
    expect(CODE).toContain('FINISH_STILL_HOLDS_THE_UNION_WALLET');
    expect(CODE).toContain('FINISH_UNION_ORDER_LOST');
    expect(CODE).toMatch(/position\('PERFORM 1 FROM public\.club_wallets cw' IN v_src\) > position\('ca:union-finish-bank:v1:'/);
    expect(CODE).toMatch(/position\('ca:union-finish-bank:v1:' IN v_src\) > position\('public\.fn_settle_tournament_places\('/);
  });

  it('pins both images, keeps the privileges, and refuses to land if the live text moved', () => {
    expect(CODE).toContain("'de4a79604fed8edcd5b94aea968516bc'");
    expect(CODE).toContain("'587f4eb17a08a0b2a2570be1662071a6'");
    expect(CODE).toContain('its privileges changed');
    expect(SQL).toMatch(/@live-proof: .*'587f4eb17a08a0b2a2570be1662071a6'/);
    expect(CODE.match(/^BEGIN;$/gm)?.length).toBe(1);
    expect(CODE.match(/^COMMIT;$/gm)?.length).toBe(1);
    expect(CODE).toMatch(/SET LOCAL lock_timeout/);
  });

  it('moves no money and repairs nothing (10.12)', () => {
    expect(CODE).not.toMatch(/cron\.schedule/i);
    expect(CODE).not.toMatch(/\b(backfill|back_pay|backpay|repair|redrive|catchup|resweep)\b/i);
    const outsideTheQuotedText = CODE.replace(/E'(?:[^'\\]|\\.)*'/g, "''");
    expect(outsideTheQuotedText).not.toMatch(/\b(INSERT|UPDATE|DELETE)\b\s+(INTO\s+)?public\./i);
  });

  it('no later migration puts the union wallet row lock back into the finish', () => {
    const later = ALL.filter((f) => f > NAME);
    for (const f of later) {
      const text = readFileSync(join(MIGRATIONS, f), 'utf8');
      const at = text.indexOf('FUNCTION public.fn_complete_tournament_terminal_pre_seat_guard(');
      if (at < 0) continue;
      const body = text.slice(at, text.indexOf('$function$;', at));
      expect(body, f).not.toMatch(UNION_ROW_LOCK);
    }
  });

  it('is proved before and after by the harness, on the shipped text', () => {
    expect(HARNESS).toContain('before-an-open-finish-blocks-every-raked-hand-of-its-union');
    expect(HARNESS).toContain('after-the-hand-passes-and-the-unions-finishes-still-serialize');
    expect(HARNESS).toContain('two-union-claims-wait-in-sorted-order-and-hands-pass');
    expect(HARNESS).toContain('the-row-is-held-from-the-finishs-real-write');
    expect(HARNESS).toContain("OLD, NEW = side('v_old'), side('v_new')");
  });
});
