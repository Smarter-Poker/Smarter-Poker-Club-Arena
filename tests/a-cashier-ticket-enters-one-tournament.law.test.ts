/**
 * A CASHIER TICKET ENTERS ONE TOURNAMENT (2026-10-15).
 *
 * Dan: "SEND TICKET" SHOULD HAVE A DROP DOWN WHERE ANY AND ALL "FUTURE OR
 * CURRENTLY RUNNING TOURNAMENTS" SHOULD BE DISPLAYED TO "SELECT" AND AWARD
 * THAT USER A TICKET INTO THAT TOURNAMENT. FUNDS SHOULD BE SUBTRACTED FROM
 * THE SENDERS BALANCE.
 *
 * What this pins, because each one is a way the money could go wrong:
 *  - the price comes from the tournament (fn_tournament_entry_split), never the
 *    client, and the sender's escrow goes through the existing issue core;
 *  - the ticket is an entry, not chips: the holder cannot redeem it, and the
 *    entry nets the holder's wallet to zero exactly or rolls back;
 *  - a person and a horse are entered through the same door (CLAUDE.md 10.5);
 *  - a tournament that closes before the ticket is used settles it inside the
 *    closing transaction, never by a later sweep (CLAUDE.md 10.12);
 *  - the binding has no foreign key to the hot tournaments table (CLAUDE.md 2
 *    rule 7), and the whole change is one transaction with preimage pins.
 *
 * docs/changelog/2026-10-15-cashier-sends-a-ticket-into-one-tournament.md
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(__dirname, '..');
const MIG_DIR = join(ROOT, 'supabase', 'migrations');
const hits = readdirSync(MIG_DIR).filter((f) =>
  f.endsWith('_cashier_sends_a_ticket_into_one_tournament.sql')
);
const SQL = hits.length === 1 ? readFileSync(join(MIG_DIR, hits[0]), 'utf8') : '';

/** The body of one CREATE OR REPLACE FUNCTION in the migration. */
function fn(name: string): string {
  const start = SQL.indexOf(`CREATE OR REPLACE FUNCTION public.${name}(`);
  if (start < 0) return '';
  const open = SQL.indexOf('AS $function$', start);
  const close = SQL.indexOf('$function$;', open + 13);
  return SQL.slice(open, close);
}

