/**
 * THE HIERARCHY SENDS ARE ONE JOURNAL ROW EACH.
 *
 * Chip Accounting Standard Phase 2, lane 2.4 (audit round 2, lane 2, F3).
 * 2026-09-03.
 *
 * Every hierarchy send (club bank -> agent float / promo float / player
 * wallet, agent float -> player or downline float, agent float -> own seat,
 * promo float -> wallet, union clawback, staff pull, seven-day reversal)
 * writes two balance columns and journals nothing itself. The auto-ledger
 * triggers then wrote one single-leg `adjustment` row per column against
 * settlement_suspense, and fn_club_members_ledger_writer invented
 * `table_stack` as the player-side counterparty. Verified on production:
 * fn_agent_wallet_send 2026-09-01 14:23:18, 10,000.00 to a player, journaled
 * as `agent_wallet -> settlement_suspense` plus `table_stack ->
 * player_wallet`, no key, no correlation; suspense +182,131.56 in 23h.
 *
 * Two migrations, and the rules they pin:
 *
 *   1. the vocabulary learns club_bank_send, club_bank_claim, agent_send,
 *      agent_claim and union_settlement, re-added NOT VALID (no scan of the
 *      journal), and fn_club_members_ledger_writer stops inventing
 *      table_stack: an undeclared wallet write says settlement_suspense, where
 *      R9 sees it. Verified before the change: 57,361 trigger rows in 18h,
 *      zero relying on the default.
 *
 *   2. each of nine hierarchy RPCs calls fn_ca_declare_ledger before its
 *      first balance write, declares the counterparty on ONE side and
 *      autoskips the OTHER side's table, keys the row on the op and
 *      correlates on it; same-table legs (float -> float, promo -> promo) and
 *      the credit-line legs are posted through fn_ca_post_leg, which never
 *      blocks the money. Nothing else in any body moves: the migration's own
 *      self-check counts refusals and RAISEs against the live numbers.
 *
 * Rolled-back probes on production (docs/changelog/2026-09-03-chip-std-phase2-hierarchy.md)
 * showed exactly one row per movement, zero suspense rows, zero write
 * failures, balances restored.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'fs';
import { resolve } from 'path';

const DIR = resolve(__dirname, '..', 'supabase/migrations');
const files = readdirSync(DIR);
const VOCAB_FILE = files.find((f) => f.includes('the_hierarchy_has_words_for_its_sends'));
const RPC_FILE = files.find((f) => f.includes('the_hierarchy_sends_are_one_journal_row_each'));
const VOCAB = VOCAB_FILE ? readFileSync(resolve(DIR, VOCAB_FILE), 'utf8') : '';
const RPC = RPC_FILE ? readFileSync(resolve(DIR, RPC_FILE), 'utf8') : '';

/** One function body out of the RPC migration, bounded by its own dollar quotes. */
function body(fn: string): string {
  const open = RPC.indexOf(`CREATE OR REPLACE FUNCTION public.${fn}(`);
  expect(open, `${fn} has moved or gone`).toBeGreaterThan(-1);
  const start = RPC.indexOf('$function$', open);
  const end = RPC.indexOf('$function$', start + 10);
  expect(end, `${fn} is not dollar-quoted as expected`).toBeGreaterThan(start);
  return RPC.slice(start, end);
}

function count(hay: string, needle: string | RegExp): number {
  if (typeof needle === 'string') return hay.split(needle).length - 1;
  return (hay.match(needle) ?? []).length;
}

const NEW_WORDS = [
  'club_bank_send',
  'club_bank_claim',
  'agent_send',
  'agent_claim',
  'union_settlement',
];

