import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const sql = readFileSync(
  resolve(
    __dirname,
    '..',
    'supabase/migrations/20260909014433_spin_reserve_settlement_commits_its_journal_or_nothing.sql'
  ),
  'utf8'
);
const closeout = readFileSync(
  resolve(
    __dirname,
    '..',
    'supabase/migrations/20260909053000_complete_known_spin_journal_adoption_after_freeze.sql'
  ),
  'utf8'
);

describe('Spin consumes the platform-wide strict auto-ledger', () => {
  it('cannot outlive its bounded production cutover transaction', () => {
    const begin = sql.indexOf('BEGIN;');
    const preflight = sql.indexOf('DO $preflight$', begin);
    expect(sql.indexOf("SET LOCAL lock_timeout = '15s';", begin)).toBeLessThan(preflight);
    expect(sql.indexOf("SET LOCAL statement_timeout = '120s';", begin)).toBeLessThan(preflight);
  });

  it('pins the upstream authority before and after without replacing it', () => {
    expect(sql.match(/2ff8923b4c2d8fd3d343cf37acce0f2c/g)).toHaveLength(2);
    expect(sql).toContain(
      'Spin requires the audited platform-wide strict fn_ca_autoledger from 20260908024909'
    );
    expect(sql).toContain('Spin changed or lost the platform-wide strict auto-ledger authority');
    expect(sql).not.toMatch(/CREATE OR REPLACE FUNCTION public\.fn_ca_autoledger\(\)/);
    expect(sql).not.toContain("v_strict := TG_TABLE_NAME = 'spin_bonus_pools'");
  });
});

