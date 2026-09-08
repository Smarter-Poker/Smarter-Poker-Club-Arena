/**
 * LAW: A RESET RECORDS WHAT IT IS ABOUT TO DESTROY, BEFORE IT DESTROYS IT.
 *
 * Roadmap 9.8 step 1. `docs/CHIP-EPOCH-RESET-CONTRACT.md` was written on
 * 2026-09-08 assuming nothing was built. Reading production found that
 * `fn_ca_execute_epoch3_reset` already existed - and that it had exactly the
 * gap the contract calls the one that cannot be added afterwards:
 *
 *   It retires the horse tournament mint by draining each user's club balances
 *   largest-first, retires the frozen wallets pool, closes the epoch, and only
 *   THEN calls fn_ca_supply_snapshot(). The snapshot is taken after everything
 *   is zeroed. Nothing recorded what any account held the moment before, so the
 *   closing epoch could never be audited and no restore could ever be written.
 *
 * It also had no freeze check and no seated check, so it could run mid-hand.
 *
 * Measured in a rolled-back probe on 2026-09-08: the position covers **2,860
 * accounts and 925,662,528.55 chips** across twelve classes.
 *
 * Every pin below is one of those three gaps, or the property that keeps the
 * record trustworthy. Do not weaken one to make a change pass.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(__dirname, '..');
const MIGRATIONS = join(ROOT, 'supabase', 'migrations');

const closingMigration = (): string => {
  const f = readdirSync(MIGRATIONS).find((n) => n.includes('the_closing_position_is_recorded'));
  if (!f) throw new Error('the closing-position migration is missing from the repo');
  return readFileSync(join(MIGRATIONS, f), 'utf8');
};

const SQL = closingMigration();
// Comments explain the bug that was closed; they must not satisfy a pin about
// the code, nor defeat one asserting a shape is absent.
const CODE = SQL.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*--.*$/gm, '');

describe('the closing position is its own record', () => {
  it('has a dedicated table, not a rolling operational one', () => {
    // ca_account_snapshots churns and is read by the replay. A record a
    // dispute is settled from six months later cannot share a table with it.
    expect(CODE).toMatch(/CREATE TABLE IF NOT EXISTS public\.ca_epoch_closing_positions/);
  });

  it('is append-only under the same guard as the other journals', () => {
    expect(CODE).toMatch(
      /CREATE TRIGGER trg_ca_append_only[\s\S]{0,200}ca_epoch_closing_positions[\s\S]{0,200}fn_ca_journal_append_only/
    );
  });

  it('obeys the chip unit', () => {
    // Phase 9.1 - a chip is two decimal places, on new tables too.
    expect(CODE).toMatch(/chk_balance_is_two_decimal_places/);
    expect(CODE).toMatch(/balance = round\(balance, 2\)/);
  });

  it('is service-role only, both by grant and by RLS', () => {
    expect(CODE).toMatch(/ENABLE ROW LEVEL SECURITY/);
    expect(CODE).toMatch(/ca_epoch_closing_positions_service_only/);
    expect(CODE).toMatch(
      /GRANT EXECUTE ON FUNCTION public\.fn_ca_capture_closing_position\(text, boolean\) TO service_role/
    );
  });
});

describe('the capture covers what the supply meter counts', () => {
  const CLASSES: [string, string][] = [
    ['player_wallet', 'club_members.chip_balance'],
    ['member_promo', 'club_members.promo_balance'],
    ['table_stack', 'table_seats.stack'],
    ['club_treasury', 'clubs.chip_treasury'],
    ['club_pool', 'clubs.chip_pool'],
    ['club_promo', 'clubs.promo_balance'],
    ['club_insurance', 'clubs.insurance_balance'],
    ['club_wallet', 'club_wallets.chip_balance'],
    ['agent_wallet', 'agents.agent_wallet_balance'],
    ['agent_promo', 'agents.promo_wallet_balance'],
    ['spin_reserve', 'spin_bonus_pools.balance'],
    ['frozen_wallet_pool', 'wallets.balance'],
  ];

  it.each(CLASSES)('captures %s from %s', (cls, col) => {
    expect(CODE).toContain(`'${cls}'`);
    expect(CODE).toContain(col);
  });

  it('names each union wallet column rather than a total', () => {
    // A total hides which bank moved, and a restore needs the column.
    for (const col of [
      'chip_balance',
      'rake_wallet',
      'bbj_wallet',
      'promo_wallet',
      'insurance_wallet',
      'spin_reserve_wallet',
    ]) {
      expect(CODE).toContain(`'${col}'`);
    }
  });

  it('names each BBJ bank rather than a total', () => {
    for (const col of ['main_balance', 'backup_balance', 'promo_balance']) {
      expect(CODE).toContain(`'${col}'`);
    }
  });

  it('captures the agent player wallet the meter does not count', () => {
    // Outside the circulating identity, but the reset would still destroy it,
    // and a position that omits a balance somebody holds is not a position.
    expect(CODE).toContain("'agent_player_wallet'");
    expect(CODE).toContain('agents.player_wallet_balance');
  });

  it('takes only the cash felt - tournament stacks belong to the escrow', () => {
    expect(CODE).toMatch(/tournament_id IS NOT NULL/);
  });

  it('refuses to record an empty position', () => {
    expect(CODE).toMatch(/found no accounts at all/);
  });
});

describe('a real capture only happens with play stopped', () => {
  it('refuses unless the platform is frozen', () => {
    expect(CODE).toMatch(/NOT p_dry_run AND NOT public\.fn_platform_frozen\(\)/);
  });

  it('still allows a dry run at any time, so it can be rehearsed', () => {
    expect(CODE).toMatch(/p_dry_run boolean DEFAULT true/);
    expect(CODE).toMatch(/'dry_run', true, 'written', false/);
  });
});

describe('the reset refuses without one', () => {
  it('refuses when the platform is not frozen', () => {
    expect(SQL).toMatch(/epoch reset refused: the platform is not frozen/);
  });

  it('refuses while any seat is still occupied', () => {
    // Parked is not empty: a stack zeroed under a seated player is a balance
    // that no longer matches what that player can see.
    expect(SQL).toMatch(/seat\(s\) are still occupied/);
    expect(SQL).toMatch(/FROM public\.table_seats WHERE left_at IS NULL/);
  });

  it('refuses without a closing position captured in the last fifteen minutes', () => {
    expect(SQL).toMatch(/no closing position captured for the current epoch/);
    expect(SQL).toMatch(/interval ''15 minutes''/);
  });

  it('applies the gate as an asserted substitution, not a retyped body', () => {
    // The reset is money code; retyping ~90 lines to insert eight is how an
    // unrelated line goes missing.
    expect(SQL).toMatch(/pg_get_functiondef/);
    expect(SQL).toMatch(/found % - the function has changed and this gate must be re-read/);
    expect(SQL).toMatch(/reset gate already applied; skipping/);
  });

  it('leaves the dry run able to report without any of it', () => {
    // p_dry_run must still answer "what would this do", freeze or no freeze.
    expect(SQL).toMatch(/IF NOT p_dry_run THEN/);
  });
});

describe('the contract it implements is still in the repo', () => {
  it('the epoch reset contract names the closing position as step 1', () => {
    const c = readFileSync(join(ROOT, 'docs', 'CHIP-EPOCH-RESET-CONTRACT.md'), 'utf8');
    expect(c).toMatch(/BEFORE anything is zeroed/);
    expect(c).toMatch(/One migration can put every balance back/);
  });
});