describe('the vocabulary and the honest default (migration 1)', () => {
  it('ships as a migration at all', () => {
    expect(VOCAB_FILE, 'the vocabulary migration is missing').toBeTruthy();
  });

  it('adds exactly the five hierarchy words, NOT VALID, without dropping a word', () => {
    const start = VOCAB.indexOf('ADD CONSTRAINT chip_ledger_category_check');
    const end = VOCAB.indexOf('NOT VALID', start);
    expect(start).toBeGreaterThan(-1);
    expect(end, 'the re-added CHECK must be NOT VALID - no scan of the journal').toBeGreaterThan(
      start
    );
    const list = VOCAB.slice(start, end);
    for (const w of NEW_WORDS) expect(list).toContain(`'${w}'::text`);
    // words the rest of the estate already declares must survive the re-add
    for (const w of [
      'buyin',
      'table_cashout',
      'tournament_buyin',
      'tournament_prize',
      'rake',
      'commission',
      'rakeback',
      'promo_send',
      'credit_draw',
      'credit_repayment',
      'reversal',
      'adjustment',
      'leaderboard_payout',
      'club_opening_allocation',
      'union_send',
      'pnl_settlement',
      'horse_funding',
      'spin_prize',
      'overlay',
    ]) {
      expect(list, `${w} fell out of chip_ledger_category_check`).toContain(`'${w}'::text`);
    }
  });

  it('never invents table_stack for an undeclared club_members write again', () => {
    const open = VOCAB.indexOf('CREATE OR REPLACE FUNCTION public.fn_club_members_ledger_writer()');
    expect(open).toBeGreaterThan(-1);
    const start = VOCAB.indexOf('$function$', open);
    const end = VOCAB.indexOf('$function$', start + 10);
    const writer = VOCAB.slice(start, end);
    expect(writer).not.toContain("'table_stack'");
    expect(writer).toContain(
      "cp := COALESCE(NULLIF(current_setting('app.ledger_counterparty', true), ''), 'settlement_suspense');"
    );
    // the contract every balance trigger carries: swallow, never refuse
    expect(writer).toContain('ca_ledger_write_failures');
    expect(writer).not.toMatch(/RAISE\s+EXCEPTION/i);
    expect(VOCAB.slice(open, start)).toMatch(/SECURITY DEFINER/);
  });

  it('self-checks the live constraint and the live writer', () => {
    expect(VOCAB).toMatch(/RAISE EXCEPTION 'chip_ledger_category_check lacks %'/);
    expect(VOCAB).toMatch(
      /RAISE EXCEPTION 'fn_club_members_ledger_writer still invents table_stack'/
    );
  });

  it('carries no em dash', () => {
    expect(VOCAB).not.toContain('\u2014');
  });
});

/**
 * fn -> [category, counterparty, entity expression, autoskip table, key prefix]
 * The counterparty is declared on the side whose trigger is skipped; the other
 * side's trigger writes the row with it.
 */
const DECLARATIONS: Array<[string, string, string, string, string, string]> = [
  ['fn_club_bank_send', 'club_bank_send', 'club_treasury', 'p_club_id', 'clubs', 'club_bank_send:'],
  [
    'fn_club_bank_claim_back',
    'club_bank_claim',
    'club_treasury',
    'p_club_id',
    'clubs',
    'club_bank_claim:',
  ],
  [
    'fn_club_bank_reverse',
    'reversal',
    'club_treasury',
    'v_tx.club_id',
    'clubs',
    'club_bank_reversal:',
  ],
  [
    'fn_admin_remove_player_chips',
    'club_bank_claim',
    'club_treasury',
    'p_club_id',
    'clubs',
    'admin_removal:',
  ],
  [
    'fn_agent_wallet_send_core_20260830',
    'agent_send',
    'agent_wallet',
    'v_actor',
    'agents',
    'agent_send:',
  ],
  [
    'fn_agent_wallet_claim_back_phase2_core_20260831',
    'agent_claim',
    'agent_wallet',
    'v_actor',
    'agents',
    'agent_claim:',
  ],
  [
    'fn_agent_wallet_self_stake',
    'agent_send',
    'agent_wallet',
    'v_actor',
    'agents',
    'agent_self_stake:',
  ],
  ['fn_promo_wallet_send', 'promo_send', 'promo_wallet', 'v_actor', 'agents', 'promo_send:'],
  [
    'fn_union_clawback_from_club',
    'union_settlement',
    'union_bank',
    'p_union_id',
    'union_wallets',
    'union_clawback:',
  ],
];

