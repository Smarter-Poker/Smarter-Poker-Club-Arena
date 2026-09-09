import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..', '..');
const SQL = readFileSync(
  join(
    ROOT,
    'supabase',
    'migrations',
    '20260909165629_satellite_settlement_has_one_atomic_authority.sql'
  ),
  'utf8'
);
const PROBE = readFileSync(
  join(ROOT, 'scripts', 'ci', 'probes', 'atomic-satellite-ticket-return.sql'),
  'utf8'
);
const MANIFEST = JSON.parse(
  readFileSync(
    join(ROOT, 'scripts', 'ci', 'schema-manifest.d', 'codex-atomic-satellite-settlement.json'),
    'utf8'
  )
) as {
  tables: string[];
  functions: string[];
  columns: Record<string, string[]>;
};

function taggedBody(tag: string): string {
  const delimiter = `$${tag}$`;
  const first = SQL.indexOf(delimiter);
  const second = SQL.indexOf(delimiter, first + delimiter.length);
  expect(first, `opening ${delimiter}`).toBeGreaterThan(-1);
  expect(second, `closing ${delimiter}`).toBeGreaterThan(first);
  return SQL.slice(first + delimiter.length, second);
}

function functionDefinition(name: string): string {
  const start = SQL.indexOf(`CREATE OR REPLACE FUNCTION public.${name}(`);
  const end = SQL.indexOf('\nREVOKE ALL ON FUNCTION', start);
  expect(start, `${name} definition`).toBeGreaterThan(-1);
  expect(end, `${name} revoke`).toBeGreaterThan(start);
  return SQL.slice(start, end);
}

const UNREGISTER = taggedBody('entitlement_unregister_core');
const UNREGISTER_RECEIPT = taggedBody('unregistration_receipt');
const RETURN_TICKET = taggedBody('return_satellite_ticket');
const ADMISSION = taggedBody('ticket_admission_for');
const SELECTOR = taggedBody('find_tournament_entry_ticket_for');
const TICKET_GUARD = taggedBody('satellite_entry_ticket_guard');
const ADMIN_REMOVE = taggedBody('admin_remove_wrapper');
const HUMAN_REGISTRATION = functionDefinition(
  'fn_register_for_tournament_before_atomic_capacity_20260907'
);
const HORSE_REGISTRATION = functionDefinition(
  'fn_register_horse_for_tournament_before_maintenance_gate'
);
const CASH_REDEEM = taggedBody('redeem_cash_ticket_only');
const CASH_CANCEL = taggedBody('cancel_cash_ticket_only');

