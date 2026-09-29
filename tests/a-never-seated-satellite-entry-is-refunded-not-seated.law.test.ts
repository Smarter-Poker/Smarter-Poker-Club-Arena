import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// Owner decision 2026-09-26 (Dan): "Refund the 50.00 ticket" for JulesSA's
// satellite entry into "Sunday Funday Six-Card Closer", which was funded but
// never dealt in. The settlement is a one-off migration. These assertions keep
// its shape honest: money only through the platform's exact refund door, one
// registration by id, every number asserted, nothing seated, no other balance
// or seat touched, and a replay that does nothing.

const root = (path: string) => resolve(__dirname, '..', path);
const file = '20260926054204_a_never_seated_satellite_entry_is_refunded_not_seated.sql';
const sql = readFileSync(root(`supabase/migrations/${file}`), 'utf8');

function body(tag: string): string {
  const d = `$${tag}$`;
  const a = sql.indexOf(d);
  const b = sql.indexOf(d, a + d.length);
  expect(a, `opening ${d}`).toBeGreaterThan(-1);
  expect(b, `closing ${d}`).toBeGreaterThan(a);
  return sql.slice(a + d.length, b);
}

const code = (s: string) =>
  s
    .split('\n')
    .map((l) => l.replace(/--.*$/, ''))
    .join('\n');

const release = code(body('release'));
const ddl = code(sql.slice(0, sql.indexOf('DO $release$')));

describe('a never-seated satellite entry is refunded, not seated', () => {
  it('is one transaction whose only DDL widens the receipt start authority by one value', () => {
    expect(sql.match(/^BEGIN;$/gm)).toHaveLength(1);
    expect(sql.match(/^COMMIT;$/gm)).toHaveLength(1);
    expect(ddl.match(/ALTER TABLE/g)).toHaveLength(2);
    expect(ddl).toContain('DROP CONSTRAINT tournament_unregistration_actual_start_check');
    expect(ddl).toContain('ADD CONSTRAINT tournament_unregistration_actual_start_check');
    for (const kept of [
      "'spin_actual_start'::text",
      "'heads_up_sng_actual_start'::text",
      "'launch_release'::text",
      "((start_authority = 'scheduled_clock'::text) AND (settled_at < scheduled_start_at))",
    ]) {
      expect(ddl).toContain(kept);
    }
    expect(ddl).toContain("'owner_never_seated_release'::text");
    expect(ddl).not.toMatch(
      /CREATE\s+(OR\s+REPLACE\s+)?FUNCTION|CREATE\s+TABLE|DROP\s+TABLE|DROP\s+FUNCTION/i
    );
    expect(release).not.toMatch(/CREATE\s|ALTER\s|DROP\s|EXECUTE\s/i);
  });

  it('pays only through the exact idempotent refund door, never a hand-written wallet row', () => {
    expect(release).toContain(
      "public.fn_settle_tournament_refund_exact(\n    c_t,c_u,c_club,50,45,0,5,'fn_unregister_from_tournament',c_desc)"
    );
    expect(release).not.toMatch(/UPDATE\s+public\.club_members/i);
    expect(release).not.toMatch(
      /INSERT\s+INTO\s+public\.(wallet_transactions|chip_ledger|club_members)/i
    );
    expect(release).not.toMatch(/fn_credit_and_log|credit_player_wallet|fn_add_chips/);
  });

  it('names exactly one registration, one entitlement and one fee source', () => {
    expect(release).toContain("c_reg      constant uuid := 'd5f1a621-5421-4854-ba65-b930d9a1ad1f'");
    expect(release).toContain("c_ent      constant uuid := 'ea0ff181-47e3-40b7-86c6-1ccade36ec8c'");
    expect(release).toContain("c_fee_src  constant uuid := '1ad31e6e-d57f-4964-a13f-cdd28665cea3'");
    expect(release).toContain('DELETE FROM public.tournament_players WHERE id=c_reg');
    expect(release.match(/DELETE FROM/g)).toHaveLength(1);
  });

  it('refuses unless the entry was never seated and the board is exactly as measured', () => {
    expect(release).toContain("v_reg.status::text<>'registered'");
    expect(release).toContain('v_reg.table_id IS NOT NULL');
    expect(release).toMatch(
      /table_seats s JOIN public\.tables tb[\s\S]*?s\.user_id=c_u\) THEN\s*RAISE EXCEPTION/
    );
    expect(release).toContain("v_t.status::text<>'RUNNING' OR v_t.current_players<>5");
    expect(release).toContain('v_t.prize_pool<>1245');
    expect(release).toContain('v_t.total_rake<>25');
    expect(release).toContain('v_n<>1');
  });

  it('never seats, unseats or moves a stack, and proves no other balance moved', () => {
    expect(release).not.toMatch(
      /INSERT\s+INTO\s+public\.table_seats|UPDATE\s+public\.table_seats/i
    );
    expect(release).not.toMatch(/fn_seat_late_registrant|fn_ca_assign_tournament_player_seat/);
    expect(release).toContain("RAISE EXCEPTION 'ABORT: a live seat moved'");
    expect(release).toContain(
      "RAISE EXCEPTION 'ABORT: a balance other than the refunded wallet moved'"
    );
    expect(release).toContain('v_bal_after IS DISTINCT FROM round(v_bal_before+50,2)');
  });

  it('leaves the event conserved and its fee net plan provable', () => {
    expect(release).toContain('public.fn_ca_tournament_chip_supply(c_t)<>120000');
    expect(release).toContain('public.fn_tournament_conservation_delta(c_t)<>1200');
    expect(release).toContain('public.fn_accounting_tournament_fee_net_plan(c_t)');
    expect(release).toContain("'fn_unregister_from_tournament'");
    expect(release).toContain('INSERT INTO public.tournament_unregistration_receipts');
    expect(release).toContain("v_start_authority text := 'owner_never_seated_release'");
    expect(release).toContain('SET CONSTRAINTS ALL IMMEDIATE');
  });

  it('does nothing on a database without the event or after it was released', () => {
    expect(release).toMatch(
      /IF NOT EXISTS \(SELECT 1 FROM public\.tournaments WHERE id=c_t\) THEN[\s\S]*?RETURN;/
    );
    expect(release).toMatch(
      /tournament_unregistration_receipts r\s+WHERE r\.registration_id=c_reg\) THEN[\s\S]*?RETURN;/
    );
  });
});
