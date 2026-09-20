/**
 * THE DIAMOND ARENA RECONCILES, AND NOTHING SWEEPS IT.
 *
 * THE DIAMOND ARENA IS DIAMONDS ONLY. NO CHIPS, EVER. (Dan, 2026-09-13.)
 *
 * Conservation across a Diamond Arena session lives in the live paths, each
 * one transaction: fn_poker_diamond_buyin (journal + custody + movement +
 * lot reservation together), the top-up (same shape), and
 * fn_poker_diamond_release, which refuses an active cash seat until the seat
 * has left with stack = custody.balance and then credits, moves and releases
 * together, replaying its receipt on a repeated request. The old recovery
 * function is gone.
 *
 * This law keeps it that way and keeps the statement honest:
 *  1. the release path stays settlement-gated and atomic (pinned on the
 *     migration text that defines it);
 *  2. no migration re-introduces a recover / repair / sweep for custody
 *     (CLAUDE.md 10.12: a repair job is not allowed to exist as a fix);
 *  3. fn_diamond_arena_reconciliation is READ ONLY - it reports, it never
 *     writes - and is own-user only;
 *  4. the wallet shows the statement and never prints a balance it did not
 *     read.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

const read = (p: string) => readFileSync(resolve(process.cwd(), p), 'utf8');
const MIG = resolve(process.cwd(), 'supabase/migrations');
const migrations = () =>
  readdirSync(MIG)
    .filter((f) => f.endsWith('.sql'))
    .sort();

describe('the Diamond Arena reconciles', () => {
  it('the release path is settlement-gated and atomic, in the migration that defines it', () => {
    const custody = read('supabase/migrations/20260909065458_poker_diamond_custody.sql');
    // Credit and custody release in the same function body...
    expect(custody).toContain("'poker-release:'||p_custody_id||':'||p_request_id");
    expect(custody).toMatch(/state\s*=\s*'released'/);
    // ...and the movement table cannot hold a reserve without its journal row.
    expect(custody).toMatch(/action IN \('reserve', 'release'\)/);
    // The settlement gate: an active cash seat releases only after the seat
    // has left and its stack equals the custody balance.
    const gates = migrations().filter((f) => {
      const src = readFileSync(resolve(MIG, f), 'utf8');
      return (
        src.includes('diamond_custody_requires_settlement') && src.includes('s.stack=v_c.balance')
      );
    });
    expect(gates.length).toBeGreaterThan(0);
  });

  it('no migration defines a custody recover, repair, sweep or backfill after the recovery was retired', () => {
    const offenders: string[] = [];
    for (const f of migrations()) {
      const src = readFileSync(resolve(MIG, f), 'utf8');
      const defs =
        src.match(
          /CREATE (?:OR REPLACE )?FUNCTION public\.(fn_poker_diamond_(?:recover|repair|sweep|backfill|heal|catchup)[a-z_]*)/g
        ) || [];
      for (const d of defs) {
        // A later DROP in the same or a later file retires it; anything still
        // defined last is an offender.
        const name = d.replace(/.*public\./, '');
        const dropped = migrations()
          .filter((g) => g >= f)
          .some(
            (g) =>
              readFileSync(resolve(MIG, g), 'utf8').includes(
                `DROP FUNCTION IF EXISTS public.${name}`
              ) || readFileSync(resolve(MIG, g), 'utf8').includes(`DROP FUNCTION public.${name}`)
          );
        if (!dropped) offenders.push(`${f}: ${name}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('the reconciliation read never writes, and is own-user only', () => {
    const mig = read('supabase/migrations/20260914103736_the_diamond_arena_reconciles.sql');
    const body = mig.slice(
      mig.indexOf('CREATE OR REPLACE FUNCTION public.fn_diamond_arena_reconciliation'),
      mig.indexOf('COMMENT ON FUNCTION public.fn_diamond_arena_reconciliation')
    );
    expect(body).toContain('STABLE');
    expect(body).not.toMatch(/\b(INSERT|UPDATE|DELETE|TRUNCATE)\b/);
    expect(body).toContain("RAISE EXCEPTION 'arena_reconciliation_is_own_only'");
    expect(body).not.toMatch(/chip_ledger|club_members|chip_balance/);
    // Every reason the read can name has a player sentence.
    const component = read('src/components/wallet/arenaStatementCopy.ts');
    for (const reason of [
      'journal_missing',
      'reserve_amount_mismatch',
      'release_amount_mismatch',
      'release_movement_missing',
      'seat_stack_drift',
    ]) {
      expect(body).toContain(`'${reason}'`);
      expect(component).toContain(`${reason}:`);
    }
  });

  it('the wallet shows the statement on the Ledger tab and never a balance it did not read', () => {
    const page = read('src/pages/PlayerWalletPage.tsx');
    const component = read('src/components/wallet/DiamondArenaStatement.tsx');
    const service = read('src/services/DiamondService.ts');
    expect(page).toContain('<DiamondArenaStatement userId={user.id} />');
    expect(page).toContain('Diamond Arena Statement');
    expect(component).toContain('useState<Statement | null | undefined>(undefined)');
    expect(component).toContain('Your Diamond Arena Statement Could Not Be Read.');
    expect(service).toContain("supabase.rpc('fn_diamond_arena_reconciliation')");
    expect(service).toContain('did not say whether it balanced');
    // Diamonds only: the rendered code carries no chip (the header quotes the rule).
    const code = component.slice(component.indexOf('import {'));
    expect(code).not.toMatch(/chip/i);
  });
});
