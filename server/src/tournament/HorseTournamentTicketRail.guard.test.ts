/**
 * A satellite ticket belongs to its beneficiary, not to the browser session.
 *
 * Horses are auth-backed users, but the engine registers them through the
 * service-role-only horse door.  That door therefore has to choose and spend
 * an exact returned satellite ticket inside the same database transaction;
 * a client-side selector followed by the wallet door would strand the ticket
 * and charge the horse a second time.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const MIGRATION = readFileSync(
  join(
    process.cwd(),
    '..',
    'supabase/migrations/20260909165629_satellite_settlement_has_one_atomic_authority.sql'
  ),
  'utf8'
);
const RECURRING = readFileSync(
  join(process.cwd(), 'src/services/TournamentRecurringService.ts'),
  'utf8'
);
const PROBE = readFileSync(
  join(process.cwd(), '..', 'scripts/ci/probes/atomic-horse-satellite-ticket-return.sql'),
  'utf8'
);

function functionBody(name: string, dollarTag: string): string {
  const signature = `CREATE OR REPLACE FUNCTION public.${name}`;
  const bodyStart = MIGRATION.indexOf(`AS $${dollarTag}$`);
  expect(bodyStart, `${name} must use the expected dollar quote`).toBeGreaterThan(-1);
  const start = MIGRATION.lastIndexOf(signature, bodyStart);
  expect(start, `${name} must be defined by the atomic satellite migration`).toBeGreaterThan(-1);
  const end = MIGRATION.indexOf(`$${dollarTag}$;`, bodyStart + dollarTag.length + 4);
  expect(end, `${name} body must be complete`).toBeGreaterThan(bodyStart);
  return MIGRATION.slice(start, end + dollarTag.length + 3);
}

describe('horse tournament entry spends the beneficiary ticket before chips', () => {
  it('keeps beneficiary-aware ticket primitives owner-only', () => {
    const selector = functionBody(
      'fn_ca_find_tournament_entry_ticket_for',
      'find_tournament_entry_ticket_for'
    );
    const admission = functionBody(
      'fn_ca_register_for_tournament_with_ticket_for',
      'ticket_admission_for'
    );

    expect(selector).toContain('p_beneficiary_id uuid');
    expect(selector).toContain('v_uid uuid:=p_beneficiary_id');
    expect(selector).toContain('tk.holder_id=v_uid');
    expect(selector).toContain("'matching_tournament_ticket_unavailable'");
    expect(admission).toContain('p_beneficiary_id uuid');
    expect(admission).toContain('v_uid uuid:=p_beneficiary_id');
    expect(admission).toContain("'wallet_chips_credited',0");
    expect(admission).not.toContain('auth.uid()');

    for (const signature of [
      'public.fn_ca_find_tournament_entry_ticket_for(uuid,uuid)',
      'public.fn_ca_register_for_tournament_with_ticket_for(uuid,uuid,uuid)',
    ]) {
      expect(MIGRATION.replace(/\s+/g, '')).toContain(
        `REVOKEALLONFUNCTION${signature}FROMPUBLIC,anon,authenticated,service_role;`
      );
      expect(MIGRATION).not.toContain(`GRANT EXECUTE ON FUNCTION ${signature}`);
    }
  });

  it('preserves authenticated wrappers that can only act for auth.uid()', () => {
    const selector = functionBody(
      'fn_find_tournament_entry_ticket',
      'find_tournament_entry_ticket'
    );
    const admission = functionBody('fn_register_for_tournament_with_ticket', 'ticket_admission');

    expect(selector).toContain('v_uid uuid:=auth.uid()');
    expect(selector).toContain('fn_ca_find_tournament_entry_ticket_for(');
    expect(admission).toContain('v_uid uuid:=auth.uid()');
    expect(admission).toContain('fn_ca_register_for_tournament_with_ticket_for(');
    expect(admission).not.toContain('p_beneficiary_id');
  });

  it('makes the service-role horse door one ticket-first atomic authority', () => {
    const horse = functionBody('fn_register_horse_for_tournament', 'horse_ticket_first');
    const hints = functionBody('fn_horse_tournament_entry_ticket_hints', 'horse_ticket_hints');

    expect(hints).toContain("tk.status='issued'");
    expect(hints).toContain("tk.redemption_mode='tournament_entry_only'");
    expect(hints).toContain('SELECT DISTINCT tk.holder_id');
    expect(hints).not.toContain('chip_ledger');
    expect(hints).not.toContain('chip_transactions');
    expect(horse).toContain("hashtextextended('ca:tournament-terminal-settlement:v1',0)");
    expect(horse).toContain('pg_advisory_xact_lock_shared(530090,1)');
    expect(horse).toContain('fn_entry_purchases_frozen()');
    expect(horse).toMatch(/SELECT is_horse INTO v_is_horse[\s\S]*?p_user_id/);
    expect(horse).toContain('fn_ca_find_tournament_entry_ticket_for(');
    expect(horse).toContain('fn_ca_register_for_tournament_with_ticket_for(');
    expect(horse).toContain('fn_register_horse_for_tournament_before_maintenance_gate(');
    expect(horse).toContain('p_allow_wallet_charge boolean');
    expect(horse).toContain('p_allow_wallet_charge IS NOT TRUE');
    expect(horse).toContain("'hinted_tournament_ticket_no_longer_available'");

    const corrupt = horse.indexOf("(v_ticket_lookup->>'ok')::boolean");
    const ticketAdmission = horse.lastIndexOf('fn_ca_register_for_tournament_with_ticket_for(');
    const walletAdmission = horse.indexOf(
      'fn_register_horse_for_tournament_before_maintenance_gate('
    );
    expect(corrupt).toBeGreaterThan(-1);
    expect(ticketAdmission).toBeGreaterThan(corrupt);
    expect(walletAdmission).toBeGreaterThan(ticketAdmission);
  });

  it('leaves the server on the one combined RPC instead of recreating a two-call race', () => {
    const call = "'fn_register_horse_for_tournament'";
    expect(RECURRING).toContain(call);
    expect(RECURRING).not.toContain("'fn_find_tournament_entry_ticket'");
    expect(RECURRING).not.toContain("'fn_register_for_tournament_with_ticket'");
    expect(RECURRING).toContain("'fn_horse_tournament_entry_ticket_hints'");
    expect(RECURRING).toContain('p_allow_wallet_charge: !ticketHintIds.has(horse.id)');
  });

  it('does not let lane, bankroll or count truncation strand a hinted ticket horse', () => {
    const lane = RECURRING.indexOf('if (ticketHintIds.has(h.id)) return true;');
    const bankroll = RECURRING.indexOf('if (ticketHintIds.has(h.id)) return true;', lane + 1);
    const partition = RECURRING.indexOf(
      'const ticketPool = pool.filter((horse) => ticketHintIds.has(horse.id));'
    );
    const slice = RECURRING.indexOf(': orderedTickets.concat(orderedWallets).slice(0, count);');
    expect(lane).toBeGreaterThan(-1);
    expect(bankroll).toBeGreaterThan(lane);
    expect(partition).toBeGreaterThan(bankroll);
    expect(slice).toBeGreaterThan(partition);
  });

  it('rehearses the full horse cycle and both no-wallet race refusals', () => {
    expect(PROBE).toContain('public.fn_horse_tournament_entry_ticket_hints(');
    expect(PROBE).toContain('public.fn_register_horse_for_tournament(');
    expect(PROBE).toContain("'ticket_entry_replay'");
    expect(PROBE).toContain("'stale_hint_refusal'");
    expect(PROBE).toContain("'corrupt_ticket_refusal'");
    expect(PROBE).toContain("v_stale->>'reason'<>'hinted_tournament_ticket_no_longer_available'");
    expect(PROBE).toContain("v_corrupt->>'reason'<>'matching_tournament_ticket_unavailable'");
    expect(PROBE).toContain('chip_balance FROM public.club_members');
    expect(PROBE).toContain('FROM public.wallet_transactions');
  });
});
