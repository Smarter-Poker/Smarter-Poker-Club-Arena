/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  A SATELLITE SEATS A BOUNTY TARGET LIKE A PAID ENTRY (2026-10-16)
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Dan, 2026-10-16: "EVERY TOURNAMENT WITH A 25 BUY IN OR HIGHER SHOULD HAVE
 * SATELLITES INTO IT." Until migration 20261017004440 a satellite could not
 * feed a bounty, PKO or mystery-bounty event: both settlement authorities
 * refused the target ("uses an unsupported bounty or Spin entry split") and
 * every creation path refused to open the satellite. The refusal existed for a
 * reason that is still binding. On 2026-09-04 the satellite seat path booked
 * the whole 67.50 of each PKO seat as PRIZE and trg_seed_bounty_head raised
 * the bounty pool by a 35.00 head nobody had paid for, so the 66-entrant
 * Sunday Funday High Roller PKO handed its field 4,455.00 against an
 * advertised 5,810.00.
 *
 * THE LAW. A satellite seat into a bounty target is a paid entry, split by the
 * same fn_tournament_entry_split the paid door uses: prize = buy-in - bounty
 * to the prize ladder, the bounty slice to the bounty rail as a FUNDED head on
 * the seat row, the fee to the fee rail. The target's counters and its escrow
 * move by exactly that split, the seat's refund entitlement returns exactly
 * that split, and a capped winner's noncash ticket carries it. A target whose
 * split cannot be known is still refused by name: a Spin, a premium Spin,
 * unknown (NULL) flags, a bounty larger than the buy-in, and a Diamond bounty
 * event (the Diamond seat transfer has no bounty part).
 *
 * WHAT MUST NOT HAPPEN TO THIS LAW. The cheap ways to "fix" a red PKO
 * settlement are both forbidden: re-adding the refusal (the owner ruled every
 * event at 25 or more gets satellites), and seating the winner without the
 * split (the 2026-09-04 shortfall). The executed proof is
 * scripts/ci/test-satellite-bounty-seat-split.py, which runs the migration's
 * own postimages end to end on PostgreSQL 17 and ends the 66-entrant PKO
 * funded at exactly 5,810.00.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();
const DIR = join(ROOT, 'supabase/migrations');
const FILE = '20261017004440_satellites_seat_bounty_targets.sql';
const SQL = readFileSync(join(DIR, FILE), 'utf8');
const RECURRING = readFileSync(
  join(ROOT, 'server/src/services/TournamentRecurringService.ts'),
  'utf8'
);
const HARNESS = readFileSync(join(ROOT, 'scripts/ci/test-satellite-bounty-seat-split.py'), 'utf8');
const CI = readFileSync(join(ROOT, '.github/workflows/ci.yml'), 'utf8');

/** The shipped text of one function: its CREATE through its closing tag. */
const body = (name: string): string => {
  const start = SQL.indexOf(`CREATE OR REPLACE FUNCTION public.${name}(`);
  expect(start, `${name} is not in the migration`).toBeGreaterThan(-1);
  const end = SQL.indexOf('$function$;', start);
  expect(end, `${name} has no closing tag`).toBeGreaterThan(start);
  return SQL.slice(start, end);
};

const AUTHORITIES = [
  'fn_settle_satellite_tournament_pre_money_path_gate',
  'fn_ca_settle_satellite_cohort',
];
const RECEIPTS = ['fn_ca_satellite_settlement_receipt', 'fn_ca_satellite_cohort_receipt'];

