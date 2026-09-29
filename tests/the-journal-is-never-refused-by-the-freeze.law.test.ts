/**
 * THE JOURNAL IS NEVER REFUSED BY THE FREEZE (chip standard, 2026-09-05).
 * Pinned on the migration mirrored byte-exact from production.
 *
 * Why: 104 BBJ bank moves (9.69 chips) lost their chip_ledger legs at :55 and
 * :00. fn_ca_auto_reconcile_tick (pg_cron, no service_role claim) re-banked
 * drops during the platform freeze; bbj_pools is outside the freeze guard so
 * the bank write stood, chip_ledger is inside it so the leg was refused, and
 * the autoledger logged the refusal and let the write through, as it is
 * built to. A bank moved and the journal did not.
 *
 * LAW 1 - A JOURNAL ROW IS THE RECORD OF A WRITE, NOT A WRITE. The freeze
 *   guard passes a chip_ledger row written from inside another trigger
 *   (pg_trigger_depth() > 1): the write it records was already permitted.
 *   A direct client INSERT on chip_ledger (depth 1) is refused as before.
 * LAW 2 - A SWEEP THAT MOVES MONEY CHECKS THE FREEZE (CLAUDE.md section 13
 *   rule 5). fn_bbj_repair_unbanked returns empty while the platform is
 *   frozen and re-banks at the next tick after play resumes.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const MIG = resolve(HERE, '../supabase/migrations');
const file = readdirSync(MIG).find((n) =>
  /^\d{14}_the_journal_is_never_refused_by_the_freeze\.sql$/.test(n)
);
if (!file) throw new Error('the migration is not mirrored');
const sql = readFileSync(resolve(MIG, file), 'utf8');

const body = (name: string): string => {
  const start = sql.indexOf(`CREATE OR REPLACE FUNCTION public.${name}(`);
  expect(start, `${name} is defined in the migration`).toBeGreaterThan(-1);
  return sql.slice(start, sql.indexOf('$function$;', start));
};

describe('the journal is never refused by the freeze', () => {
  it('LAW 1: the freeze guard passes a chip_ledger row written from inside another trigger, after the bypass and before the role check', () => {
    const g = body('fn_refuse_while_frozen');
    const exemption = g.indexOf("IF TG_TABLE_NAME = 'chip_ledger' AND pg_trigger_depth() > 1 THEN");
    expect(exemption).toBeGreaterThan(-1);
    expect(g.slice(exemption)).toMatch(
      /^IF TG_TABLE_NAME = 'chip_ledger' AND pg_trigger_depth\(\) > 1 THEN\s+RETURN COALESCE\(NEW, OLD\);\s+END IF;/
    );
    expect(exemption).toBeGreaterThan(g.indexOf('fn_freeze_bypass_active()'));
    expect(exemption).toBeLessThan(g.indexOf('request.jwt.claims'));
    // nothing else about the guard changed: the refusal itself is still there
    expect(g).toMatch(
      /IF public\.fn_platform_frozen\(\) THEN\s+RAISE EXCEPTION\s+'PLATFORM_FROZEN/
    );
    expect(g).toMatch(/USING ERRCODE = '55006'/);
  });

  it('LAW 2: fn_bbj_repair_unbanked returns empty while frozen, and the migration asserts both', () => {
    const r = body('fn_bbj_repair_unbanked');
    expect(r).toMatch(
      /BEGIN\s+(--[^\n]*\n\s*)*IF public\.fn_platform_frozen\(\) THEN\s+RETURN;\s+END IF;/
    );
    expect(sql).toMatch(/RAISE EXCEPTION 'the freeze guard does not carry the journal exemption'/);
    expect(sql).toMatch(/RAISE EXCEPTION 'fn_bbj_repair_unbanked does not check the freeze'/);
    expect(sql).toMatch(
      /GRANT EXECUTE ON FUNCTION public\.fn_bbj_repair_unbanked\(integer, integer\) TO service_role;/
    );
    expect((sql.match(/^BEGIN;$/gm) || []).length).toBe(1);
    expect((sql.match(/^COMMIT;$/gm) || []).length).toBe(1);
  });
});

/**
 * LAW 3 - THE LIVE PAYOUT CHECKS THE FREEZE TOO (2026-09-11).
 *
 * LAW 2 above pinned the REPAIR sweep. The live path was never pinned, and it
 * never checked: `processBBJPayout` went straight to the RPC whatever the
 * clock said.
 *
 * The freeze guard looked like the backstop and is not, for us. This law's own
 * header records why in the other direction - `bbj_pools` sits OUTSIDE the
 * guard, which is how 104 bank moves kept their write and lost their journal
 * leg at :55. The engine's half is worse: `fn_refuse_while_frozen` returns
 * early for any caller whose `request.jwt.claims.role` is `service_role`, and
 * the engine holds SUPABASE_SERVICE_ROLE_KEY, so the guard on `table_seats`
 * and `club_members` - the two tables the payout credits - never fires for the
 * engine at all. On this path the engine is the only thing that can honour
 * Dan's "NO CHIP MOVEMENTS".
 *
 * A deferred jackpot is not a lost one: the write-ahead claim is a RECORD
 * rather than a chip movement, it survives the :57 restart, and the reconciler
 * pays it at the thaw against an RPC that is idempotent on (pool, table, hand).
 */
