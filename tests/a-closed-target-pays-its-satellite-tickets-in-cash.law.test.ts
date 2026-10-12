import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { classifyChangedPaths } from '../scripts/ci/classify-ci-changes.mjs';

// A SATELLITE SEAT IS SEAT OR CASH (2026-10-12). A direct satellite ticket held
// for a winner at the four-table cap admits its holder to ONE target. When that
// target finalizes its pool, finishes or is cancelled before the ticket is used,
// the ticket can never admit anybody again, and its value was left in ticket
// escrow for ever (928 tickets, 55,120.00, on 2026-10-12). The cash leg of the
// seat_or_cash entitlement now applies in the transaction that closes the
// target. These pins keep that true: the trigger fires on every close, the door
// pays only the ticket's own escrow to its holder exactly once, the guard opens
// only for that door, a close never fails because of a ticket, and horses are
// never filtered out.

const root = (path: string) => resolve(__dirname, '..', path);
const dir = root('supabase/migrations');
const ddlFile = '20261012054804_a_closed_target_pays_its_satellite_tickets_in_cash.sql';
const ddl = readFileSync(`${dir}/${ddlFile}`, 'utf8');
const parts = readdirSync(dir)
  .filter((f) => /^\d{14}_the_stranded_satellite_tickets_are_paid_part_\d\.sql$/.test(f))
  .sort();

const code = (s: string) =>
  s
    .split('\n')
    .map((l) => l.replace(/--.*$/, ''))
    .join('\n');

function fn(sql: string, name: string): string {
  const start = sql.indexOf(`CREATE OR REPLACE FUNCTION public.${name}(`);
  expect(start, name).toBeGreaterThan(-1);
  const open = sql.indexOf('$function$', start);
  const close = sql.indexOf('$function$', open + 10);
  return code(sql.slice(start, close));
}

