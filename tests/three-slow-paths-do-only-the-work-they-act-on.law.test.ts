/**
 * ===========================================================================
 *  LAW - THREE SLOW PATHS DO ONLY THE WORK THEY ACT ON
 * ===========================================================================
 *
 * Measured on production 2026-10-01 (docs/changelog/2026-10-01-three-slow-
 * paths-do-only-the-work-they-act-on.md):
 *
 *   atomic_table_buyin   7,269 ms mean, ~23 statement timeouts per 10 min.
 *                        The buy-in refused on career_vpip only, yet paid for
 *                        fn_nit_check's maintain branch: a scan of the player's
 *                        whole hand history in the game (14.65 s, 8,767 reads
 *                        for one horse). A rolled-back probe bought the same
 *                        fixture through the old and new gate: identical rows
 *                        and an identical write set across 14 tables,
 *                        49,130 ms cold -> 138 ms.
 *   the outbox drain     41% of its time waiting on a player key held by
 *                        fn_ca_horse_claim_due, 21% flushing WAL per player.
 *   ca_club_data_snapshot ordered tournaments DESC NULLS LAST, which no index
 *                        yields, so it sorted all 299,393 every call.
 *
 * Migration 20261001010106 changes each by asserted substitution over pinned
 * live text. This law pins that the buy-in asks only the career rule - the
 * same statement fn_nit_check runs - that the drain skips a held player instead
 * of waiting and books each player without an fsync, that the snapshot's order
 * is one an index can produce, and that nothing here touches a timeout or a
 * horse.
 */
import { describe, expect, it } from 'vitest';
import { migrationNames, migrationText } from './helpers/migrationCorpus';
import { sliceBetween } from './helpers/sourceWindow';

const NAME = migrationNames()
  .filter((n) => n.endsWith('_three_slow_paths_do_only_the_work_they_act_on.sql'))
  .at(-1);
if (!NAME) throw new Error('the three-slow-paths migration is missing');
const MIG = migrationText(NAME);
const SUBS = sliceBetween(MIG, 'DO $subs$', 'END $subs$;');
const CAREER_FN = sliceBetween(
  MIG,
  'CREATE OR REPLACE FUNCTION public.fn_nit_career_check',
  '$function$;'
);

const squash = (s: string): string => s.replace(/\s+/g, ' ').trim();