describe('LAW 3: the live jackpot payout defers to the break', () => {
  const SRC = resolve(HERE, '..', 'server/src/services/supabase/bbj.ts');
  const RECON = resolve(HERE, '..', 'server/src/services/FeeReconciler.ts');
  const payout = readFileSync(SRC, 'utf8');
  const reconciler = readFileSync(RECON, 'utf8');
  /* On the CODE. Both files explain in prose what the freeze guard does NOT
     do, and asserting on raw text would make the explanation illegal. */
  const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

  it('processBBJPayout asks before it pays', () => {
    const code = strip(payout);
    expect(code).toMatch(
      /import \{ isMaintenanceFrozen \} from '\.\.\/\.\.\/maintenance\/freezeState\.js';/
    );
    expect(code).toMatch(/if \(isMaintenanceFrozen\(\)\) \{/);
  });

  it('the write-ahead claim comes FIRST, then the gate, then the attempt loop', () => {
    /* Both orderings matter and the first cut of this law pinned only one.
       gate < loop is what stops the RPC. claim < gate is what stops the
       jackpot being LOST: deferring before the intent is on disk would leave
       a hit that was detected, announced to the table, and recorded nowhere -
       the exact defect the queue was built for. */
    const code = strip(payout);
    const claim = code.indexOf("bbjPayoutQueue!.claim(params, 'write-ahead:");
    const gate = code.indexOf('if (isMaintenanceFrozen()) {');
    const loop = code.indexOf('for (let attempt = 1; attempt <= BBJ_PAYOUT_ATTEMPTS; attempt++)');
    expect(claim, 'the write-ahead claim must exist').toBeGreaterThan(-1);
    expect(gate).toBeGreaterThan(-1);
    expect(loop).toBeGreaterThan(-1);
    expect(claim).toBeLessThan(gate);
    expect(gate).toBeLessThan(loop);
  });

  it('a deferral that could not be recorded is loud', () => {
    /* The one way this gate could lose a jackpot: the durable write fails
       while the flag is set - Postgres unreachable, which is the outage shape
       the queue exists for. The first cut called `claim` and threw the answer
       away, making this the only `queued` return in the module that could
       leave nothing behind. */
    const code = strip(payout);
    const block = code.slice(
      code.indexOf('if (isMaintenanceFrozen()) {'),
      code.indexOf('for (let attempt = 1; attempt <= BBJ_PAYOUT_ATTEMPTS; attempt++)')
    );
    expect(block).toMatch(/const deferralRecorded =/);
    expect(block).toMatch(/if \(!deferralRecorded\)/);
    // and the alarm carries the whole parameter set, like the exhausted path
    expect(block).toMatch(
      /raiseFinancialAlert\(\s*'critical',\s*'processBBJPayout\.frozen_without_a_claim'/
    );
    expect(block).toMatch(/\.\.\.params,/);
  });

  it('it defers rather than failing: queued, with the claim still written', () => {
    const code = strip(payout);
    const block = code.slice(
      code.indexOf('if (isMaintenanceFrozen()) {'),
      code.indexOf('for (let attempt = 1; attempt <= BBJ_PAYOUT_ATTEMPTS; attempt++)')
    );
    /* The durable record is not a chip movement, so it is still written - and
       written with the DEFERRAL's reason, which refreshes the open row's note
       from "not yet attempted" to "deferred for the break". An operator
       reading the queue during a break should see why a jackpot is sitting
       there rather than a stale note that makes it look stuck. */
    expect(block).toMatch(/bbjPayoutQueue!\.claim\(params, `deferred: \$\{reason\}`\)/);
    expect(block).toMatch(/return \{ status: 'queued'/);
    /* An ORDINARY break raises nothing: the alert is reachable only through
       `if (!deferralRecorded)`, so it cannot fire on a break whose queue write
       landed. An alarm that fires every hour is one that gets muted (10.84). */
    expect(block).toMatch(/if \(!deferralRecorded\)[\s\S]*?raiseFinancialAlert/);
  });

  it('the reconciler defers EVERY kind, not just the jackpot', () => {
    const code = strip(reconciler);
    expect(code).toMatch(
      /import \{ isMaintenanceFrozen \} from '\.\.\/maintenance\/freezeState\.js';/
    );
    /* The first cut gated only `row.kind === 'bbj_payout'`, which left the
       rake branch calling atomic_distribute_rake and the fall-through calling
       logBBJCollection straight through the break - two thirds of the money
       still moving, inside a check whose whole purpose is that a caller which
       forgets to gate the cycle cannot slip money past it. */
    expect(code).not.toMatch(/row\.kind === 'bbj_payout' && isMaintenanceFrozen\(\)/);
    const loop = code.slice(code.indexOf('for (const row of rows) {'));
    const gate = loop.indexOf('if (isMaintenanceFrozen()) {');
    expect(gate).toBeGreaterThan(-1);
    /* FIRST in the body, so a deferred row costs no reads either. Since
       2026-09-22 the loop completes jackpot claims only (the rake and BBJ drop
       are the hand's own envelope), so the reads and money moves it must come
       before are the kind check, the live seat read and the payout itself -
       each asserted to exist, so a missing anchor cannot pass as -1. */
    for (const anchor of [
      "row.kind !== 'bbj_payout'",
      ".from('table_seats')",
      'processBBJPayout(',
      ".from('pending_fee_distributions')",
    ]) {
      expect(loop.indexOf(anchor), anchor).toBeGreaterThan(-1);
      expect(gate, anchor).toBeLessThan(loop.indexOf(anchor));
    }
    expect(loop.slice(gate)).toMatch(
      /if \(isMaintenanceFrozen\(\)\) \{\s+summary\.deferredFrozen\+\+;\s+continue;\s+\}/
    );
    /* deferred is its own outcome: folding it into resolved or stillFailing
       would be a signal answering when it deliberately did not look (10.86) */
    expect(code).toMatch(/deferredFrozen: number;/);
  });
});
