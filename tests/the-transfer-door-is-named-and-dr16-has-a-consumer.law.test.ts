/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  LAW - THE TRANSFER DOOR IS NAMED, AND DR16 HAS A CONSUMER
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Two findings fn_ca_diamond_unreachable_money() had reported since it was
 * written, both read against the live catalog on 2026-09-19 and both true:
 *
 *   A. send_wallet_diamond_transfer, the one authenticated player-to-player
 *      transfer door (ruling 4, amended 2026-09-08), was not named in
 *      fn_guard_profile_privileged_columns, so its first wallet UPDATE answered
 *      42501 and rolled back. diamond_wallet_transfers held zero rows, ever.
 *      Phase 4 was "verified" on a fixture that carried no profile guard.
 *
 *   B. DR16:deposit_inside_settlement_window had no consumer. The deposit door
 *      that replaced its original consumer, fn_poker_diamond_reserve, already
 *      refuses an unsettled lot by another name; it now reads the rule's mode
 *      so the rule has a consumer and a flip means something. The refusal
 *      stands in both modes: an unsettled lot admitted "in log mode" would sit
 *      in custody with nothing for a chargeback to find.
 *
 * The migration is read with its comments stripped.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

const MIGRATIONS = resolve(__dirname, '..', 'supabase', 'migrations');

const file = readdirSync(MIGRATIONS)
  .filter((n) => n.endsWith('_the_transfer_door_is_named_and_dr16_has_a_consumer.sql'))
  .sort()
  .at(-1);
if (!file) throw new Error('the transfer door migration is missing');

const executable = readFileSync(join(MIGRATIONS, file), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, ' ')
  .replace(/--[^\n]*/g, ' ');

describe('LAW: the transfer door is named, and DR16 has a consumer', () => {
  it('admits the transfer route to the profile guard by marker against the live body', () => {
    expect(executable).toContain("send_wallet_diamond_transfer[(]'");
    // The route the guard admits is the reviewed one: md5 pinned, live session
    // required, both legs journaled, authenticated only.
    expect(executable).toContain("md5(v_route) <> '8d5b95d8ad2a74c1ba85339168349606'");
    expect(executable).toContain("position('fn_caller_session_is_live()' in v_route) = 0");
    expect(executable).toContain("'''diamond_gift_sent'''");
    expect(executable).toContain("'''diamond_gift_received'''");
    expect(executable).toMatch(
      /has_function_privilege\('anon', 'public\.send_wallet_diamond_transfer/
    );
    // The guard body is pinned too, and the substitution is proved reversible.
    expect(executable).toContain("md5(v_before) <> '43896e9aebd9df49151a0e92799f9598'");
    expect(executable).toContain('replace(v_after, v_new, v_old) IS DISTINCT FROM v_before');
  });

  it('the deposit door consults DR16 by its literal name and refuses in both modes', () => {
    expect(executable).toContain(
      "fn_ca_diamond_rule_mode('DR16:deposit_inside_settlement_window')='refuse'"
    );
    // Armed: the refusal carries the rule's own code and the numbers.
    expect(executable).toContain("USING ERRCODE='P0416'");
    expect(executable).toContain('DR16:deposit_inside_settlement_window refused');
    // The leading token the engine and the client match on does not change,
    // and it is raised in both branches.
    const raises = executable.match(/RAISE EXCEPTION 'insufficient_settled_diamonds'/g) ?? [];
    expect(raises.length).toBeGreaterThanOrEqual(2);
    // Attributed to DR16 only when it IS the window that refuses.
    expect(executable).toContain('v_locked>0 AND v_wallet IS NOT NULL AND v_wallet>=p_amount');
    // The reserve body is pinned and every other refusal is still there.
    expect(executable).toContain("md5(v_before) <> 'a1ccc4bc9a5c6d8d17308e93943a9413'");
    for (const refusal of [
      'diamond_debt_requires_settlement',
      'diamond_tournaments_not_open',
      'invalid_diamond_table_buy_in',
      'diamond_asset_required',
    ]) {
      expect(executable).toContain(refusal);
    }
  });

  it('declares both watched redefinitions and reads the detector before committing', () => {
    expect(executable).toContain(
      "fn_ca_declare_guard_redefinition('fn_guard_profile_privileged_columns'"
    );
    expect(executable).toContain("fn_ca_declare_guard_redefinition('fn_poker_diamond_reserve'");
    expect(executable).toContain('FROM public.fn_ca_diamond_unreachable_money()');
    expect(executable).toContain("v_row.object LIKE 'send_wallet_diamond_transfer(%'");
    expect(executable).toContain("v_row.object = 'DR16:deposit_inside_settlement_window'");
    // Grants are never widened.
    expect(executable).not.toMatch(/GRANT EXECUTE[^;]*TO (anon|authenticated)/);
  });
});
