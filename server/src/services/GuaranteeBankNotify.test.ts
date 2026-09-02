/**
 * OVERLAYS FUND FROM THE UNION BANK, AND A REFUSAL REACHES THE OWNERS
 * (Dan 2026-08-29, binding).
 *
 * "ALL TOURNAMENTS THAT ARE SHORT OR HAVE OVERLAYS ARE FUNDED FROM THE UNION
 *  BANK WALLET (OR FROM THE CLUB WALLET IF IT'S A STAND ALONE CLUB). THERE
 *  SHOULD NEVER BE ANYTHING PREVENTING NEW TOURNAMENTS TO RUN AS LONG AS THE
 *  BANK HOLDS ENOUGH CHIPS TO COVER. IF THEY DON'T, A POP UP MUST APPEAR."
 *
 * The money movement itself is SQL (fn_apply_prize_guarantee,
 * trg_tournaments_guarantee_affordable, fn_notify_guarantee_bank_short) and
 * was probed against production inside rolled-back transactions per CLAUDE.md
 * 11.5 — a coverable guarantee accepted, an uncoverable one refused naming the
 * union bank. What THESE tests pin is the TypeScript half: the refusal
 * signature triggers the owner notification, because a raising trigger rolls
 * back anything it writes itself, so if the app side forgets to call
 * fn_notify_guarantee_bank_short the pop-up silently never happens — which was
 * the exact state of the world this morning, 570 refusals an hour and nobody
 * told.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

/**
 * The innermost `{ ... }` block containing `needle` — the same structural
 * window as tests/helpers/sourceWindow.ts's sliceEnclosingBlock. Inlined
 * rather than imported: the server tree's ESM guard (every relative import
 * carries .js) and its tsc rootDir both refuse a reach across trees, and a
 * ten-line brace walk is cheaper than loosening either guard.
 */
const sliceEnclosingBlock = (src: string, needle: string): string => {
  const at = src.indexOf(needle);
  if (at < 0) throw new Error(`sliceEnclosingBlock: "${needle}" not found`);
  let depth = 0;
  let open = -1;
  for (let i = at; i >= 0; i--) {
    if (src[i] === '}') depth++;
    else if (src[i] === '{') {
      if (depth === 0) {
        open = i;
        break;
      }
      depth--;
    }
  }
  if (open < 0) throw new Error(`sliceEnclosingBlock: no enclosing block for "${needle}"`);
  let d = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') d++;
    else if (src[i] === '}') {
      d--;
      if (d === 0) return src.slice(open, i + 1);
    }
  }
  return src.slice(open);
};

const svc = readFileSync(
  new URL('./ScheduledTournamentService.ts', import.meta.url).pathname,
  'utf8'
);

describe('the pop-up wiring - a guarantee refusal must notify the owners', () => {
  it('the scheduled spawn failure path calls fn_notify_guarantee_bank_short on the guard signature', () => {
    // The call must live in the insert-failure branch and be keyed on the
    // guard's message, not fire for every failed insert.
    expect(svc).toContain("rpc('fn_notify_guarantee_bank_short'");
    expect(svc).toMatch(/cannot guarantee/i);
    const failAt = svc.indexOf('ScheduledTournaments.insert_failed');
    const notifyAt = svc.indexOf("rpc('fn_notify_guarantee_bank_short'");
    expect(failAt).toBeGreaterThan(0);
    expect(notifyAt).toBeGreaterThan(failAt);
  });

  it('the restart path notifies too - a manual club event deserves the same pop-up', () => {
    /* ROUND 10 (2026-08-29): this was `svc.slice(restartAt, restartAt +
       1500)` — the exact fixed-byte window noFixedSizeSourceWindows.test.ts
       forbids, and it went red on main the moment that scanner saw it. The
       failure branch that reports restart_insert_failed is the structure the
       pin is about: the notify call must live INSIDE it. */
    const branch = sliceEnclosingBlock(svc, 'ScheduledTournaments.restart_insert_failed');
    expect(branch).toContain('fn_notify_guarantee_bank_short');
  });

  it('a notify failure is reported, never swallowed', () => {
    expect(svc).toContain('ScheduledTournaments.guarantee_notify_failed');
  });
});

describe('the funder log names the bank that actually paid', () => {
  it('TournamentManagerBase reads bank_type from the RPC instead of asserting "club treasury"', () => {
    const base = readFileSync(
      new URL('../tournament/TournamentManagerBase.ts', import.meta.url).pathname,
      'utf8'
    );
    expect(base).toContain("res.bank_type === 'union'");
    // The unconditional claim that misled reconciliation is gone.
    expect(base).not.toContain('debited from the club treasury (now');
  });
});

describe('the migration is in the repo, not only in the database', () => {
  /**
   * 20260827f taught this lesson the hard way: a doc-only migration claimed
   * union-bank funding was live, the live function contradicted it, and the
   * platform ran three more weeks on the wrong wallet. The real SQL must be
   * committed so the repo and the database cannot silently disagree again.
   */
  it('the union-bank migration contains the actual function bodies', () => {
    const mig = readFileSync(
      new URL(
        '../../../supabase/migrations/20260829160000_overlays_fund_from_the_union_bank_for_real.sql',
        import.meta.url
      ).pathname,
      'utf8'
    );
    expect(mig).toContain('create or replace function public.fn_apply_prize_guarantee');
    expect(mig).toContain('create or replace function public.trg_tournaments_guarantee_affordable');
    expect(mig).toContain('create or replace function public.fn_notify_guarantee_bank_short');
    // The rule itself, in both functions: the union bank is what pays and
    // what must cover.
    expect(mig.match(/union_wallets/g)!.length).toBeGreaterThanOrEqual(3);
    // Union exposure must be summed across every club sharing the bank.
    expect(mig).toContain('c2.union_id = v_union');
    // The pop-up dedupes on unread so a 30s retry loop cannot storm the bell.
    expect(mig).toContain('coalesce(n.is_read, false) = false');
    // And it is not a SELECT 1 stub like 20260827f.
    expect(mig).not.toMatch(/^\s*SELECT 1;\s*$/m);
  });
});
