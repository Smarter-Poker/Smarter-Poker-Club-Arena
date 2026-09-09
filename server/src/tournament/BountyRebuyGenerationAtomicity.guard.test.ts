/**
 * A bounty rebuy may replace a busted entry only after that exact entry
 * generation's bounty is durably complete. The settlement and the replacement
 * remain one database transaction, so a fault cannot leave either half alone.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..', '..');
const MIGRATION = readFileSync(
  path.join(
    ROOT,
    'supabase',
    'migrations',
    '20260909182236_bounty_rebuy_settles_the_old_head_before_the_new_generation.sql'
  ),
  'utf8'
);
const PROBE = readFileSync(
  path.join(ROOT, 'scripts', 'ci', 'probes', 'bounty-rebuy-generation-atomicity.sql'),
  'utf8'
);

const between = (source: string, start: string, end: string): string => {
  const startAt = source.indexOf(start);
  const endAt = source.indexOf(end, startAt + start.length);
  expect(startAt, `${start} must exist`).toBeGreaterThan(-1);
  expect(endAt, `${end} must follow ${start}`).toBeGreaterThan(startAt);
  return source.slice(startAt, endAt);
};

const HELPER = between(
  MIGRATION,
  'CREATE OR REPLACE FUNCTION public.fn_ca_settle_bounty_rebuy_generation_v1(',
  '$bounty_rebuy_generation$;'
);
const INSTALL = between(
  MIGRATION,
  'DO $install_atomic_bounty_rebuy$',
  '$install_atomic_bounty_rebuy$;'
);
const VERIFY = between(
  MIGRATION,
  'DO $verify_atomic_bounty_rebuy$',
  '$verify_atomic_bounty_rebuy$;'
);
const LEDGER_TRIGGER = between(
  MIGRATION,
  'CREATE OR REPLACE FUNCTION public.fn_attach_bounty_ledger_obligation()',
  '$attach_bounty_ledger_generation$;'
);

describe('bounty rebuy generation atomicity', () => {
  it('installs one forward transaction and leaves no callable side authority', () => {
    expect(MIGRATION).toMatch(/\bBEGIN;[\s\S]*\bCOMMIT;\s*$/);
    expect(MIGRATION).toContain("SET LOCAL lock_timeout = '250ms'");
    expect(MIGRATION).toMatch(
      /REVOKE ALL ON FUNCTION\s+public\.fn_ca_settle_bounty_rebuy_generation_v1\(uuid,uuid,uuid\)\s+FROM PUBLIC,anon,authenticated,service_role;/
    );
    expect(MIGRATION).not.toMatch(
      /\b(?:cron\.|pg_cron|CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+public\.(?:[^\s(]*(?:watch|sweep|reconcil|repair)))/i
    );
  });

  it('binds the payout to the latest exact accepted-hand and seat generation', () => {
    expect(HELPER).toContain('fn_ca_latest_committed_knockout_candidate');
    expect(HELPER).toContain('o.table_id=v_candidate.table_id');
    expect(HELPER).toContain('o.hand_id=v_candidate.hand_id');
    expect(HELPER).toContain('o.hand_number=v_candidate.hand_number');
    expect(HELPER).toContain('o.seat_joined_at=v_candidate.seat_joined_at');
    expect(HELPER).toContain("v_candidate.state NOT IN ('pending','eliminated')");
    expect(HELPER).toContain("v_candidate.state<>'pending'");
    expect(HELPER).toContain("v_player.status::text<>'playing'");
    expect(HELPER).toContain('v_candidate.rebuy_prompt_until<=clock_timestamp()');
    expect(HELPER).not.toMatch(/ORDER BY\s+\(c\.state='pending'\)\s+DESC/);
  });

  it('uses the one-use seat-exit capability without weakening the open-window guard', () => {
    const openAt = HELPER.indexOf('fn_ca_open_tournament_seat_exit_authority');
    const claimAt = HELPER.indexOf('fn_claim_bounty_legacy_candidate_20260907');
    const closeAt = HELPER.indexOf('fn_ca_close_tournament_seat_exit_authority');
    expect(openAt).toBeGreaterThan(-1);
    expect(claimAt).toBeGreaterThan(openAt);
    expect(closeAt).toBeGreaterThan(claimAt);
    expect(HELPER).not.toContain('fn_claim_tournament_bounty_elimination');
    expect(HELPER).not.toMatch(/rebuy_prompt_until\s*:=|SET\s+rebuy_prompt_until/i);
  });

  it('settles each bounty mode and requires its complete marker before retiring the head', () => {
    expect(HELPER).toContain('fn_collect_bounty_obligation');
    expect(HELPER).toContain("v_obligation.mode='mystery_chest'");
    expect(HELPER).toContain('fn_mystery_bounty_reserve');
    expect(HELPER).toContain('fn_mystery_bounty_pay');
    const markerAt = HELPER.lastIndexOf('fn_bounty_obligation_has_complete_marker');
    const clearAt = HELPER.indexOf('SET current_bounty=0');
    expect(markerAt).toBeGreaterThan(-1);
    expect(clearAt).toBeGreaterThan(markerAt);
    expect(HELPER).toContain('round(v_obligation.head_amount,2)');
    expect(HELPER).toContain('Bounty rebuy old head changed before retirement');
  });

  it('admits mystery ledger rows only through their exact mystery obligation', () => {
    expect(LEDGER_TRIGGER).toContain('v_is_mystery boolean');
    expect(LEDGER_TRIGGER).toContain('o.id=v_obligation_id');
    expect(LEDGER_TRIGGER).toContain('o.tournament_id=NEW.tournament_id');
    expect(LEDGER_TRIGGER).toContain('o.eliminated_user_id=NEW.eliminated_player_id');
    expect(LEDGER_TRIGGER).toContain("v_is_mystery AND o.mode='mystery_chest'");
    expect(LEDGER_TRIGGER).toContain("NOT v_is_mystery AND o.mode<>'mystery_chest'");
    expect(MIGRATION).toMatch(
      /INSERT INTO public\.ca_settle_sources\(source,note\) VALUES\(\s*'fn_collect_bounty'/
    );
  });

  it('replaces the circular check with settlement, then retains the strict proof', () => {
    const helperAt = INSTALL.indexOf('fn_ca_settle_bounty_rebuy_generation_v1');
    expect(helperAt).toBeGreaterThan(-1);
    expect(INSTALL).toContain(
      'Bounty Settlement Pending - Rebuy Or Re-Entry Cannot Replace This Entry Generation Yet'
    );
    expect(INSTALL).toContain('public.fn_bounty_obligation_has_complete_marker(o.id)');
    expect(INSTALL).toContain("v_response->>'bounty_head_funded'");
    expect(INSTALL).toContain("'prior_bounty_obligation_id',v_bounty_obligation_id");
    expect(INSTALL).toContain("'prior_bounty_marker_verified'");
    expect(VERIFY).toContain('v_bounty_tail:=substring(');
    expect(VERIFY).toContain(
      "position('fn_ca_process_tournament_chip_purchase_money_v1' IN v_bounty_tail)"
    );
    expect(VERIFY).toContain(
      "position('UPDATE public.tournament_knockout_candidates c' IN v_bounty_tail)"
    );
    expect(VERIFY).toContain(
      'Bounty rebuy authority order is not payout then purchase then generation'
    );
  });

  it('proves fixed bounty, PKO, and mystery success plus two fail-closed paths', () => {
    expect(PROBE).toContain('Atomic Standard Bounty Rebuy Probe');
    expect(PROBE).toContain('Atomic PKO Rebuy Probe');
    expect(PROBE).toContain('Atomic Mystery Bounty Rebuy Probe');
    expect(PROBE).toContain('CREATE FUNCTION pg_temp.bounty_rebuy_state');
    expect(PROBE).toContain('candidate hand did not commit a zero stack');
    expect(PROBE).toContain("USING ERRCODE='ZX921'");
    expect(PROBE).toContain('AUDIT_TEST_PASS: bounty, PKO, and mystery rebuy');
    expect(PROBE.match(/public\.process_tournament_rebuy\(/g)?.length ?? 0).toBeGreaterThanOrEqual(
      8
    );
    expect(PROBE.match(/pg_temp\.bounty_rebuy_state\(/g)?.length ?? 0).toBeGreaterThanOrEqual(5);
  });

  it('does not import settlement semantics from unrelated tournament products', () => {
    for (const source of [MIGRATION, PROBE]) {
      expect(source).not.toMatch(/fn_[a-z0-9_]*(?:satellite|heads_up|spin)/i);
      expect(source).not.toMatch(
        /(?:satellite|heads_up|spin)_(?:award|entry|payout|reserve|settlement|tournament)/i
      );
      expect(source).not.toMatch(/daily challenges?/i);
    }
  });
});