describe('a satellite seats a bounty target like a paid entry', () => {
  it("splits the seat with the paid door's own function", () => {
    for (const name of AUTHORITIES) {
      const src = body(name);
      expect(src).not.toContain('uses an unsupported bounty or Spin entry split');
      expect(src).toMatch(
        /FROM public\.fn_tournament_entry_split\(\s*v_target_buy_in, v_target_fee, v_target\.bounty_amount,\s*v_target_is_bounty\) s;/
      );
      expect(src).toContain(
        'v_target_is_bounty := v_target.is_bounty OR v_target.is_pko\n                        OR v_target.is_mystery_bounty;'
      );
    }
  });

  it('seeds a FUNDED head on the seat row, so the seed trigger never books an unpaid one', () => {
    for (const name of AUTHORITIES) {
      const src = body(name);
      expect(src).toContain('true, p_tournament_id, v_entry_bounty, 0, 0, 0)');
      expect(src).toContain('current_bounty, mystery_bounty_value, bounties_collected,');
    }
  });

  it('names the split on the transfer leg and the fee row, the rail the escrow books from', () => {
    for (const name of AUTHORITIES) {
      const src = body(name);
      expect(src).toMatch(
        /'entry_split_version', 2,\s*'entry_prize', v_entry_prize,\s*'entry_bounty', v_entry_bounty,\s*'entry_fee', v_target_fee\)/
      );
      expect(src).toContain("THEN jsonb_build_object('entry_split_version', 2)");
    }
  });

  it('moves the target counters and proves the escrow moved by exactly the split', () => {
    for (const name of AUTHORITIES) {
      const src = body(name);
      expect(src).toContain('+ v_seat_count * v_entry_prize, 2),');
      expect(src).toContain('bounty_pool = CASE WHEN v_entry_bounty > 0');
      expect(src).toContain('round(v_target_escrow.bounty_in + v_seat_count * v_entry_bounty, 2)');
      expect(src).toContain(
        'round(v_target_escrow.bounty_balance + v_seat_count * v_entry_bounty, 2)'
      );
      expect(src).toContain('THEN v_seat_count * (v_entry_prize + v_entry_bounty)');
      // A running PKO's bank is its pool less what knockouts already paid.
      expect(src).toContain('- COALESCE(v_target.bounty_pool_paid, 0), 2)');
      expect(src).not.toContain('OR v_target_escrow.bounty_balance IS DISTINCT FROM 0::numeric');
    }
  });

  it('still refuses every target whose split cannot be known, by name', () => {
    for (const name of AUTHORITIES) {
      const src = body(name);
      for (const flag of ['is_bounty', 'is_pko', 'is_mystery_bounty']) {
        expect(src).toContain(`v_target.${flag} IS NULL`);
      }
      expect(src).toContain('v_target.is_premium_spin IS DISTINCT FROM false');
      expect(src).toContain("lower(COALESCE(v_target.variant,'')) = 'spin'");
      expect(src).toContain('uses an unsupported Spin or unknown entry split');
      expect(src).toContain('IF v_target_is_bounty AND v_diamond THEN');
      expect(src).toContain('has a misconfigured bounty split');
    }
  });

  it('refunds and replays a bounty seat by its exact split', () => {
    const capture = body('fn_ca_capture_satellite_seat_entitlement');
    expect(capture).toContain("IF v_l.metadata->>'entry_split_version' = '2' THEN");
    expect(capture).toContain("v_bucket := 'satellite_gross';");
    expect(capture).toContain('v_l.club_id,NEW.amount,v_prize,v_bounty,v_h.target_fee,');
    for (const name of RECEIPTS) {
      const src = body(name);
      expect(src).not.toContain('OR COALESCE(v_target.bounty_amount,0) <> 0');
      expect(src).toContain('OR tk.entry_bounty IS DISTINCT FROM v_entry_bounty');
      expect(src).toContain("(CASE WHEN v_entry_bounty > 0 THEN '2' END)");
      expect(src).toContain('OR (v_diamond AND v_entry_bounty <> 0)');
    }
    for (const name of [
      'fn_ca_register_for_tournament_with_ticket_for',
      'fn_ca_find_tournament_entry_ticket_for',
    ]) {
      const src = body(name);
      expect(src).toContain('entry_prize+');
      expect(src).not.toMatch(/AND (v_ticket|tk)\.entry_bounty=0\n/);
    }
  });

  it('opens a satellite into a bounty target in the database and in the engine', () => {
    const deliverable = body('fn_satellite_target_is_deliverable');
    expect(deliverable).toContain('t.is_bounty IS NOT NULL');
    expect(deliverable).toContain('OR NOT public.fn_poker_diamond_tournament(t.id))');
    const accepts = body('fn_ca_satellite_target_accepts_new_feeder');
    expect(accepts).toContain("NOT IN ('satellite','spin')");
    const guard = body('fn_ca_guard_new_satellite_target');
    expect(guard).toContain(
      "IF TG_OP='UPDATE' AND (NOT v_supported_target OR v_target IS NOT NULL"
    );
    // The source rule is unchanged: a satellite is never itself a bounty event.
    expect(guard).toContain('SATELLITE_NEW_SOURCE_UNSUPPORTED');
    const ts = RECURRING.slice(RECURRING.indexOf('export function satelliteTargetIsDeliverable('));
    const predicate = ts.slice(0, ts.indexOf('\n}\n'));
    expect(predicate).toContain("typeof flag !== 'boolean'");
    expect(predicate).not.toContain("variant === 'progressive_bounty'");
    // The engine refuses a Diamond (or unread-host) bounty target, as the
    // database does, so it never opens a feeder the insert would refuse.
    expect(predicate).toContain('row.diamond_host !== false');
    // A late ticket seat into a running bounty event compares the bank with
    // its pool less what knockouts have paid, as both settlement authorities do.
    expect(body('fn_ca_register_for_tournament_with_ticket_for')).toContain(
      'round(COALESCE(v_t.bounty_pool,0)-COALESCE(v_t.bounty_pool_paid,0),2)'
    );
    expect(RECURRING).toContain('export function satelliteSourceIsSupported(');
  });

  it('keeps the 2026-10-17 capped-winner repair in both authorities', () => {
    // 20261017033733 changed both authorities after this migration was first
    // built; its postimages are derived from that production text, so they
    // must still carry both of its rules rather than restoring the older one.
    for (const name of AUTHORITIES) {
      const src = body(name);
      expect(src).toContain('THE DYING SATELLITE IS NOT A GAME (2026-10-17)');
      expect(src).toContain('A CAPPED DIAMOND WINNER IS PAID, NOT HELD (2026-10-17)');
    }
  });

  it('ships as one guarded transaction that declares every postimage', () => {
    expect(SQL).toMatch(/\nBEGIN;\nSET LOCAL lock_timeout = '5s';/);
    expect(SQL.trimEnd().endsWith('COMMIT;')).toBe(true);
    expect(SQL.match(/^BEGIN;$/gm)?.length).toBe(1);
    expect(SQL).toContain('SATELLITE_BOUNTY_TARGET_PREIMAGE_CHANGED');
    expect(SQL).toContain('SATELLITE_BOUNTY_TARGET_POSTIMAGE_CHANGED');
    const creates = [...SQL.matchAll(/^CREATE OR REPLACE FUNCTION public\.(\w+)\(/gm)].map(
      (m) => m[1]
    );
    const proofs = [
      ...SQL.matchAll(/^-- @live-proof: md5\(pg_get_functiondef\('public\.(\w+)\(/gm),
    ].map((m) => m[1]);
    expect(creates.length).toBe(11);
    expect([...proofs].sort()).toEqual([...creates].sort());
    // No function gains a caller: every grant is restated and proved exact.
    expect(SQL).toContain('SATELLITE_BOUNTY_TARGET_ACL_CHANGED');
    for (const name of creates) {
      expect(SQL).toMatch(
        new RegExp(
          `^REVOKE ALL ON FUNCTION public\\.${name}\\([^)]*\\) FROM PUBLIC, anon, authenticated`,
          'm'
        )
      );
    }
    expect(SQL).not.toMatch(/GRANT EXECUTE ON FUNCTION [^;]* TO (anon|authenticated|PUBLIC)/);
  });

  it('is executed on PostgreSQL 17 in CI, to the funded 5,810.00', () => {
    expect(HARNESS).toContain(FILE);
    expect(HARNESS).toContain("'GREEN-the-field-is-funded-at-exactly-5810.00'");
    expect(HARNESS).toContain("'GREEN-no-unfunded-bounty-head-was-seeded'");
    expect(CI).toContain('run: python3 -B scripts/ci/test-satellite-bounty-seat-split.py');
  });

  it('no later migration puts the refusal back', () => {
    const later = readdirSync(DIR)
      .filter((f) => f.endsWith('.sql') && f > FILE)
      .sort();
    for (const f of later) {
      expect(readFileSync(join(DIR, f), 'utf8'), f).not.toContain(
        'uses an unsupported bounty or Spin entry split'
      );
    }
  });
});

describe('the bounty events of 25 or more are fed by satellites', () => {
  const file = readdirSync(DIR).find((f) => f.endsWith('_satellites_into_the_bounty_events.sql'));
  const sql = readFileSync(join(DIR, file ?? ''), 'utf8');
  const rows = [
    ...sql.matchAll(/^\s+\('([^']+)', '([^']+)', ARRAY\[([^\]]*)\], ARRAY\[([^\]]+)\]/gm),
  ];

  it('opens a satellite into every bounty, PKO and mystery event of 25 or more', () => {
    expect(file, 'the satellite schedule migration').toBeTruthy();
    const targets = new Set(rows.map((m) => m[2]));
    for (const t of [
      'Union Mystery Bounty (PLO5)',
      'Union Grand Championship (NLH)',
      'Monday Knockout',
      'Tuesday Bounty Hunt',
      'Friday Five-Card Bounty',
      'Friday Fight Night PKO',
      'Saturday Mystery',
      'Saturday Stackfest PKO',
      'Sunday Funday Bounty Builder',
      'Sunday Funday PLO PKO',
      'Sunday Funday PLO5 Mystery',
      'Sunday Funday Mystery',
      'Sunday Funday Late PKO',
      'Sunday Funday High Roller PKO',
      'Sunday Funday Night Owl',
    ])
      expect(targets.has(t), t).toBe(true);
    expect(rows.length).toBe(15);
  });

  it('starts every one on a :15 or :45, never named like its target', () => {
    for (const m of rows) {
      expect(m[1].startsWith(m[2]), m[1]).toBe(false);
      for (const t of m[4].split(',').map((x) => x.trim().replace(/'/g, '')))
        expect(['15', '45'], `${m[1]} at ${t}`).toContain(t.slice(3));
    }
    // The database proves it too, across every Midway satellite.
    expect(sql).toContain("right(t, 2) NOT IN ('15', '45')");
    expect(sql).toContain('doubled satellite starts');
  });

  it('feeds the Midway Union only, never a Diamond bounty event', () => {
    expect(sql).toContain('SELECT c_midway, c_midway, sat.name');
    expect(sql).not.toContain('c_arena');
  });
});