describe('the already-paid 781cc0ee draw gains only its missing journal', () => {
  const triggerAssert = closeout.indexOf('DO $assert_781cc0ee_escrow_trigger$');
  const transientGate = closeout.indexOf('AS $adopt_781cc0ee_gate$', triggerAssert);
  const adoption = closeout.indexOf('DO $adopt_paid_781cc0ee_journal$', transientGate);
  const adoptionEnd = closeout.indexOf('$adopt_paid_781cc0ee_journal$;', adoption);
  const restored = closeout.indexOf(
    'CREATE OR REPLACE FUNCTION public.fn_ca_escrow_on_reserve_leg()',
    adoptionEnd
  );
  const restoredEnd = closeout.indexOf('$function$;', restored);
  const closed = closeout.indexOf('DO $verify_781cc0ee_adoption_closed$', restoredEnd);

  it('pins the exact enabled escrow trigger before opening a bounded exception', () => {
    expect(triggerAssert).toBeGreaterThan(-1);
    expect(transientGate).toBeGreaterThan(triggerAssert);
    expect(adoption).toBeGreaterThan(transientGate);
    expect(adoptionEnd).toBeGreaterThan(adoption);
    expect(restored).toBeGreaterThan(adoptionEnd);
    expect(restoredEnd).toBeGreaterThan(restored);
    expect(closed).toBeGreaterThan(restoredEnd);

    const assertion = closeout.slice(triggerAssert, transientGate);
    expect(assertion).toContain('0d7f735d58aadeb6fe03e9daf5e21a92');
    expect(assertion).toContain('37abfea4594c96da841bacdefab30c51');
    expect(assertion).toContain("tr.tgenabled = 'O'");
    expect(assertion).toContain('tr.tgtype = 5');
    expect(assertion).toContain("'public.fn_ca_escrow_on_reserve_leg()'::regprocedure");
    expect(closeout).not.toMatch(
      /ALTER TABLE public\.chip_ledger\s+DISABLE TRIGGER zz_ca_escrow_reserve_leg/i
    );
  });

  it('suppresses only the exact paid adoption row under a transaction-local nonce', () => {
    const gate = closeout.slice(transientGate, adoption);
    for (const evidence of [
      '20260909014433:781cc0ee-6a1d-4e31-acaf-4e737661bba1',
      '2d968239-acdd-4a2c-99f2-a369ff37ae31',
      'd6eba15c-04b2-47f2-a168-731d4f433696',
      'spin:781cc0ee-6a1d-4e31-acaf-4e737661bba1:draw',
      'NEW.amount = 3.00',
      'NEW.pre_from_balance = 52594.76',
      'NEW.post_from_balance = 52591.76',
      "NEW.metadata->>'prior_settlement_migration' = '20260908132643'",
      "NEW.metadata->>'escrow_already_applied' = 'true'",
    ]) {
      expect(gate).toContain(evidence);
    }
    expect(gate).toContain('Spin 781cc0ee escrow-side-effect suppression refused a non-exact row');
    expect(gate).toContain("IF NEW.category = 'spin_entry' THEN");
    expect(gate).toContain("ELSIF NEW.category = 'spin_prize' THEN");
  });

  it('proves paid evidence, appends one keyed row and changes no money state', () => {
    const block = closeout.slice(adoption, adoptionEnd);
    for (const evidence of [
      'd367f526-d950-4b4a-af4d-07793000d7c6',
      'be079c12-17e8-4b72-8534-e3b663f11df4',
      'fe731d49-4920-461d-8ad3-572190b42ff5',
      'da684ac8-e416-47fe-9e77-73d89381ce0a',
      'beb41a03-839f-4c61-897b-e7df50a9218e',
      '768dfffe-b11f-47df-9dbe-123db4a34abc',
      'e.reserve_in = 3',
      'e.prize_out = 3',
      'e.prize_balance = 0',
      'o.amount_owed = 3 AND o.amount_paid = 3',
      "p.amount = 3 AND p.source = 'structure'",
      "w.category = 'prize' AND w.amount = 3",
      "l.category = 'tournament_prize'",
      'INSERT INTO public.chip_ledger',
      'RETURNING id INTO v_journal_id',
      'FROM public.chip_ledger_idem k',
      'k.leg_id = v_journal_id',
      'v_tid = ANY(c.audited_tournament_ids)',
      'IF v_journal_id IS NULL THEN',
      'existing draw journal does not exactly match the adopted receipt',
    ]) {
      expect(block).toContain(evidence);
    }
    expect(block).not.toMatch(/fn_ca_settle_tournament_place_raw\s*\(/);
    expect(block).not.toMatch(
      /(?:INSERT INTO|UPDATE|DELETE FROM)\s+public\.(?:tournament_escrow|tournament_obligations|tournament_payouts|wallet_transactions|ca_manual_adjustments|club_members|spin_bonus_pools|spin_reserve_ledger)/i
    );
    expect(block.match(/set_config\('app\.spin_paid_journal_adoption'/g)).toHaveLength(1);
    expect(block).toContain("PERFORM set_config('app.spin_paid_journal_adoption','',true);");
    expect(block).toContain('IS DISTINCT FROM v_escrow_before');
    expect(block).toContain('IS DISTINCT FROM v_winner_wallets_before');
    expect(block).toContain('l.metadata = jsonb_build_object(');
  });

  it('restores the original function, ACL and trigger binding before commit', () => {
    const runtime = closeout.slice(restored, restoredEnd);
    const verification = closeout.slice(
      closed,
      closeout.indexOf('$verify_781cc0ee_adoption_closed$;', closed)
    );

    expect(runtime).not.toContain('spin_paid_journal_adoption');
    expect(runtime).not.toContain('781cc0ee');
    expect(runtime).toContain("IF NEW.category = 'spin_entry' THEN");
    expect(runtime).toContain("ELSIF NEW.category = 'spin_prize' THEN");
    expect(verification).toContain('0d7f735d58aadeb6fe03e9daf5e21a92');
    expect(verification).toContain('37abfea4594c96da841bacdefab30c51');
    expect(verification).toContain(
      "has_function_privilege(\n          'anon','public.fn_ca_escrow_on_reserve_leg()','EXECUTE')"
    );
    expect(verification).toContain(
      "current_setting('app.spin_paid_journal_adoption',true),'') <> ''"
    );
    expect(closeout.lastIndexOf('\nCOMMIT;')).toBeGreaterThan(closed);
  });
});

describe('Spin schema cutover and paid adoption use opposite freeze phases', () => {
  it('serializes and drains the parent before any child trigger DDL', () => {
    const terminal = sql.indexOf("hashtextextended('ca:tournament-terminal-settlement:v1',0)");
    const maintenance = sql.indexOf('pg_advisory_xact_lock_shared(530090,1)');
    const freezeGate = sql.indexOf('DO $require_live_spin_cutover_freeze$');
    const tournament = sql.indexOf('LOCK TABLE public.tournaments IN ACCESS EXCLUSIVE MODE');
    const seats = sql.indexOf('LOCK TABLE public.table_seats IN ACCESS EXCLUSIVE MODE');
    const reserve = sql.indexOf('LOCK TABLE public.spin_reserve_ledger IN ACCESS EXCLUSIVE MODE');
    const firstChildDdl = sql.indexOf('DROP TRIGGER IF EXISTS a0_tournament_live_seat_root_guard');

    expect(terminal).toBeGreaterThan(-1);
    expect(maintenance).toBeGreaterThan(terminal);
    expect(freezeGate).toBeGreaterThan(maintenance);
    expect(tournament).toBeGreaterThan(freezeGate);
    expect(seats).toBeGreaterThan(tournament);
    expect(reserve).toBeGreaterThan(seats);
    expect(firstChildDdl).toBeGreaterThan(reserve);
    expect(sql).toContain(
      'atomic Spin settlement live cutover requires the maintenance entry freeze'
    );
    expect(sql).toContain('atomic Spin settlement live cutover freeze expired before commit');
    expect(sql).not.toContain('DO $adopt_paid_781cc0ee_journal$');
  });

  it('runs the small journal closeout only after thaw and carries no broad DDL', () => {
    const terminal = closeout.indexOf("hashtextextended('ca:tournament-terminal-settlement:v1',0)");
    const maintenance = closeout.indexOf('pg_advisory_xact_lock_shared(530090,1)');
    const thaw = closeout.indexOf('DO $require_spin_adoption_thaw$');
    const frozen = closeout.indexOf('public.fn_entry_purchases_frozen()', thaw);
    const exactAdoption = closeout.indexOf('DO $assert_781cc0ee_escrow_trigger$', frozen);

    expect(terminal).toBeGreaterThan(-1);
    expect(maintenance).toBeGreaterThan(terminal);
    expect(thaw).toBeGreaterThan(maintenance);
    expect(frozen).toBeGreaterThan(thaw);
    expect(exactAdoption).toBeGreaterThan(frozen);
    expect(closeout).toContain("c.migration_version = '20260909014433'");
    expect(closeout).toContain(
      'Spin journal adoption closeout must run after the maintenance freeze'
    );
    expect(closeout).toContain('public.fn_platform_frozen()');
    expect(closeout).toContain(
      'Spin journal closeout must run before terminal evidence immutability cutovers'
    );
    expect(closeout).toContain("'public.fn_cancelled_tournament_evidence_is_immutable()'");
    expect(closeout).toContain("'public.fn_satellite_transfer_ledger_is_immutable()'");
    expect(closeout).toContain("'public.fn_terminal_tournament_evidence_is_immutable()'");
    expect(closeout).not.toMatch(/LOCK TABLE public\./);
    expect(closeout).not.toMatch(/ALTER TABLE public\./);
    expect(closeout).not.toMatch(/DROP TRIGGER/i);
  });
});
