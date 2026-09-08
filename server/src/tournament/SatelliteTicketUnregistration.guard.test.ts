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
    '20260908153207_satellite_settlement_has_one_atomic_authority.sql'
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

const UNREGISTER = taggedBody('entitlement_unregister_core');
const UNREGISTER_RECEIPT = taggedBody('unregistration_receipt');
const RETURN_TICKET = taggedBody('return_satellite_ticket');
const ADMISSION = taggedBody('ticket_admission_for');
const SELECTOR = taggedBody('find_tournament_entry_ticket_for');
const TICKET_GUARD = taggedBody('satellite_entry_ticket_guard');
const ADMIN_REMOVE = taggedBody('admin_remove_wrapper');

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
    expect(PROBE).toContain('legacy_post_start_refusal');
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
  });
});