describe('satellite-funded tournament unregistration is ticket-only', () => {
  it('permits unregistration only before the scheduled start', () => {
    expect(UNREGISTER).toContain(
      "upper(COALESCE(v_t.status::text,'')) NOT IN ('ANNOUNCED','REGISTERING')"
    );
    expect(UNREGISTER).toContain('clock_timestamp()>=v_t.start_time');
    expect(UNREGISTER.toLowerCase()).not.toContain("interval '1 minute'");
    expect(PROBE).toContain("v_post_start->>'reason'<>'tournament_started'");
  });

  it('routes wallet charges to their recorded wallet and noncash entries to tickets', () => {
    expect(UNREGISTER).toContain("entitlement_kind='wallet_charge'");
    expect(UNREGISTER).toContain("entitlement_kind IN ('satellite_seat','tournament_ticket')");
    expect(UNREGISTER).toContain('fn_ca_return_satellite_entitlement_as_ticket(');
    expect(UNREGISTER).toContain(
      'satellite-funded registration % can return only a tournament ticket'
    );
    expect(UNREGISTER).toContain('v_wallet_amount<>0');
    expect(UNREGISTER_RECEIPT).toContain("'wallet_chips_from_satellite_entitlements',0");
    expect(RETURN_TICKET).not.toContain('wallet_transactions');
    expect(RETURN_TICKET).not.toContain('credit_player_wallet');
  });

  it('uses the union-aware governed game authority for administrator removal', () => {
    expect(ADMIN_REMOVE).toContain('public.fn_can_create_games(v_club_id,v_uid)');
    expect(ADMIN_REMOVE).not.toContain('public.is_club_admin(');
  });

  it('replays only the exact request-keyed pre-start outcome', () => {
    expect(SQL).toContain('CREATE TABLE public.tournament_unregistration_receipts');
    expect(SQL).toContain('request_id uuid NOT NULL UNIQUE');
    expect(SQL).toContain('CHECK (settled_at < scheduled_start_at)');
    expect(UNREGISTER).toContain('p_request_id IS NOT NULL');
    expect(UNREGISTER).toContain('unregistration request id belongs to another intent');
    expect(UNREGISTER).toContain('v_unregistered_at:=clock_timestamp()');
    expect(UNREGISTER_RECEIPT).toContain('r.request_id=p_request_id');
    expect(UNREGISTER_RECEIPT).toContain('FROM public.chip_transactions');
    expect(PROBE).toContain('second_return_post_start_replay');
    expect(PROBE).toContain('fresh_request_post_start_refusal');
    expect(PROBE).toContain('old unregistration request id touched a later registration');
  });

  it('spends a returned ticket directly into tournament escrow with no wallet path', () => {
    expect(ADMISSION).toContain("redemption_mode IS DISTINCT FROM 'tournament_entry_only'");
    expect(ADMISSION).toContain('INSERT INTO public.tournament_refund_entitlements');
    expect(ADMISSION).toContain("'atomic_tournament_ticket'");
    expect(ADMISSION).toContain("'wallet_chips_credited',0");
    expect(ADMISSION).not.toContain('INSERT INTO public.wallet_transactions');
    expect(ADMISSION).not.toContain('credit_player_wallet');
  });

  it('accepts a cap-blocked direct award only for its immutable target tournament', () => {
    const refundBranchStart = SELECTOR.indexOf('(tk.source_refund_entitlement_id IS NOT NULL');
    const directBranchStart = SELECTOR.indexOf(
      '(tk.source_refund_entitlement_id IS NULL',
      refundBranchStart
    );
    const refundBranch = SELECTOR.slice(refundBranchStart, directBranchStart);
    const directBranch = SELECTOR.slice(directBranchStart);

    expect(refundBranchStart).toBeGreaterThan(-1);
    expect(directBranchStart).toBeGreaterThan(refundBranchStart);
    expect(refundBranch).not.toContain('source_a.');
    expect(SQL).toContain('source_satellite_award_place integer');
    expect(SQL).toContain('tournament_tickets_direct_satellite_award_fkey');
    expect(SQL).toContain('tournament_ticket_one_direct_satellite_award');
    expect(ADMISSION).toContain('FROM public.tournament_satellite_awards source_a');
    expect(ADMISSION).toContain('source_h.target_id=v_ticket.source_tournament_id');
    expect(ADMISSION).toContain('p_tournament_id=v_ticket.source_tournament_id');
    expect(ADMISSION).toContain("source_a.delivery_kind='ticket'");
    expect(ADMISSION).toContain('wallet_key.key=source_a.idempotency_key');
    expect(SELECTOR).toContain('tk.source_tournament_id=p_tournament_id');
    expect(directBranch).toContain("source_a.delivery_kind='ticket'");
    expect(directBranch).toContain("issue_l.metadata->>'kind'='direct_satellite_entry_ticket'");
  });

  it('chains a spent direct ticket through the same unregister-to-ticket rail', () => {
    expect(ADMISSION).toContain("'tournament_ticket','tournament_ticket'");
    expect(ADMISSION).toContain('v_ticket.source_satellite_id,NULL,v_ticket.id');
    expect(RETURN_TICKET).toContain(
      "v_e.entitlement_kind NOT IN ('satellite_seat','tournament_ticket')"
    );
    expect(RETURN_TICKET).toContain('v_e.source_satellite_id,v_e.id');
    expect(RETURN_TICKET).toContain("'tournament_entry_only'");
    expect(PROBE).toContain('direct_wrong_target_refused');
    expect(PROBE).toContain('direct_full_refusal');
    expect(PROBE).toContain('direct_ticket_entry_replay');
    expect(PROBE).toContain('direct_ticket_return_replay');
    expect(PROBE).toContain('direct cap ticket -> exact target -> ticket-only return');
  });

  it('lets a valid free tournament continue without inventing a ticket', () => {
    expect(SELECTOR).toContain('OR v_split.charge<0');
    expect(SELECTOR).toContain('IF v_split.charge=0 THEN');
    expect(SELECTOR).toContain("'ok',true,'ticket_id',NULL");
    expect(PROBE).toContain('free_selector');
  });

  it('requires one owner-only authorization row instead of trusting a session setting', () => {
    expect(SQL).toContain('CREATE TABLE public.tournament_ticket_admission_authorizations');
    expect(SQL).toMatch(
      /REVOKE ALL ON TABLE public\.tournament_ticket_admission_authorizations[\s\S]*?PUBLIC, anon, authenticated, service_role/
    );
    expect(ADMISSION).toContain('INSERT INTO public.tournament_ticket_admission_authorizations');
    expect(TICKET_GUARD).toContain('FROM public.tournament_ticket_admission_authorizations');
    expect(TICKET_GUARD).toContain('DELETE FROM public.tournament_ticket_admission_authorizations');
    expect(PROBE).toContain('a forged session setting redeemed a tournament-entry ticket');
  });

  it('proves the complete ticket return and reuse cycle with zero wallet rows', () => {
    expect(PROBE).toContain('first_return');
    expect(PROBE).toContain('ticket_entry');
    expect(PROBE).toContain('second_return');
    expect(PROBE).toContain('fn_redeem_tournament_ticket');
    expect(PROBE).toContain('fn_cancel_tournament_ticket');
    expect(PROBE).toContain('wallet_chips_from_satellite_entitlements');
    expect(PROBE).toContain('zero wallet rows');
  });

  it('removes registration compensation from complete source-controlled cores', () => {
    for (const core of [HUMAN_REGISTRATION, HORSE_REGISTRATION]) {
      expect(core).toContain('EXCEPTION WHEN unique_violation THEN');
      expect(core).toContain("USING ERRCODE = '40001'");
      expect(core).not.toContain('credit_player_wallet(');
      expect(core).not.toContain('tourn_reg_race:');
    }
    expect(SQL).not.toMatch(/EXECUTE\s+replace\s*\(/i);
  });

  it('hard-refuses noncash tickets before either cashier wallet write', () => {
    for (const cashier of [CASH_REDEEM, CASH_CANCEL]) {
      const refusal = cashier.indexOf("v_t.redemption_mode='tournament_entry_only'");
      const wallet = cashier.indexOf('UPDATE public.club_members');
      expect(refusal).toBeGreaterThan(-1);
      expect(wallet).toBeGreaterThan(refusal);
    }
    expect(CASH_REDEEM).toContain(
      'Tournament-Entry Tickets Can Only Be Used To Enter A Tournament'
    );
    expect(CASH_CANCEL).toContain(
      'Returned Tournament-Entry Tickets Cannot Be Cancelled For Chips'
    );
  });

  it('declares every new ticket boundary in the schema fragment', () => {
    expect(MANIFEST.tables).toContain('tournament_ticket_admission_authorizations');
    expect(MANIFEST.tables).toContain('tournament_refund_entitlements');
    expect(MANIFEST.tables).toContain('tournament_unregistration_receipts');
    expect(MANIFEST.functions).toContain('fn_register_for_tournament_with_ticket');
    expect(MANIFEST.functions).toContain('fn_find_tournament_entry_ticket');
    expect(MANIFEST.functions).toContain('fn_ca_register_for_tournament_with_ticket_for');
    expect(MANIFEST.functions).toContain('fn_ca_find_tournament_entry_ticket_for');
    expect(MANIFEST.functions).toContain('fn_horse_tournament_entry_ticket_hints');
    expect(MANIFEST.functions).toContain('fn_register_horse_for_tournament');
    expect(MANIFEST.functions).toContain('fn_ca_unregister_tournament_player_exact');
    expect(MANIFEST.functions).toContain('fn_ca_tournament_unregistration_receipt');
    expect(MANIFEST.columns.tournament_tickets).toContain('redemption_mode');
    expect(MANIFEST.columns.tournament_tickets).toContain('source_satellite_award_place');
  });
});