/** fn_nit_check's career block as last defined before this migration. */
const nitCheckCareerBlock = (): string => {
  const defining = migrationNames()
    .filter((n) => n < NAME)
    .filter((n) => /CREATE OR REPLACE FUNCTION public\.fn_nit_check\(/.test(migrationText(n)))
    .at(-1);
  if (!defining) throw new Error('no migration defines fn_nit_check');
  const body = sliceBetween(
    migrationText(defining),
    'CREATE OR REPLACE FUNCTION public.fn_nit_check(',
    '$function$;'
  );
  return sliceBetween(body, '  -- CAREER', '  -- MAINTAIN');
};

const PINS: Array<[string, string, string]> = [
  [
    'atomic_table_buyin_before_maintenance_announcement_gate(uuid,uuid,integer,numeric,boolean,uuid,uuid)',
    'b329fed556008cf1a9a4b8fe7727ac9e',
    '0bea051bd3b92d3c42ab870f6fad02b4',
  ],
  [
    'fn_drain_daily_challenge_event_outbox_user(uuid,integer)',
    '7f0038702980eef5f59dba244a398072',
    '1f9a8c14027257664a61830770854b0b',
  ],
  [
    'sp_drain_daily_challenge_event_outbox(integer,integer,integer)',
    '01561e0421d24ae15ca4c64b7b3561b0',
    '61635cfbedf05addc77a53c781963b68',
  ],
  [
    'fn_ca_club_game_rows(uuid,date,date,text,text,text,integer)',
    'e0c899aef84c77ed8ab8a2832a832775',
    '97180802749f9963f8e973f740e84bb1',
  ],
];

describe('law: three slow paths do only the work they act on', () => {
  it('is one transaction, with its only concurrent index built before it', () => {
    expect(MIG.match(/^BEGIN;$/gm)).toHaveLength(1);
    expect(MIG.match(/^COMMIT;$/gm)).toHaveLength(1);
    const beforeBegin = MIG.slice(0, MIG.indexOf('\nBEGIN;'));
    expect(beforeBegin).toContain(
      'CREATE INDEX CONCURRENTLY IF NOT EXISTS ca_club_tournament_daily_club_day_cover_idx'
    );
    expect(MIG.slice(MIG.indexOf('\nBEGIN;'))).not.toMatch(/CONCURRENTLY/);
    expect(MIG).toMatch(/SET LOCAL lock_timeout = '2s';/);
  });

  it('changes no timeout a role runs under and touches no horse', () => {
    expect(MIG).not.toMatch(/ALTER ROLE/i);
    expect(MIG).not.toMatch(/set_config\(\s*'statement_timeout'/);
    expect(MIG).not.toMatch(/is_horse/);
  });

  it('substitutes only over md5-pinned live text, once each, reversibly, keeping owner and grants', () => {
    for (const [sig, before, after] of PINS) {
      expect(SUBS).toContain(`('${sig}',\n      '${before}', '${after}',`);
      expect(MIG).toContain(`= '${after}')`); // the @live-proof line
    }
    expect(SUBS).toContain('IF md5(v_def) <> s.before_md5 THEN');
    expect(SUBS).toContain('IF v_n <> 1 THEN');
    expect(SUBS).toContain('IF md5(v_after) <> s.after_md5 THEN');
    expect(SUBS).toContain('IF md5(replace(v_after, s.new_text, s.old_text)) <> s.before_md5 THEN');
    expect(SUBS).toContain('owner, security or grants moved');
  });

  describe('the buy-in', () => {
    it('asks fn_nit_career_check and no longer fn_nit_check', () => {
      expect(SUBS).toContain(
        "E'    v_nit := public.fn_nit_check(p_table_id, p_user_id, NULL);\\n',"
      );
      expect(SUBS).toContain(
        "E'    v_nit := public.fn_nit_career_check(p_table_id, p_user_id);\\n'"
      );
    });

    it('acted on career_vpip and nothing else fn_nit_check answered', () => {
      const gateSource = migrationText(
        '20260917230925_cash_funding_retains_original_participant_custody.sql'
      );
      const window = sliceBetween(
        gateSource,
        'v_nit := public.fn_nit_check(p_table_id, p_user_id, NULL);',
        'END;'
      );
      expect(window).toContain(
        "IF (v_nit->>'ok')::boolean = false AND v_nit->>'reason' = 'career_vpip' THEN"
      );
      expect(window).not.toContain('maintain_vpip');
    });

    it("runs fn_nit_check's career statement verbatim and no maintain scan", () => {
      expect(squash(CAREER_FN)).toContain(squash(nitCheckCareerBlock()));
      expect(CAREER_FN).not.toMatch(/MAINTAIN|cash_game_roster|table_id IN|played_at/);
      // Same answers for a table with NIT off and for a player within limits.
      expect(CAREER_FN).toContain(
        "RETURN jsonb_build_object('ok', true, 'reason', 'nit_game_off');"
      );
      expect(CAREER_FN).toContain(
        "RETURN jsonb_build_object('ok', true, 'reason', 'within_limits');"
      );
    });

    it('is not reachable from a browser', () => {
      expect(MIG).toContain(
        'REVOKE ALL ON FUNCTION public.fn_nit_career_check(uuid, uuid) FROM PUBLIC, anon, authenticated;'
      );
      expect(CAREER_FN).toContain('SECURITY DEFINER');
      expect(CAREER_FN).toContain("SET search_path TO 'public', 'pg_temp'");
    });
  });

  describe('the outbox drain', () => {
    it('tries the exact key fn_lock_daily_mission_user takes, and a held player takes the skip path', () => {
      expect(SUBS).toContain("hashtextextended(''daily-missions-user:'' || p_user_id::text, 0)");
      expect(SUBS).toContain('IF NOT pg_try_advisory_xact_lock(');
      expect(SUBS).toContain("USING ERRCODE = ''lock_not_available'';");
      const lockFn = migrationNames()
        .filter((n) => n < NAME)
        .map((n) => migrationText(n))
        .filter((t) => /FUNCTION public\.fn_lock_daily_mission_user\(/.test(t))
        .at(-1);
      expect((lockFn ?? '').replace(/\s+/g, '')).toContain(
        "hashtextextended('daily-missions-user:'||p_user_id::text,0)"
      );
      const drainUser = migrationNames()
        .filter((n) => n < NAME)
        .map((n) => migrationText(n))
        .filter((t) => /FUNCTION public\.fn_drain_daily_challenge_event_outbox_user\(/.test(t))
        .at(-1);
      expect(drainUser).toMatch(
        /WHEN deadlock_detected OR lock_not_available OR serialization_failure THEN/
      );
    });

    it('still takes the player and profile locks after the try', () => {
      const added = sliceBetween(
        SUBS,
        'A HELD PLAYER IS SKIPPED',
        "('sp_drain_daily_challenge_event_outbox"
      );
      expect(added.indexOf('pg_try_advisory_xact_lock')).toBeLessThan(
        added.indexOf('PERFORM public.fn_lock_daily_mission_user(p_user_id);')
      );
    });

    it('books each player with synchronous_commit off, set inside the per-player transaction', () => {
      const added = sliceBetween(
        SUBS,
        "('sp_drain_daily_challenge_event_outbox",
        "('fn_ca_club_game_rows"
      );
      expect(added).toContain("PERFORM set_config(''synchronous_commit'', ''off'', true);");
      expect(added.indexOf("set_config(''search_path''")).toBeLessThan(
        added.lastIndexOf("set_config(''synchronous_commit''")
      );
    });
  });

  describe('the Club Data snapshot', () => {
    it('orders tournaments by an order idx_tournaments_start_time can walk, and proves it is the same order', () => {
      expect(SUBS).toContain("'ORDER BY tr.start_time DESC NULLS LAST,tr.id DESC',");
      expect(SUBS).toContain("'       ORDER BY tr.start_time DESC,tr.id DESC')");
      expect(SUBS).toContain('tournaments.start_time is nullable');
      expect(SUBS).toMatch(
        /a\.attrelid = 'public\.tournaments'::regclass AND a\.attname = 'start_time'/
      );
    });

    it('reads the summary from a covering index whose visibility map is kept fresh', () => {
      expect(MIG).toContain('ON public.ca_club_tournament_daily (club_id, stat_date)');
      expect(MIG).toContain('INCLUDE (tournament_id, fee, winnings, updated_at);');
      expect(MIG).toMatch(/ALTER TABLE public\.ca_club_tournament_daily SET \(/);
      expect(MIG).toContain('indisvalid) = 1');
    });
  });
});