describe('every hierarchy door declares one row (migration 2)', () => {
  it('ships as a migration at all', () => {
    expect(RPC_FILE, 'the RPC migration is missing').toBeTruthy();
  });

  it.each(DECLARATIONS)(
    '%s declares %s vs %s and skips the other side',
    (fn, cat, cp, entity, skip, key) => {
      const b = body(fn);
      const declare = new RegExp(
        `fn_ca_declare_ledger\\('${cat}', '${cp}', ${entity.replace('.', '\\.')}, null,`,
        'i'
      );
      expect(b, `${fn} does not declare ${cat} vs ${cp}`).toMatch(declare);
      expect(b, `${fn} does not autoskip ${skip}`).toMatch(new RegExp(`array\\['${skip}'\\]`, 'i'));
      expect(b, `${fn} does not key the row on the op`).toContain(`'${key}' ||`);
      expect(b, `${fn} does not correlate on the op`).toContain(
        "set_config('app.ledger_correlation'"
      );
      // the skip is cleared after the write it covers, so nothing later in the
      // transaction is silently unjournaled
      expect(b, `${fn} never clears its autoskip`).toMatch(
        new RegExp(`set_config\\('app\\.ledger_autoskip_${skip}', '', true\\)`, 'i')
      );
      // the declaration comes BEFORE the first balance write
      const declAt = b.search(declare);
      const firstWrite = b.search(
        /\n\s*update\s+(public\.)?(clubs|agents|club_members|union_wallets)\b/i
      );
      expect(firstWrite, `${fn} has no balance write`).toBeGreaterThan(-1);
      expect(declAt, `${fn} declares after its first balance write`).toBeLessThan(firstWrite);
    }
  );

  it('declares through the primitive, never by hand-setting the category GUC', () => {
    for (const [fn] of DECLARATIONS) {
      expect(body(fn)).not.toContain("set_config('app.ledger_category'");
      expect(body(fn)).not.toContain("set_config('app.ledger_counterparty'");
    }
  });

  it('posts the same-table legs explicitly: float -> float, promo -> promo', () => {
    expect(body('fn_agent_wallet_send_core_20260830')).toContain(
      "fn_ca_post_leg('agent_send', 'agent_wallet', v_actor, 'agent_wallet', p_to_user_id,"
    );
    expect(body('fn_agent_wallet_claim_back_phase2_core_20260831')).toContain(
      "fn_ca_post_leg('agent_claim', 'agent_wallet', v_src.to_user_id, 'agent_wallet', v_actor,"
    );
    expect(body('fn_promo_wallet_send')).toContain(
      "fn_ca_post_leg('promo_send', 'promo_wallet', v_actor, 'promo_wallet', p_to_user_id,"
    );
    // and the consumed-once key GUC is cleared before the explicit row so it
    // cannot leak onto a later insert in the same transaction
    for (const fn of [
      'fn_agent_wallet_send_core_20260830',
      'fn_agent_wallet_claim_back_phase2_core_20260831',
      'fn_promo_wallet_send',
    ]) {
      expect(body(fn)).toContain("set_config('app.ledger_idempotency_key', '', true)");
    }
  });

  it('journals the credit line as its own legs, only for the shortfall and only for the repayment', () => {
    const send = body('fn_agent_wallet_send_core_20260830');
    expect(send).toMatch(
      /if v_shortfall > 0 then\s*\n\s*perform public\.fn_ca_post_leg\('credit_draw', 'credit_facility', v_actor, 'agent_wallet', v_actor,\s*\n\s*v_shortfall,/
    );
    const claim = body('fn_agent_wallet_claim_back_phase2_core_20260831');
    expect(claim).toMatch(
      /if v_repay > 0 then\s*\n\s*perform public\.fn_ca_post_leg\('credit_repayment', 'agent_wallet', v_actor, 'credit_facility', v_actor,\s*\n\s*v_repay,/
    );
  });

  it('changes no auth check, limit, window or credit rule (the refusals are all still there)', () => {
    // the live counts on 2026-09-03 before the change; the migration's own
    // DO block asserts the same numbers against production after apply
    const expected: Record<string, [number, number]> = {
      fn_club_bank_send: [13, 1],
      fn_club_bank_claim_back: [11, 1],
      fn_club_bank_reverse: [8, 0],
      fn_admin_remove_player_chips: [6, 0],
      fn_agent_wallet_send_core_20260830: [14, 1],
      fn_agent_wallet_claim_back_phase2_core_20260831: [14, 1],
      fn_agent_wallet_self_stake: [8, 1],
      fn_promo_wallet_send: [13, 1],
      fn_union_clawback_from_club: [6, 0],
    };
    for (const [fn, [refusals, raises]] of Object.entries(expected)) {
      const b = body(fn);
      expect(count(b, /'success',\s*false/gi), `${fn} refusal count`).toBe(refusals);
      expect(count(b, /raise exception/gi), `${fn} RAISE count`).toBe(raises);
    }
    expect(body('fn_agent_wallet_send_core_20260830')).toContain("interval '10 minutes'");
    expect(body('fn_agent_wallet_claim_back_phase2_core_20260831')).toContain(
      'The Ten Minute Window To Claim These Chips Back Has Closed'
    );
    expect(body('fn_club_bank_reverse')).toContain('Seven Day Reversal Window');
    expect(body('fn_club_bank_send')).toContain("interval '7 days'");
    expect(body('fn_agent_wallet_send_core_20260830')).toContain(
      'v_headroom := v_credit_limit - v_credit_used;'
    );
    // the single-send ceiling on every door that had one (the reversal, the
    // staff pull and the clawback never carried it; they still do not)
    for (const fn of [
      'fn_club_bank_send',
      'fn_club_bank_claim_back',
      'fn_agent_wallet_send_core_20260830',
      'fn_agent_wallet_claim_back_phase2_core_20260831',
      'fn_agent_wallet_self_stake',
      'fn_promo_wallet_send',
    ]) {
      expect(body(fn)).toContain('1e9');
    }
  });

  it('fn_ca_post_leg never blocks the money and is not a browser door', () => {
    const b = body('fn_ca_post_leg');
    expect(b).toContain('INSERT INTO public.chip_ledger');
    expect(b).toContain('ca_ledger_write_failures');
    expect(b).not.toMatch(/RAISE/);
    expect(b).toContain('RETURN false');
    expect(RPC).toMatch(
      /REVOKE ALL ON FUNCTION public\.fn_ca_post_leg\(text, text, uuid, text, uuid, numeric, uuid, text, text\)\s*\n\s*FROM PUBLIC, anon, authenticated;/
    );
    expect(RPC).toMatch(
      /GRANT EXECUTE ON FUNCTION public\.fn_ca_post_leg\(text, text, uuid, text, uuid, numeric, uuid, text, text\)\s*\n\s*TO service_role;/
    );
  });

  it('keeps every door with the grant it had: browser doors authenticated, cores service_role', () => {
    for (const fn of [
      'fn_club_bank_send',
      'fn_club_bank_claim_back',
      'fn_club_bank_reverse',
      'fn_admin_remove_player_chips',
      'fn_agent_wallet_self_stake',
      'fn_promo_wallet_send',
      'fn_union_clawback_from_club',
    ]) {
      expect(RPC).toMatch(
        new RegExp(
          `GRANT EXECUTE ON FUNCTION public\\.${fn}\\([^)]*\\) TO authenticated, service_role;`
        )
      );
      expect(body(fn)).toContain('auth.uid()');
    }
    for (const fn of [
      'fn_agent_wallet_send_core_20260830',
      'fn_agent_wallet_claim_back_phase2_core_20260831',
    ]) {
      expect(RPC).toMatch(
        new RegExp(
          `REVOKE ALL ON FUNCTION public\\.${fn}\\([^)]*\\)\\s*\\n\\s*FROM PUBLIC, anon, authenticated;`
        )
      );
      expect(body(fn)).toContain('auth.uid()');
    }
  });

  it('self-checks the live bodies after apply: declaration, counts, grants, vocabulary', () => {
    expect(RPC).toMatch(/RAISE EXCEPTION '% does not declare its ledger shape \(%\)'/);
    expect(RPC).toMatch(/refusal count changed/);
    expect(RPC).toMatch(
      /RAISE EXCEPTION 'a grant moved; this migration must not change who may call'/
    );
    expect(RPC).toMatch(/apply the vocabulary migration first/);
  });

  it('carries no em dash', () => {
    expect(RPC).not.toContain('\u2014');
  });
});
