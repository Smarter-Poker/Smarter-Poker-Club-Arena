/**
 * LAW: A SEND FROM THE UNION PROMO WALLET LANDS IN A PROMO WALLET. NOWHERE ELSE.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * 2026-09-05 02:51 UTC. Dan opened the Midway Union PROMO WALLET, picked Club
 * JAQK, then SHARK CLUB, and sent 5,000 to each. UnionWalletModal called
 * `unionApi.sendToClub` for every club target regardless of which wallet was
 * open, and that RPC (fn_union_send_to_club_atomic) knows one route: union
 * BANK -> club BANK. The union promo wallet did not move, the union bank lost
 * 10,000, each Club Bank gained 5,000 under the note "Promo Wallet to club",
 * and both club Promo Wallets read 0.00. Dan reported the chips missing.
 *
 * Three defects, one shape - a promo movement routed through a chip account:
 *   1. the modal ignored the open wallet and the picked kind for club targets;
 *   2. fn_union_promo_send (the RPC it SHOULD have called) credited
 *      clubs.chip_treasury, so it could never have filled a promo wallet;
 *   3. the club Promo Wallet cashier read and spent the CALLER'S agent float
 *      even for a club owner, while the row that opened it showed the CLUB'S
 *      pot - two accounts under one name.
 *
 * Dan's ruling (docs/LAWS.md, Resolved conflicts, 2026-09-05): union promo to
 * a club lands in the club's PROMO WALLET. Club staff hand it out from there.
 * Every promo wallet carries a ledger.
 *
 * Money moved through the wrong route on 2026-09-05 was rerouted in
 * 20260905030103_union_promo_lands_in_the_club_promo_wallet.sql. This law is
 * what stops it needing a third correction.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  clubSendRoute,
  clubPullRoute,
  UNION_WALLET_COLUMN,
} from '../src/components/union/unionWalletRoutes';
import {
  cashierTabs,
  cashierRefusesSelfSend,
  promoSourceFor,
  promoSendRpc,
  promoLedgerScope,
} from '../src/components/wallet/cashierModes';

const ROOT = resolve(__dirname, '..');
const read = (p: string) => readFileSync(resolve(ROOT, p), 'utf8');
const stripComments = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');

const MIG_DIR = resolve(ROOT, 'supabase/migrations');
function migration(fragment: string): string {
  const f = readdirSync(MIG_DIR)
    .filter((x) => x.includes(fragment))
    .sort()
    .pop();
  expect(f, `the migration containing "${fragment}" is missing`).toBeTruthy();
  return readFileSync(resolve(MIG_DIR, f as string), 'utf8');
}
function fnBody(sql: string, name: string): string {
  const open = sql.indexOf(`CREATE OR REPLACE FUNCTION public.${name}(`);
  expect(open, `${name} has moved or gone`).toBeGreaterThan(-1);
  const start = sql.indexOf('$function$', open);
  const end = sql.indexOf('$function$', start + 10);
  expect(end).toBeGreaterThan(start);
  return sql.slice(start, end);
}

const unionModal = stripComments(read('src/components/union/UnionWalletModal.tsx'));
const cashier = stripComments(read('src/components/wallet/WalletCashierModal.tsx'));
const LANDING = migration('union_promo_lands_in_the_club_promo_wallet');

describe('the union modal routes a club send by the wallet that is open', () => {
  it('promo wallet -> the club Promo Wallet, whatever kind is picked', () => {
    expect(clubSendRoute('promo', 'promo')).toEqual({ kind: 'promo' });
    expect(clubSendRoute('promo', 'chips')).toEqual({ kind: 'promo' });
  });

  it('the Promo kind from the union bank -> the club Promo Wallet too', () => {
    expect(clubSendRoute('chips', 'promo')).toEqual({ kind: 'promo' });
  });

  it('union bank (and BBJ, which draws on it) with Chips -> the Club Bank', () => {
    expect(clubSendRoute('chips', 'chips')).toEqual({ kind: 'bank' });
    expect(clubSendRoute('bbj', 'chips')).toEqual({ kind: 'bank' });
  });

  it('the rake wallet has no club route and says so, never drawing on the bank in silence', () => {
    const r = clubSendRoute('rake', 'chips');
    expect(r.kind).toBe('refused');
    expect(r.kind === 'refused' && r.reason).toMatch(/Rake Treasury Is Held In Trust/);
  });

  it('diamonds never go to a club', () => {
    for (const w of ['chips', 'rake', 'bbj', 'promo'] as const) {
      expect(clubSendRoute(w, 'diamonds').kind).toBe('refused');
    }
  });

  it('the promo route calls unionApi.promoSend into the club, and the bank route sendToClub', () => {
    // Both calls exist, each under its own route. The 2026-09-05 bug was the
    // FIRST being absent and the second taken for every club.
    expect(unionModal).toMatch(
      /unionApi\.promoSend\(\s*unionId,\s*amt,\s*'club',\s*target\.data\.id/
    );
    expect(unionModal).toMatch(/unionApi\.sendToClub\(\s*unionId,\s*target\.data\.id,\s*amt/);
    const clubBranch = unionModal.slice(
      unionModal.indexOf('const r = clubSendRoute(walletKey, kind);'),
      unionModal.indexOf('Member Clawbacks Must Be Performed By The Club Owner')
    );
    expect(clubBranch).toContain("if (r.kind === 'refused') throw new Error(r.reason);");
    expect(clubBranch.indexOf('promoSend')).toBeLessThan(clubBranch.indexOf('sendToClub'));
    expect(clubBranch).toMatch(
      /if \(r\.kind === 'promo'\) \{[\s\S]*promoSend[\s\S]*\} else \{[\s\S]*sendToClub/
    );
  });

  it('a club row says where the chips will land before the send', () => {
    expect(unionModal).toContain("'Into The Club Promo Wallet'");
    expect(unionModal).toContain("'Into The Club Bank'");
    expect(unionModal).toContain("'CLUB PROMO WALLET'");
  });
});

describe('a pull comes back to the wallet that is open', () => {
  it('the promo wallet pulls from the club promo wallet; the bank from the club bank', () => {
    expect(clubPullRoute('promo')).toEqual({ kind: 'promo' });
    expect(clubPullRoute('chips')).toEqual({ kind: 'bank' });
    for (const w of ['rake', 'bbj', 'spin_reserve'] as const) {
      expect(clubPullRoute(w).kind).toBe('refused');
    }
  });

  it('the modal routes the pull and keys both calls on an op id', () => {
    expect(unionModal).toContain(
      "isPromoPull ? 'fn_union_clawback_promo_from_club' : 'fn_union_clawback_from_club'"
    );
    const pull = unionModal.slice(
      unionModal.indexOf('const pr = clubPullRoute(walletKey);'),
      unionModal.indexOf('if (onSent) onSent();')
    );
    expect(pull).toContain('p_op_id: opId');
    expect(pull).toContain("if (pr.kind === 'refused') throw new Error(pr.reason);");
    expect(pull).toMatch(/isPromoPull \? cb\.promo_after : cb\.union_balance/);
  });

  it('fn_union_clawback_promo_from_club is the inverse of the send, keyed and declared', () => {
    const PULL = migration('a_promo_pull_comes_back_from_the_club_promo_wallet');
    const b = fnBody(PULL, 'fn_union_clawback_promo_from_club');
    expect(b).toMatch(/SET promo_balance = COALESCE\(promo_balance, 0\) - v_amt/);
    expect(b).toMatch(/AND COALESCE\(promo_balance, 0\) >= v_amt/);
    expect(b).toMatch(/SET promo_wallet = COALESCE\(promo_wallet, 0\) \+ v_amt/);
    expect(b).not.toMatch(/chip_treasury/);
    expect(b).toMatch(/fn_ca_declare_ledger\('promo', 'union_wallet', p_union_id/);
    expect(b).toContain("'promo_wallet', 'credit', v_amt, v_after, 'promo_clawback', v_op");
    expect(b).toContain("'union_promo_clawback'");
    expect(b).toContain("'union lead access required'");
    expect(PULL).toMatch(
      /REVOKE ALL ON FUNCTION public\.fn_union_clawback_promo_from_club\([^)]*\) FROM PUBLIC, anon;/
    );
  });
});

describe('fn_union_promo_send lands in the club promo wallet', () => {
  const b = fnBody(LANDING, 'fn_union_promo_send');

  it('credits clubs.promo_balance on the club branch, and never chip_treasury', () => {
    const clubBranch = b.slice(
      b.indexOf("IF p_destination = 'club' THEN"),
      b.indexOf("-- destination = 'bbj_main'")
    );
    expect(clubBranch).toMatch(
      /UPDATE clubs SET promo_balance = COALESCE\(promo_balance, 0\) \+ v_amt/
    );
    expect(clubBranch).not.toMatch(/chip_treasury = COALESCE\(chip_treasury, 0\) \+/);
  });

  it('spends the union promo wallet, not the union bank', () => {
    expect(b).toMatch(/UPDATE union_wallets SET promo_wallet = promo_wallet - v_amt/);
    expect(b).not.toMatch(/chip_balance = chip_balance - v_amt/);
  });

  it('writes both sides of the book and one declared ledger row', () => {
    expect(b).toContain("'promo_wallet', 'debit', v_amt, v_after, 'promo_to_club'");
    expect(b).toContain("'union_promo_to_club'");
    expect(b).toMatch(/fn_ca_declare_ledger\('promo_send', 'union_wallet', p_union_id/);
  });

  it('is not an open door: a caller who cannot manage the union wallets is refused', () => {
    expect(b).toContain('fn_union_can_manage_wallets(p_union_id, auth.uid())');
  });
});

describe('the club Promo Wallet cashier stands at the right account', () => {
  it('a bank role stands at the club pot; an agent at their own float', () => {
    for (const r of ['owner', 'co_owner', 'admin', 'super_agent']) {
      expect(promoSourceFor(r)).toBe('club_pot');
    }
    for (const r of ['agent', 'sub_agent']) {
      expect(promoSourceFor(r)).toBe('own_float');
    }
  });

  it('each account is spent through its own RPC and read through its own ledger scope', () => {
    expect(promoSendRpc('club_pot')).toBe('fn_club_promo_wallet_send');
    expect(promoSendRpc('own_float')).toBe('fn_promo_wallet_send');
    expect(promoLedgerScope('club_pot')).toBe('club');
    expect(promoLedgerScope('own_float')).toBe('agent');
    expect(cashier).toContain('supabase.rpc(promoSendRpc(promoSource)');
  });

  it('the club pot may fund the owner own float; the own float still refuses a self-send', () => {
    expect(cashierRefusesSelfSend('promo_wallet', 'club_pot')).toBe(false);
    expect(cashierRefusesSelfSend('promo_wallet', 'own_float')).toBe(true);
    expect(cashierRefusesSelfSend('promo_wallet')).toBe(true);
  });

  it('reads BOTH accounts on open, so the switch never shows a fabricated balance', () => {
    expect(cashier).toMatch(/select\('id, name, union_id, chip_treasury, promo_balance'\)/);
    expect(cashier).toContain('setPromoPot(');
    expect(cashier).toContain('setPromoFloat(');
    expect(cashier).toMatch(/setBank\(promoSource === 'club_pot' \? promoPot : promoFloat\)/);
  });

  it('fn_club_promo_wallet_send spends the club pot into a player wallet or an agent float', () => {
    const b = fnBody(LANDING, 'fn_club_promo_wallet_send');
    expect(b).toMatch(/set promo_balance = coalesce\(promo_balance, 0\) - p_amount/);
    expect(b).toMatch(/set chip_balance = coalesce\(chip_balance, 0\) \+ p_amount/);
    expect(b).toMatch(/set promo_wallet_balance = coalesce\(promo_wallet_balance, 0\) \+ p_amount/);
    expect(b).toContain("'club_promo_send'");
    expect(b).toContain("v_actor_role not in ('owner', 'co_owner', 'admin', 'super_agent')");
  });
});

describe('every promo wallet carries a ledger', () => {
  it('the club promo cashier has a Transaction Ledger tab and no claim tab', () => {
    expect(cashierTabs('promo_wallet')).toEqual(['send', 'ledger']);
  });

  it('the cashier reads it from fn_promo_wallet_ledger, scoped to the account on screen', () => {
    expect(cashier).toMatch(
      /supabase\.rpc\('fn_promo_wallet_ledger', \{\s*p_scope: promoLedgerScope\(source\)/
    );
  });

  it('the union modal has a Ledger tab for every wallet it opens, on the same RPC', () => {
    expect(unionModal).toMatch(/supabase\.rpc\('fn_promo_wallet_ledger', \{\s*p_scope: 'union'/);
    expect(unionModal).toContain('p_wallet: UNION_WALLET_COLUMN[walletKey]');
    expect(UNION_WALLET_COLUMN.promo).toBe('promo_wallet');
    expect(UNION_WALLET_COLUMN.chips).toBe('chip_balance');
    expect(unionModal).toMatch(/\['send', 'pull', 'ledger'\] as Mode\[\]/);
  });

  it('fn_promo_wallet_ledger knows all three promo accounts', () => {
    // The definition production runs is the newest one (the verification
    // pass re-shaped it so a million-row rake wallet is not re-summed).
    const LEDGER = migration('the_union_ledger_totals_do_not_rescan_a_million_rake_rows');
    // ...and the body production runs is the one after it: a sweep has no actor.
    const CURRENT = migration('a_sweep_has_no_actor');
    expect(fnBody(CURRENT, 'fn_promo_wallet_ledger')).toContain(
      'case when t.created_by is null then null else'
    );
    const b = fnBody(LEDGER, 'fn_promo_wallet_ledger');
    expect(b).toContain("if p_scope = 'union' then");
    expect(b).toContain("if p_scope = 'club' then");
    expect(b).toContain("elsif p_scope = 'agent' then");
    expect(b).toContain('from union_wallet_transactions t');
    expect(b).toContain('from chip_ledger l');
    // the club scope is gated on the Club Bank roles; the agent scope on membership
    expect(b).toContain('fn_can_use_club_bank(p_scope_id)');
    // the rake wallet's totals ride the reconciliation checkpoint, and only
    // the first page pays for totals at all
    expect(b).toContain('from union_rake_ledger_checkpoint c');
    expect(b).toMatch(/if v_offset = 0 then/);
    expect(LEDGER).toContain("SET plan_cache_mode = 'force_custom_plan'");
    expect(LEDGER).toContain('idx_uwt_union_wallet_created');
    expect(LEDGER).toContain('idx_chip_ledger_promo_to');
  });

  it('a Load More page never wipes the totals the first page put on screen', () => {
    expect(unionModal).toMatch(/if \(offset === 0 \|\| res\.totals\) setLedgerTotals/);
    expect(cashier).toMatch(/if \(offset === 0 \|\| res\.totals\) setPromoLedgerTotals/);
  });
});

describe('the 2026-09-05 sends were rerouted, keyed on the originals', () => {
  it('names both original union transactions and refuses to run twice', () => {
    expect(LANDING).toContain('4a363124-0287-4a9e-bdfb-e697b0f32018');
    expect(LANDING).toContain('a458f05e-1dee-4942-8bd4-ead9616d0ec7');
    expect(LANDING).toMatch(/metadata ->> 'reroute_of' = r\.union_tx_id::text/);
    expect(LANDING).toContain("RAISE NOTICE 'reroute: % already corrected, skipping'");
  });

  it('asserts the books moved by exactly the amount, on both sides', () => {
    expect(LANDING).toContain('reroute: club % books did not move as expected');
    expect(LANDING).toContain('reroute: union books did not move as expected');
  });
});