describe('a closed target pays its satellite tickets in cash', () => {
  it('is one transaction that declares its trigger on the money table', () => {
    expect(ddl.match(/^BEGIN;$/gm)).toHaveLength(1);
    expect(ddl.match(/^COMMIT;$/gm)).toHaveLength(1);
    expect(ddl.trim().endsWith('COMMIT;')).toBe(true);
    expect(ddl).toContain("SET LOCAL lock_timeout = '5s';");
    expect(ddl).toMatch(
      /INSERT INTO public\.ca_declared_money_triggers \(table_name, trigger_name, note\)\nSELECT 'tournaments','zz_closed_target_pays_its_satellite_tickets'/
    );
  });

  it('registers only the actual money writer before CREATE without replacing a prior decision', () => {
    const registry = ddl.indexOf('INSERT INTO public.ca_money_rpc_registry (proname,status,notes)');
    expect(registry).toBeGreaterThan(-1);
    expect(registry).toBeLessThan(
      ddl.indexOf('CREATE OR REPLACE FUNCTION public.fn_ca_pay_closed_target_ticket_in_cash(')
    );
    expect(ddl).toContain("VALUES ('fn_ca_pay_closed_target_ticket_in_cash','approved',");
    expect(ddl).toContain('ON CONFLICT (proname) DO NOTHING;');
    expect(ddl).toContain('CLOSED_TARGET_TICKET_CASH_REGISTRY_CHANGED');
    expect(ddl.match(/INSERT INTO public\.ca_money_rpc_registry/g)).toHaveLength(1);
    const runner = readFileSync(
      root('scripts/ci/test-stranded-satellite-part2-postgres.py'),
      'utf8'
    );
    expect(runner).toContain('tests/fixtures/stranded-satellite-money-registry.json');
    expect(runner).toContain('CREATE EVENT TRIGGER ab_ca_money_rpc_registered');
    expect(runner).toContain(
      'REFUSED: fn_ca_pay_closed_target_ticket_in_cash writes balance columns and is not in ca_money_rpc_registry'
    );
    const capture = JSON.parse(
      readFileSync(root('tests/fixtures/stranded-satellite-money-registry.json'), 'utf8')
    );
    expect(capture.functions.map((row: { md5: string }) => row.md5)).toEqual([
      '53e86c9945bde2a5830232f59a365fdd',
      '03928ac3da782be33306c2e07b0b8977',
      '1b13d12e02c7f7b719fcfae4153dcb1f',
    ]);
    for (const path of [
      'scripts/ci/test-stranded-satellite-part2-postgres.py',
      'tests/fixtures/stranded-satellite-money-registry.json',
    ])
      expect(classifyChangedPaths([path])).toMatchObject({ server: true, tests: true });
  });

  it('fires in the transaction that finalizes, finishes or cancels the target', () => {
    const trigger = code(
      ddl.slice(
        ddl.indexOf('CREATE OR REPLACE TRIGGER zz_closed_target_pays_its_satellite_tickets')
      )
    );
    expect(trigger).toContain('AFTER UPDATE OF status, prize_pool_finalized ON public.tournaments');
    expect(trigger).toContain('FOR EACH ROW');
    expect(trigger).toMatch(
      /NEW\.prize_pool_finalized IS TRUE\s+AND OLD\.prize_pool_finalized IS NOT TRUE/
    );
    for (const s of ['COMPLETING', 'COMPLETED', 'CANCELLED', 'CANCELED']) {
      expect(trigger).toContain(`'${s}'`);
    }
    expect(trigger).toContain(
      'EXECUTE FUNCTION public.trg_ca_closed_target_pays_its_satellite_tickets()'
    );
    const t = fn(ddl, 'trg_ca_closed_target_pays_its_satellite_tickets');
    expect(t).toContain(
      "public.fn_ca_pay_closed_target_tickets_in_cash(\n    NEW.id,'target_entry_closed')"
    );
  });

  it('calls a target closed only when no door can admit its ticket again', () => {
    const closed = fn(ddl, 'fn_ca_satellite_ticket_target_is_closed');
    expect(closed).toContain("('COMPLETING','COMPLETED','CANCELLED','CANCELED')");
    expect(closed).toContain('COALESCE(t.prize_pool_finalized,false)');
    expect(closed).not.toMatch(/late_registration_open|current_level|late_reg/);
  });

  it('pays the ticket escrow to its holder once, in the ticket club, naming no tournament', () => {
    const pay = fn(ddl, 'fn_ca_pay_closed_target_ticket_in_cash');
    expect(pay).toContain("v_key:='ticket:'||v_tk.id::text||':closed-target-cash';");
    expect(pay).toContain('FOR UPDATE;');
    expect(pay).toContain("IF v_tk.status='redeemed' THEN");
    expect(pay).toContain("'replayed',true");
    expect(pay).toContain('v_tk.source_satellite_award_place IS NULL');
    expect(pay).toContain('v_tk.source_refund_entitlement_id IS NOT NULL');
    expect(pay).toContain("'target_still_admits'");
    // the exact award and issue leg it pays back
    expect(pay).toContain("i.idempotency_key=v_award.idempotency_key||':ticket_escrow'");
    // one named leg, escrow -> player wallet, no tournament id, journal stood down
    expect(pay).toContain(
      "public.fn_ca_declare_ledger(\n    'ticket_redeem','escrow',v_tk.id,NULL,v_key,ARRAY['club_members'])"
    );
    expect(pay).toContain(
      "'escrow',v_tk.id,'satellite tournament entry ticket',\n    'player_wallet',v_tk.holder_id"
    );
    expect(pay).toContain("v_tk.value,'ticket_redeem',v_tk.club_id,NULL,");
    expect(pay.match(/INSERT INTO public\.chip_ledger\(/g)).toHaveLength(1);
    expect(pay).toMatch(
      /UPDATE public\.club_members\s+SET chip_balance=round\(COALESCE\(chip_balance,0\)\+v_tk\.value,2\)/
    );
    expect(pay).toContain('WHERE club_id=v_tk.club_id AND user_id=v_tk.holder_id');
    expect(pay).toContain('v_after IS DISTINCT FROM round(v_before+v_tk.value,2)');
    expect(pay).toContain("'tournament_ticket_redeem'");
    // restores the caller's ledger context
    expect(pay).toContain('FOR v_setting IN SELECT jsonb_object_keys(v_context) LOOP');
    // horses are players
    expect(pay).not.toMatch(/is_horse/);
  });

  it('opens the ticket guard for this door alone', () => {
    const guard = fn(ddl, 'fn_ca_satellite_entry_ticket_is_guarded');
    expect(guard).toContain("current_setting('app.ca_closed_target_ticket_cash',true)");
    expect(guard).toContain('v_cash_token=OLD.id');
    expect(guard).toContain(
      'public.fn_ca_satellite_ticket_target_is_closed(\n               OLD.source_tournament_id)'
    );
    expect(guard).toContain("'ticket:'||OLD.id::text||':closed-target-cash'");
    expect(guard).toContain("AND l.to_type='player_wallet'");
    expect(guard).toContain('AND l.amount=OLD.value AND l.club_id=OLD.club_id');
    // the admission branch and every immutability rule are kept
    expect(guard).toContain(
      "'tournament-entry tickets can only be consumed by tournament admission'"
    );
    expect(guard).toContain("'tournament-entry ticket identity and rails are immutable'");
    expect(guard).toContain("'tournament-entry tickets are durable financial evidence'");
  });

  it('never lets one ticket stop a target from closing, and never hides it', () => {
    const loop = fn(ddl, 'fn_ca_pay_closed_target_tickets_in_cash');
    expect(loop).toContain('EXCEPTION WHEN OTHERS THEN');
    expect(loop).toContain("VALUES('critical','fn_ca_pay_closed_target_tickets_in_cash',");
    expect(loop).not.toMatch(/is_horse/);
  });

  it('keeps every new door out of browser reach', () => {
    for (const f of [
      'fn_ca_pay_closed_target_ticket_in_cash(uuid,text)',
      'fn_ca_pay_closed_target_tickets_in_cash(uuid,text)',
      'fn_ca_satellite_ticket_target_is_closed(uuid)',
      'trg_ca_closed_target_pays_its_satellite_tickets()',
    ]) {
      expect(ddl).toContain(
        `REVOKE ALL ON FUNCTION public.${f}\n  FROM PUBLIC, anon, authenticated;`
      );
    }
  });

  it('proves itself on a real stranded ticket and rolls the proof back', () => {
    const a = ddl.indexOf('SAVEPOINT closed_target_ticket_cash_trial;');
    const b = ddl.indexOf('ROLLBACK TO SAVEPOINT closed_target_ticket_cash_trial;');
    expect(a).toBeGreaterThan(-1);
    expect(b).toBeGreaterThan(a);
    expect(ddl.indexOf('CREATE OR REPLACE TRIGGER')).toBeGreaterThan(b);
    expect(ddl.slice(a, b)).toContain('SET CONSTRAINTS ALL IMMEDIATE;');
  });

  it('settles the stranded tickets once, through the same door only', () => {
    expect(parts).toHaveLength(5);
    for (const f of parts) {
      const sql = readFileSync(`${dir}/${f}`, 'utf8');
      const body = code(sql);
      expect(sql).toMatch(/^-- @live-proof: /);
      expect(sql.match(/^BEGIN;$/gm)).toHaveLength(1);
      expect(sql.trim().endsWith('COMMIT;')).toBe(true);
      expect(body).toContain(
        "public.fn_ca_pay_closed_target_ticket_in_cash(v_id,'stranded_ticket_settlement_20261012')"
      );
      expect(body).toContain('STRANDED_TICKET_CASH_RESULT_CHANGED');
      expect(body).not.toMatch(
        /UPDATE\s+public\.club_members|INSERT\s+INTO\s+public\.chip_ledger|CREATE\s|ALTER\s|DROP\s|is_horse/i
      );
    }
  });

  it('covers each adjacent settlement interval without a gap or overlap', () => {
    let previousUpper: string | undefined;
    for (const f of parts) {
      const sql = readFileSync(`${dir}/${f}`, 'utf8');
      const intervals = [...sql.matchAll(/created_at>='([^']+)'\s+AND tk\.created_at<'([^']+)'/g)];
      expect(intervals.length, f).toBeGreaterThan(0);
      const [, lower, upper] = intervals[0];
      expect(Date.parse(lower), f).toBeLessThan(Date.parse(upper));
      if (previousUpper) expect(lower, f).toBe(previousUpper);
      for (const match of intervals) expect(match.slice(1), f).toEqual([lower, upper]);
      previousUpper = upper;
    }
  });

  it('refuses a changed part-2 cohort before payment and runs native CI qualification', () => {
    const sql = readFileSync(`${dir}/${parts[1]}`, 'utf8');
    expect(sql.indexOf('STRANDED_TICKET_CASH_PREIMAGE_CHANGED')).toBeLessThan(
      sql.indexOf('DO $settle$')
    );
    expect(sql).toContain('IF v_count<>190 OR v_amount<>7730.00 THEN');
    const workflow = readFileSync(root('.github/workflows/ci.yml'), 'utf8');
    expect(workflow).toMatch(
      /name: Stranded satellite part 2 keeps its exact cohort\n\s+if: matrix.shard == 4/
    );
    expect(workflow).toContain('run: python3 scripts/ci/test-stranded-satellite-part2-postgres.py');
  });
});
