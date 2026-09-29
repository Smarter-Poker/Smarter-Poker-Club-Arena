/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  LAW - A DIAMOND CORRECTION SETTLES ONCE
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Phase 10, line 4, the audited adjustments (item 7 of the build list in
 * docs/DIAMOND-PHASE-10-AUDIT-2026-09-21.md). ca_manual_adjustments already
 * took a Diamond row and forbade an approver approving their own proposal,
 * but an approved Diamond row had nowhere to go. The migration adds the one
 * platform-staff door that settles it exactly once and three platform-staff
 * doors over the register's own propose, approve and reject.
 *
 * What pays for a correction is Dan's (the audit's decision 2): one row or
 * none in ca_diamond_correction_source, written by a values migration that
 * quotes him, never by this code. Until it exists every settlement is refused
 * by name. Every leg goes through the Mint's own doors, so the balance, the
 * journal and the register move together and the supply identity stays whole;
 * one immutable receipt per adjustment makes a second settlement impossible
 * and a replay returns it. The second-person rule is the register's CHECK,
 * unchanged (decision 3), and the approvals setting is not touched.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { migrationNames, migrationText } from './helpers/migrationCorpus';
import { sliceBetween } from './helpers/sourceWindow';

const NAME = migrationNames()
  .filter((n) => n.endsWith('_a_diamond_correction_settles_once.sql'))
  .at(-1);
if (!NAME) throw new Error('the Diamond correction migration is missing');
const MIG = migrationText(NAME);

const code = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/--[^\n]*/g, ' ');
const section = (from: string, to: string) => sliceBetween(MIG, from, to);
const PINS = section('SET LOCAL lock_timeout', '-- 1. WHAT PAYS FOR A DIAMOND CORRECTION');
const SOURCE = section(
  '-- 1. WHAT PAYS FOR A DIAMOND CORRECTION IS AUTHORIZED, NEVER ASSUMED',
  '-- 2. A SETTLED DIAMOND ADJUSTMENT HAS ONE RECEIPT'
);
const RECEIPTS = section(
  '-- 2. A SETTLED DIAMOND ADJUSTMENT HAS ONE RECEIPT, AND IT NEVER CHANGES',
  "-- 3. AN APPROVED DIAMOND ADJUSTMENT SETTLES ONCE, THROUGH THE MINT'S OWN DOORS"
);
const SETTLE = section(
  "-- 3. AN APPROVED DIAMOND ADJUSTMENT SETTLES ONCE, THROUGH THE MINT'S OWN DOORS",
  '-- 4. PLATFORM STAFF PROPOSE, APPROVE AND REJECT A DIAMOND ADJUSTMENT AS THEMSELVES'
);
const WRAPPERS = section(
  '-- 4. PLATFORM STAFF PROPOSE, APPROVE AND REJECT A DIAMOND ADJUSTMENT AS THEMSELVES',
  '-- 5. THE ESTATE IS AS IT WAS'
);
const FINAL = code(section('-- 5. THE ESTATE IS AS IT WAS', 'RAISE NOTICE'));

/** One function's text, from its CREATE to the end of its dollar-quoted body. */
const fn = (src: string, name: string): string => {
  const open = src.indexOf(`CREATE OR REPLACE FUNCTION public.${name}(`);
  expect(open, `${name} is missing`).toBeGreaterThan(-1);
  const start = src.indexOf('$function$', open);
  const end = src.indexOf('$function$', start + 10);
  return src.slice(open, end + 10);
};
const DOORS = [
  'fn_ca_diamond_adjustment_propose',
  'fn_ca_diamond_adjustment_approve',
  'fn_ca_diamond_adjustment_reject',
  'fn_ca_diamond_adjustment_settle',
] as const;
const SETTLE_FN = fn(SETTLE, 'fn_ca_diamond_adjustment_settle');
const SETTLE_CODE = code(SETTLE_FN);

