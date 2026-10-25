/**
 * LIGHTNING PHASE 11 REMEDIATION: THE MATCHER PARITY HARNESS, READ STATICALLY.
 *
 * scripts/dev/test-lightning-matcher-parity.sh proves on PostgreSQL 17 that
 * the engine's TypeScript port of the live matcher (`m1-port`, `m1`) decides
 * exactly what the real fn_lightning_match_plan decides on the same
 * snapshot. This file pins that the harness keeps doing so: the real chain
 * through 20261009151825 on the grounds the earlier harnesses prove, humans
 * and horses, every fixture the review named, the real plan captured in one
 * statement with its snapshot, the TypeScript check run on it and required
 * to cover every fixture and group, the pre-remediation port shown to
 * differ, the CI step on shard 3 after the Phase 12 load step, and the
 * changelog.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(__dirname, '..');
const read = (...p: string[]) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');
const HARNESS = read('scripts', 'dev', 'test-lightning-matcher-parity.sh');
const CHECK = read('server', 'src', 'lightning', '__tests__', 'lightningMatcherParity.ts');
const MODEL = read('server', 'src', 'lightning', 'LightningMatcherModel.ts');
const CI = read('.github', 'workflows', 'ci.yml');
const CHANGELOG = read('docs', 'changelog', '2026-10-09-lightning-phase-11-remediation-engine.md');
/** The harness with its shell comments removed. */
const HCODE = HARNESS.split('\n')
  .filter((l) => !/^\s*#/.test(l))
  .join('\n');

describe('the parity harness', () => {
  it('builds the real chain through 20261009151825 on the proven grounds, on its own port', () => {
    expect(HCODE).toContain('port=${LIGHTNING_PARITY_PORT:-55563}');
    for (const f of [
      '20261008161509_lightning_phase_11_integrity_telemetry_and_the_shadow_matche.sql',
      '20261009143757_lightning_phase_12_responsible_gaming_limits_and_auto_rebuy_.sql',
      '20261009144343_lightning_phase_12_operator_dashboard_and_alerting.sql',
      '20261009151825_lightning_phase_12_load_chaos_the_pass_forms_under_surge.sql',
    ])
      expect(HCODE, f).toContain(f);
    for (const h of [
      'test-lightning-phase11-integrity-shadow.sh',
      'test-lightning-phase12-operator-alerts.sh',
      'test-lightning-phase12-load-chaos.sh',
    ])
      expect(HCODE, h).toContain(h);
    expect(HCODE).toContain("grep -q 'CREATE EVENT TRIGGER trg_autorevoke_privileged_anon'");
    expect(HCODE).toContain('-f "$p12ops" -f "$p12lc"');
  });

  it('builds every fixture the review named, humans and horses at each, from real passes', () => {
    for (const s of [
      '02 TIES',
      '03 DEBT',
      '04 LARGE',
      '05 NINE',
      '06 FIRST ENTRY',
      '07 THIN',
      '08 ONE INSTANT',
      '09 A NEW EPOCH',
    ])
      expect(HCODE, s).toContain(`\\echo '  ok  ${s}`);
    expect(HCODE).toContain(
      'public.fn_lightning_match_and_form(p_game, clock_timestamp(), NULL, NULL, gen_random_uuid())'
    );
    expect(HCODE).toContain('public.fn_lightning_form_hand(p_game, p_players,');
    expect(HCODE).toContain('harness.settle(p_hand,');
    expect(HCODE).toContain('pp.horses(v_g) = 0');
    expect(HCODE).toContain('FIRST_ENTRY_WAITS_FOR_BB');
    expect(HCODE).toContain('pp.moved(p) = 0');
    for (const band of ["'thin'", "'medium'", "'large'"]) expect(HCODE).toContain(band);
    expect(HCODE).toContain('fn_cash_cluster_commit_must_move(v_g, v_req)');
  });

  it('captures the snapshot and the real plan in one statement, from the legality door itself', () => {
    const capture = HCODE.slice(
      HCODE.indexOf('CREATE FUNCTION pp.capture'),
      HCODE.indexOf('-- Facts of a plan.')
    );
    expect(capture).toContain(
      'FROM public.fn_lightning_player_legality(p_game, v_now, NULL, NULL) l'
    );
    expect(capture).toContain(
      "'plan', public.fn_lightning_match_plan(p_game, v_now, NULL, NULL, NULL, NULL))"
    );
    for (const k of [
      'idle_since_us',
      'entered_at_us',
      'joined_at_us',
      'slot_opened_us',
      'last_bb_at_us',
      'debt_since_us',
    ])
      expect(capture, k).toContain(`'${k}'`);
    expect(capture).toContain("'hand_id', h.hand_id");
    expect(capture).toContain("'epoch', h.cluster_epoch");
  });

  it('runs the TypeScript port on it and requires every fixture and group, and a discriminating fixture', () => {
    expect(HCODE).toContain('node --import tsx src/lightning/__tests__/lightningMatcherParity.ts');
    expect(HCODE).toContain('grep -q "^PARITY $n fixtures $groups groups identical"');
    expect(HCODE).toContain("grep -q '^DISCRIMINATES '");
    expect(CHECK).toContain("for (const version of ['m1-port', 'm1'])");
    for (const k of ['seats', ' bb ', ' sb ', ' btn ', 'legal_count', 'pool_diversity_score'])
      expect(CHECK, k).toContain(k);
  });

  it('compares the current port only after the complete source-admitted five/six policy, preserving independent fairness inputs', () => {
    const preimage = HCODE.indexOf('-f "$F/lightning-five-ready-preimages.sql"');
    const policy = HCODE.indexOf(
      '-f "$M/20261023230001_classic_and_lightning_five_ready_waits_three_seconds_for_six.sql"'
    );
    const firstEntry = HCODE.indexOf(
      '-f "$M/20261024195059_lightning_new_players_are_always_the_big_blind_first.sql"'
    );
    const current = HCODE.indexOf('-f "$F/lightning-current-policy-parity.sql"');
    const comparison = HCODE.indexOf(
      'node --import tsx src/lightning/__tests__/lightningMatcherParity.ts'
    );
    expect(preimage).toBeGreaterThan(HCODE.indexOf("grep '^  ok  11'"));
    expect(policy).toBeGreaterThan(preimage);
    // New players are always the big blind first (20261024195059): today's
    // port is compared with today's SQL rule, installed on the same preimages.
    expect(firstEntry).toBeGreaterThan(policy);
    // A seat the conversion made is not a newcomer (20261024213844), after it.
    const conversionSeat = HCODE.indexOf(
      '-f "$M/20261024213844_lightning_conversion_seats_are_not_newcomers_and_a_newcomer_.sql"'
    );
    expect(conversionSeat).toBeGreaterThan(firstEntry);
    expect(current).toBeGreaterThan(conversionSeat);
    expect(HCODE).toContain('grep \'^  ok  13\' "$fixture/current-policy.out"');
    expect(comparison).toBeGreaterThan(current);
    const fixture = read('scripts', 'dev', 'fixtures', 'lightning-current-policy-parity.sql');
    expect(fixture).toContain('FOR f IN SELECT * FROM pp.out ORDER BY n LOOP');
    expect(fixture).toContain(
      "result->>'legal_count' IS DISTINCT FROM f.doc#>>'{plan,legal_count}'"
    );
    expect(fixture).toContain('public.fn_lightning_match(g,to_timestamp');
    expect(fixture).toContain("jsonb_array_length(members->'players') NOT BETWEEN 5 AND 6");
    expect(fixture).not.toMatch(/UPDATE\s+(?:public\.)?lightning_matcher_shadow_comparison/i);
    // The port reads the database's `newcomer`, so every fixture's flag is the
    // real snapshot's, and a fresh conversion is captured as its own fixture.
    expect(fixture).toContain('PERFORM pp.refresh_newcomer(f.n);');
    expect(fixture).toContain('public.fn_lightning_matcher_snapshot(g, to_timestamp(');
    expect(fixture).toContain(
      "lc.build('parity', 'CONVERSION', 6, 24, 1, 'nlh', '{}'::jsonb, false)"
    );
  });

  it('never reads a horse marker (Law 10.5)', () => {
    for (const src of [CHECK, MODEL]) expect(src).not.toMatch(/is_horse|horse_id|isHorse/);
    const sqlOnly = HCODE.split('\n').filter(
      (l) => !l.includes('pp.horses') && !l.includes('ts.horse_id IS NOT NULL')
    );
    expect(sqlOnly.join('\n')).not.toMatch(/\bis_horse\b/);
  });
});

describe('CI and the changelog', () => {
  it('CI runs the harness on shard 3, after the Phase 12 load step', () => {
    const lc = CI.indexOf('test-lightning-phase12-load-chaos.sh');
    const at = CI.indexOf('test-lightning-matcher-parity.sh');
    expect(lc).toBeGreaterThan(0);
    expect(at).toBeGreaterThan(lc);
    const step = CI.slice(CI.lastIndexOf('- name:', at), at);
    expect(step).toContain('if: matrix.shard == 3');
    expect(step).toContain('PG_BIN: /usr/lib/postgresql/17/bin');
  });

  it('the changelog carries the parity result and the corrected simulator table, in title case, without an em dash', () => {
    expect(CHANGELOG).toContain('test-lightning-matcher-parity.sh');
    expect(CHANGELOG).toContain('Avg Wait (s)');
    expect(CHANGELOG).not.toContain('—');
    const small = [
      'a',
      'an',
      'and',
      'the',
      'of',
      'to',
      'in',
      'on',
      'or',
      'by',
      'at',
      'for',
      'is',
      'its',
      'with',
      'per',
    ];
    for (const h of CHANGELOG.match(/^#{1,3} .+$/gm) ?? []) {
      for (const w of h.replace(/^#+ /, '').split(/\s+/)) {
        if (/^[a-z]/.test(w) && !small.includes(w))
          throw new Error(`heading word not in title case: ${w} in ${h}`);
      }
    }
  });
});