describe('a cashier ticket enters one tournament', () => {
  it('has exactly one migration, one transaction, with a lock timeout', () => {
    expect(hits).toHaveLength(1);
    expect(SQL.match(/^BEGIN;$/gm)).toHaveLength(1);
    expect(SQL.trim().endsWith('COMMIT;')).toBe(true);
    expect(SQL).toContain("SET LOCAL lock_timeout = '5s';");
    expect(SQL).toMatch(/^-- @live-proof: /m);
  });

  it('pins the production body of every function it replaces before replacing it', () => {
    for (const [sig, md5] of [
      ['public.fn_cashier_batch_transfer(uuid,text,jsonb,uuid)', '0252faecc9c3e8dd506ccd00061243cb'],
      ['public.fn_redeem_tournament_ticket(uuid)', 'ab95c0907acccdedef0190acf242c8a3'],
      ['public.fn_find_tournament_entry_ticket(uuid)', 'a3a4c6317ae5510dc9b3e89bd48d9457'],
      [
        'public.fn_register_for_tournament_with_ticket_before_terminal_gate(uuid,uuid)',
        '086a533791e61600bb6ba3d58973a3b8',
      ],
      [
        'public.fn_register_horse_for_tournament_before_terminal_gate(uuid,uuid,boolean)',
        'd9a34831bf01f85933a6c79f3662be33',
      ],
      ['public.fn_horse_tournament_entry_ticket_hints(uuid)', '670bdb77de7e7039ceed5c70c4e7ccbc'],
      [
        'public.trg_ca_closed_target_pays_its_satellite_tickets()',
        '3fc780f946b5c9edb1d4513002693698',
      ],
    ]) {
      expect(SQL).toContain(`['${sig}','${md5}']`);
    }
    expect(SQL.indexOf('CASHIER_ENTRY_TICKET_PREIMAGE_CHANGED')).toBeLessThan(
      SQL.indexOf('CREATE TABLE public.tournament_ticket_entry_targets')
    );
  });

  it('prices the ticket from the tournament and escrows through the existing core', () => {
    const issue = fn('fn_issue_tournament_entry_ticket');
    expect(issue).toContain("v_price := (v_state->>'price')::numeric;");
    expect(issue).toContain('fn_issue_tournament_ticket_phase2_core_20260831(');
    expect(issue).toContain('p_club_id, p_holder_id, v_price, v_ticket_note, v_key)');
    // The client's number can only refuse, never set the price.
    expect(issue).toContain('p_expected_price IS DISTINCT FROM v_price');
    // No balance is written by this door itself.
    expect(issue).not.toMatch(/UPDATE\s+public\.club_members/i);
    const state = fn('fn_ca_cashier_ticket_target_state');
    expect(state).toContain('fn_tournament_entry_split(');
    expect(state).toContain('fn_tournament_late_registration_open(');
  });

  it('is idempotent on the retry key and refuses a key that belongs to anything else', () => {
    const issue = fn('fn_issue_tournament_entry_ticket');
    expect(issue).toContain("'replayed',true");
    expect(issue).toContain('That Retry Key Belongs To A Different Ticket');
    expect(issue).toContain('That Retry Key Is Already In Use');
    expect(SQL).toMatch(/idempotency_key text NOT NULL UNIQUE/);
  });

  it('a bound ticket is an entry, not chips', () => {
    const redeem = fn('fn_redeem_tournament_ticket');
    expect(redeem).toContain('tournament_ticket_entry_targets');
    expect(redeem.indexOf('tournament_ticket_entry_targets')).toBeLessThan(
      redeem.indexOf('UPDATE public.club_members')
    );
  });

  it('the entry nets the wallet to zero exactly, or nothing happened', () => {
    const use = fn('fn_ca_use_cashier_entry_ticket');
    expect(use).toContain("'app.ledger_category','ticket_redeem'");
    expect(use).toContain("'app.ledger_counterparty','escrow'");
    expect(use).toContain('v_after IS DISTINCT FROM v_before');
    expect(use).toContain("ERRCODE = 'CT001'");
    expect(use).toContain("EXCEPTION WHEN SQLSTATE 'CT001'");
  });

  it('a person and a horse enter through the same wallet door (10.5)', () => {
    const use = fn('fn_ca_use_cashier_entry_ticket');
    expect(use).toContain('fn_register_for_tournament_before_terminal_seat_gate(');
    expect(use).toContain('fn_register_horse_for_tournament_before_atomic_lifecycle_gate(');
    expect(fn('fn_register_horse_for_tournament_before_terminal_gate')).toContain(
      'fn_ca_use_cashier_entry_ticket('
    );
    expect(fn('fn_horse_tournament_entry_ticket_hints')).toContain(
      'tournament_ticket_entry_targets'
    );
    expect(fn('fn_register_for_tournament_with_ticket_before_terminal_gate')).toContain(
      'fn_ca_use_cashier_entry_ticket('
    );
  });

  it('a closed tournament settles its unused tickets in the closing transaction (10.12)', () => {
    expect(fn('trg_ca_closed_target_pays_its_satellite_tickets')).toContain(
      'fn_ca_settle_closed_cashier_entry_tickets('
    );
    const settle = fn('fn_ca_settle_closed_cashier_entry_tickets');
    expect(settle).toContain('fn_ca_satellite_ticket_target_is_closed(');
    expect(settle).toContain("'tournament_ticket_redeem'");
    expect(settle).toContain("'tournament_ticket_cancel'");
    // No new scheduled job, sweep or repair function.
    expect(SQL).not.toMatch(/cron\.schedule/i);
    expect(SQL).not.toMatch(/fn_\w*_(repair|backpay|redrive|sweep|catchup|heal)_\w*\s*\(/i);
  });

  it('the binding carries no foreign key and cannot be rewritten', () => {
    const table = SQL.slice(
      SQL.indexOf('CREATE TABLE public.tournament_ticket_entry_targets'),
      SQL.indexOf('COMMENT ON TABLE public.tournament_ticket_entry_targets')
    );
    expect(table).not.toMatch(/REFERENCES/i);
    expect(SQL).toContain('BEFORE UPDATE OR DELETE ON public.tournament_ticket_entry_targets');
  });

  it('browsers reach only the drop-down and the issue door', () => {
    expect(SQL).toMatch(
      /GRANT EXECUTE ON FUNCTION public\.fn_cashier_ticketable_tournaments\(uuid\)\s+TO authenticated/
    );
    expect(SQL).toMatch(
      /GRANT EXECUTE ON FUNCTION public\.fn_issue_tournament_entry_ticket\(uuid,uuid,uuid,text,text,numeric\)\s+TO authenticated/
    );
    for (const internal of [
      'fn_ca_use_cashier_entry_ticket(uuid,uuid,uuid)',
      'fn_ca_settle_closed_cashier_entry_tickets(uuid,text)',
      'fn_ca_find_cashier_entry_ticket_for(uuid,uuid)',
      'fn_ca_cashier_ticket_target_state(uuid)',
    ]) {
      expect(SQL).toContain(`REVOKE ALL ON FUNCTION public.${internal}`);
      expect(SQL).not.toContain(`GRANT EXECUTE ON FUNCTION public.${internal}`);
    }
  });

  it('the batch keeps every item without a tournament exactly as it was', () => {
    const batch = fn('fn_cashier_batch_transfer');
    expect(batch).toContain('public.fn_issue_tournament_ticket(');
    expect(batch).toContain('public.fn_issue_tournament_entry_ticket(');
    expect(batch).toContain('Every Batch Item Needs A Valid Recipient And Amount');
    expect(batch).toContain('Every Send Needs Its Own Retry Key');
    expect(batch).toContain('Every Ticket Needs Its Own Retry Key');
  });

  it('writes no em dash into anything a player reads', () => {
    expect(SQL).not.toContain(String.fromCharCode(0x2014));
  });
});