describe('LAW: a Diamond correction settles once', () => {
  it('authorizes nothing, opens nothing, prices nothing and changes no existing rule', () => {
    const all = code(MIG);
    expect(all).not.toMatch(/INSERT\s+INTO\s+public\.ca_diamond_correction_source/i);
    expect(all).not.toMatch(/SET\s+(tournaments_enabled|cash_games_enabled)\s*=\s*true/i);
    expect(all).not.toMatch(/ca_operator_policy|fn_ca_operator_set_policy|fn_ca_mint_policy_set/);
    expect(all).not.toMatch(/ALTER\s+TABLE\s+public\.ca_manual_adjustments/i);
    expect(all).not.toMatch(/\bDROP\b/i);
    const replaced = [...all.matchAll(/CREATE OR REPLACE FUNCTION public\.(\w+)\(/g)].map(
      (m) => m[1]
    );
    expect(replaced.sort()).toEqual(
      [...DOORS, 'fn_ca_diamond_adjustment_receipt_is_immutable'].sort()
    );
    expect(FINAL).toContain('this migration must not authorize what pays for a Diamond correction');
    expect(FINAL).toContain('this migration must not settle anything');
    expect(FINAL).toContain('this migration must not open a switch');
  });

  it('pins every function it calls and refuses to run on any other text', () => {
    for (const pin of [
      "fn_ca_propose_manual_adjustment(text,numeric,text,uuid,uuid,uuid,text,text)', 'da73a86110bccc223923e61fc67f12c8'",
      "fn_ca_approve_manual_adjustment(uuid,uuid,text,text)', '87c480eddf6aa3f9b0c0a6c51b9b78ef'",
      "fn_ca_reject_manual_adjustment(uuid,text,uuid,text)', '7e9450272c980feb7681144696d75c42'",
      "fn_ca_mint(text,text,uuid,numeric,text,text,text)', 'da9429ce6483c47c7d536582433a1edd'",
      "fn_ca_burn(text,text,uuid,numeric,text,text,text)', '01892d172b17e45bc8a47f76d3e5a564'",
    ]) {
      expect(PINS).toContain(pin);
    }
    expect(PINS).toContain('IF md5(pg_get_functiondef(r.sig::regprocedure)) <> r.pin THEN');
  });

  it('what pays is one authorized row or none, readable only by the service', () => {
    expect(SOURCE).toContain('id smallint PRIMARY KEY DEFAULT 1 CHECK (id = 1)');
    expect(SOURCE).toContain(
      "source text NOT NULL CHECK (source IN ('diamond_house', 'new_issuance'))"
    );
    expect(SOURCE).toContain(
      'authorized_by text NOT NULL CHECK (length(btrim(authorized_by)) >= 2)'
    );
    expect(SOURCE).toContain('ruling text NOT NULL CHECK (length(btrim(ruling)) >= 10)');
    expect(SOURCE).toContain('ENABLE ROW LEVEL SECURITY');
    expect(SOURCE).toContain(
      'REVOKE ALL ON TABLE public.ca_diamond_correction_source FROM PUBLIC, anon, authenticated, service_role;'
    );
    expect(SOURCE).toContain(
      'GRANT SELECT ON TABLE public.ca_diamond_correction_source TO service_role;'
    );
  });

  it('a settled adjustment has one receipt, keyed by the adjustment, that never changes', () => {
    expect(RECEIPTS).toContain(
      'adjustment_id uuid PRIMARY KEY REFERENCES public.ca_manual_adjustments (id)'
    );
    expect(RECEIPTS).toContain('BEFORE UPDATE OR DELETE ON public.ca_diamond_adjustment_receipts');
    expect(RECEIPTS).toContain("RAISE EXCEPTION 'A Diamond adjustment receipt is immutable'");
    expect(RECEIPTS).toContain(
      'REVOKE ALL ON TABLE public.ca_diamond_adjustment_receipts FROM PUBLIC, anon, authenticated, service_role;'
    );
  });

  it('the settle door locks the row, replays a settled row from its receipt, and settles only an approved one', () => {
    const at = (needle: string) => {
      const i = SETTLE_CODE.indexOf(needle);
      expect(i, needle).toBeGreaterThan(-1);
      return i;
    };
    const gate = at('IF NOT public.fn_is_platform_admin() THEN');
    const lock = at('FROM public.ca_manual_adjustments WHERE id = p_adjustment_id FOR UPDATE;');
    const diamondsOnly = at("'not_a_diamond_adjustment'");
    const replay = at("RETURN v_prior.receipt || jsonb_build_object('replayed', true);");
    const approvedOnly = at("IF v_adj.status <> 'approved' THEN");
    const source = at('FROM public.ca_diamond_correction_source WHERE id = 1;');
    const refused = at("'diamond_correction_source_not_authorized'");
    const firstLeg = at('public.fn_ca_mint(');
    expect(gate).toBeLessThan(lock);
    expect(lock).toBeLessThan(diamondsOnly);
    expect(diamondsOnly).toBeLessThan(replay);
    expect(replay).toBeLessThan(approvedOnly);
    expect(approvedOnly).toBeLessThan(source);
    expect(source).toBeLessThan(refused);
    expect(refused).toBeLessThan(firstLeg);
    expect(SETTLE_FN).toContain(' SECURITY DEFINER');
  });

  it('every leg goes through the Mint, as the plan for each answer says, and nothing else writes money', () => {
    for (const arm of [
      "WHEN v_player AND v_src.source = 'diamond_house' AND v_credit THEN ARRAY['burn:house', 'mint:player']",
      "WHEN v_player AND v_src.source = 'diamond_house' THEN ARRAY['burn:player', 'mint:house']",
      "WHEN v_player AND v_credit THEN ARRAY['mint:player']",
      "WHEN v_player THEN ARRAY['burn:player']",
      "WHEN v_credit THEN ARRAY['mint:house']",
      "ELSE ARRAY['burn:house']",
    ]) {
      expect(SETTLE_CODE).toContain(arm);
    }
    expect(SETTLE_CODE).toContain("v_leg := public.fn_ca_mint('diamonds', v_holder,");
    expect(SETTLE_CODE).toContain("v_leg := public.fn_ca_burn('diamonds', v_holder,");
    expect(SETTLE_CODE).toContain(
      "v_key    := 'diamond-adjustment:' || v_adj.id::text || ':' || v_step;"
    );
    for (const direct of [
      /UPDATE\s+public\.profiles/i,
      /UPDATE\s+public\.ca_diamond_house\b/i,
      /INSERT\s+INTO\s+public\.ca_mint_ledger/i,
      /INSERT\s+INTO\s+public\.diamond_transactions/i,
      /INSERT\s+INTO\s+public\.ca_diamond_house_ledger/i,
      /poker_diamond_custody/i,
    ]) {
      expect(SETTLE_CODE).not.toMatch(direct);
    }
    // a leg must be in the register, and a Mint replay is never recorded as this door's work
    expect(SETTLE_CODE).toContain('the register does not carry leg %');
    expect(SETTLE_CODE).toContain("IF COALESCE((v_leg ->> 'replayed')::boolean, false) THEN");
  });

  it('the legs, the receipt and the settled status stand or fall together, and a refusal is named', () => {
    const block = SETTLE_CODE.slice(
      SETTLE_CODE.indexOf('FOREACH v_step IN ARRAY v_plan LOOP'),
      SETTLE_CODE.indexOf("EXCEPTION WHEN SQLSTATE 'P0961' THEN")
    );
    expect(block).toContain(
      "RAISE EXCEPTION 'a Diamond adjustment leg was refused' USING ERRCODE = 'P0961';"
    );
    expect(block).toContain("'refused_reason', COALESCE(v_leg ->> 'reason', 'the_mint_refused'),");
    expect(block).toContain('INSERT INTO public.ca_diamond_adjustment_receipts');
    expect(block).toContain("UPDATE public.ca_manual_adjustments SET status = 'settled'");
    expect(block).toContain("WHERE id = v_adj.id AND status = 'approved';");
    const handler = SETTLE_CODE.slice(SETTLE_CODE.indexOf("EXCEPTION WHEN SQLSTATE 'P0961' THEN"));
    expect(handler).toMatch(/IF v_refusal IS NULL THEN\s+RAISE;\s+END IF;\s+RETURN v_refusal;/);
  });

  it('the three register doors admit platform staff only, Diamond rows only, and always name the caller', () => {
    const propose = code(fn(WRAPPERS, 'fn_ca_diamond_adjustment_propose'));
    const approve = code(fn(WRAPPERS, 'fn_ca_diamond_adjustment_approve'));
    const reject = code(fn(WRAPPERS, 'fn_ca_diamond_adjustment_reject'));
    for (const body of [propose, approve, reject]) {
      expect(body).toContain('v_uid   uuid := auth.uid();');
      expect(body.indexOf('IF NOT public.fn_is_platform_admin() THEN')).toBeGreaterThan(-1);
      expect(body.indexOf('IF NOT public.fn_is_platform_admin() THEN')).toBeLessThan(
        body.indexOf('RETURN public.fn_ca_')
      );
    }
    expect(WRAPPERS).toContain(
      'CREATE OR REPLACE FUNCTION public.fn_ca_diamond_adjustment_propose(p_target_kind text, p_target_id uuid, p_amount numeric, p_reason text)'
    );
    expect(WRAPPERS).toContain(
      'CREATE OR REPLACE FUNCTION public.fn_ca_diamond_adjustment_approve(p_adjustment_id uuid, p_note text DEFAULT NULL)'
    );
    expect(WRAPPERS).toContain(
      'CREATE OR REPLACE FUNCTION public.fn_ca_diamond_adjustment_reject(p_adjustment_id uuid, p_note text DEFAULT NULL)'
    );
    expect(propose).toContain("IF v_kind NOT IN ('diamond_wallet', 'diamond_house') THEN");
    expect(propose).toMatch(/NULL, v_uid, v_label, 'diamonds'\);/);
    expect(approve).toContain("IF v_asset IS DISTINCT FROM 'diamonds' THEN");
    expect(approve).toContain(
      'RETURN public.fn_ca_approve_manual_adjustment(p_adjustment_id, v_uid, v_label, p_note);'
    );
    expect(reject).toContain("IF v_asset IS DISTINCT FROM 'diamonds' THEN");
    expect(reject).toContain(
      'RETURN public.fn_ca_reject_manual_adjustment(p_adjustment_id, p_note, v_uid, v_label);'
    );
  });

  it('each door is registered before it exists, signed-in callers only, and the money underneath keeps no client key', () => {
    for (const door of DOORS) {
      const reg = MIG.indexOf(`('${door}', 'approved',`);
      expect(reg, `${door} is not registered`).toBeGreaterThan(-1);
      expect(reg).toBeLessThan(MIG.indexOf(`CREATE OR REPLACE FUNCTION public.${door}(`));
      expect(MIG).toMatch(
        new RegExp(`REVOKE ALL ON FUNCTION public\\.${door}\\([^)]*\\) FROM PUBLIC, anon;`)
      );
      expect(MIG).toMatch(
        new RegExp(
          `GRANT EXECUTE ON FUNCTION public\\.${door}\\([^)]*\\) TO authenticated, service_role;`
        )
      );
    }
    expect(FINAL).toContain('is reachable without an account');
    expect(FINAL).toContain('cannot be reached by a signed-in staff member');
    expect(FINAL).toContain('is reachable by a client role');
    expect(FINAL).toContain('the Diamond identity is not whole');
    expect(FINAL).toContain('watched guards off their baseline');
  });

  it('the client names each door exactly once, through one service', () => {
    const service = readFileSync(
      resolve(__dirname, '..', 'src', 'services', 'DiamondAdjustmentService.ts'),
      'utf8'
    );
    for (const door of DOORS) {
      expect(service.match(new RegExp(`'${door}'`, 'g')) ?? []).toHaveLength(1);
    }
  });
});
