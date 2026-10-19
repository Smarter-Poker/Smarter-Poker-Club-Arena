/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  AN ACHIEVEMENT REWARD IS DIAMONDS, PAID ONCE, ON AN UNLOCK THE SERVER PROVES
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Dan, 2026-10-19: "Pay achievement rewards as diamonds through
 * award_diamonds_v2." and, on back-pay, "NO, ONLY FROM NOW ON".
 *
 * Three achievements carry a reward (royal_flush 500, streak_30 100,
 * streak_100 500). They were promised in chips through add_to_promo_wallet from
 * the browser, which never paid. Before a single diamond could be switched on,
 * the browser's door had to stop deciding: fn_achievement_record_progress took
 * the TARGET from the caller (send 1, unlock anything) and the progress too,
 * and the login streak behind two of the three was written by the browser.
 *
 * Migration 20261019155445 makes training_achievement_definitions the canonical
 * list (a reward is impossible without server evidence, by CHECK), stops the
 * browser door trusting its target or writing an evidence-backed achievement,
 * proves the Royal Flush from the engine's own hand record (horses alike) and
 * the streak from a server-counted day, and pays each once through
 * award_diamonds_v2 under achievement:<id>:<user>. Nothing unlocked before the
 * install is ever paid. The behaviour is proved on native PostgreSQL by
 * scripts/ci/test-achievement-diamonds-postgres.py; these pins keep its shape.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ACHIEVEMENTS } from '../src/services/AchievementService';

const ROOT = process.cwd();
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');
const sql = read(
  'supabase/migrations/20261019155445_achievements_pay_diamonds_from_server_evidence.sql'
);
const body = sql.slice(sql.indexOf('\nBEGIN;\n'));
const fn = (name: string) => {
  const start = body.indexOf(`CREATE OR REPLACE FUNCTION public.${name}(`);
  expect(start, `${name} is defined`).toBeGreaterThan(0);
  const close =
    body.indexOf('$fn$;', start) > 0 && name !== 'fn_achievement_record_progress'
      ? body.indexOf('$fn$;', start)
      : body.indexOf('$function$;', start);
  return body.slice(start, close);
};
const unlock = fn('fn_achievement_unlock_server');
const door = fn('fn_achievement_record_progress');
const login = fn('fn_achievement_record_login');
const royal = fn('tr_hand_history_royal_flush_achievement');

describe('the server holds the canonical achievements', () => {
  it('fills every definition with the client catalog numbers, rewards and evidence', () => {
    const rows = [...body.matchAll(/\('([a-z0-9_]+)',\s+(\d+), (\d+), (NULL|'[a-z_]+')\)/g)].map(
      (m) => `${m[1]}=${m[2]}/${m[3]}/${m[4] === 'NULL' ? '' : m[4].slice(1, -1)}`
    );
    const catalog = ACHIEVEMENTS.map(
      (a) =>
        `${a.id}=${a.requirement}/${a.diamondReward ?? 0}/${
          a.serverProved
            ? a.id === 'royal_flush'
              ? 'engine_royal_flush'
              : 'server_login_streak'
            : ''
        }`
    );
    expect(rows.sort()).toEqual(catalog.sort());
    expect(rows).toHaveLength(23);
  });

  it('makes a reward impossible without server evidence, and closes the table to browsers', () => {
    expect(body).toMatch(
      /CHECK \(reward_diamonds >= 0 AND reward_diamonds <= 500\s+AND \(reward_diamonds = 0 OR evidence IS NOT NULL\)/
    );
    expect(body).toMatch(
      /REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER\s+ON public\.training_achievement_definitions FROM PUBLIC, anon, authenticated;/
    );
  });
});

describe("the browser's door decides nothing that pays", () => {
  it('reads the target from the definition and never from the caller', () => {
    expect(door).toContain('v_target := GREATEST(COALESCE(v_threshold, 1), 1);');
    expect(door).not.toMatch(/COALESCE\(p_target/);
    // negative control: the pre-image is exactly what this pin refuses
    expect(
      read('supabase/migrations/20260830050000_an_anon_caller_cannot_write_achievements.sql')
    ).toMatch(/GREATEST\(COALESCE\(p_target, 1\), 1\)/);
  });

  it('refuses an unknown id and writes nothing for an evidence-backed achievement', () => {
    expect(door).toMatch(
      /IF NOT FOUND THEN\s+RAISE EXCEPTION 'fn_achievement_record_progress: unknown achievement %'/
    );
    expect(door).toMatch(/IF v_evidence IS NOT NULL THEN\s+RETURN false;/);
  });

  it('the browser no longer writes the login streak', () => {
    expect(body).toContain(
      'REVOKE UPDATE (login_streak, last_login_date) ON public.profiles FROM PUBLIC, anon, authenticated;'
    );
    const trigger = read('src/services/AchievementTriggerService.ts');
    expect(trigger).not.toMatch(/login_streak:\s*streak/);
    expect(trigger).toContain('achievementService.recordLogin()');
    const service = read('src/services/AchievementService.ts');
    expect(service).toContain("supabase.rpc('fn_achievement_record_login')");
    expect(service).toMatch(
      /if \(!achievement \|\| achievement\.serverProved\) return \{ unlocked: false \};/
    );
  });
});

describe('the reward is diamonds, paid once, only on an unlock that happens from now on', () => {
  it('pays through award_diamonds_v2 as an achievement, under one reference per player per achievement', () => {
    expect(unlock).toContain(
      "v_reference := 'achievement:' || p_achievement_id || ':' || p_user_id::text;"
    );
    expect(unlock).toMatch(
      /public\.award_diamonds_v2\(\s+p_user_id, 'achievement', v_reference, p_achievement_id,/
    );
    expect(unlock).toContain("'achievement_diamonds', v_def.reward_diamonds");
    expect(sql).not.toMatch(/add_to_promo_wallet\(/);
    expect(sql).not.toMatch(/INSERT INTO public\.diamond_transactions/);
  });

  it('pays only on the transition, so a row unlocked before the install is never paid', () => {
    expect(unlock).toContain('v_transition := NOT v_was_unlocked AND v_progress >= v_target;');
    expect(unlock).toMatch(/IF v_transition AND v_def\.reward_diamonds > 0 THEN/);
    expect(body).toMatch(
      /-- Nothing was paid by installing this: no back-pay\.\s+IF EXISTS \(SELECT 1 FROM public\.diamond_transactions t WHERE t\.reference_id LIKE 'achievement:%'\) THEN/
    );
  });

  it('a frozen issuance leaves the achievement unearned so the next event pays it', () => {
    expect(unlock).toMatch(
      /ELSIF v_award ->> 'reason' IN \('diamond_issuance_frozen', 'unknown_action', 'user_not_found', 'invalid_input'\) THEN[\s\S]{0,300}RAISE EXCEPTION/
    );
  });

  it('is owner-only: no browser can call the payer', () => {
    expect(body).toContain(
      'REVOKE ALL ON FUNCTION public.fn_achievement_unlock_server(uuid, text, numeric, jsonb) FROM PUBLIC, anon, authenticated;'
    );
    expect(body).not.toMatch(/GRANT EXECUTE ON FUNCTION public\.fn_achievement_unlock_server/);
  });
});

describe('the evidence is the server record', () => {
  it('Royal Flush is read from the hand the engine recorded, and can never fail that hand', () => {
    expect(body).toMatch(
      /CREATE TRIGGER trg_hand_history_royal_flush_achievement\s+AFTER INSERT ON public\.hand_history\s+FOR EACH ROW\s+WHEN \(NEW\.daily_mission_events IS NOT NULL\s+AND jsonb_path_exists\(NEW\.daily_mission_events, '\$\[\*\] \? \(@\.magnitudes\.strong_hands == 10\)'\)\)/
    );
    expect(royal).toMatch(
      /EXCEPTION WHEN OTHERS THEN\s+RAISE WARNING 'royal flush achievement for/
    );
    expect(royal).toMatch(
      /EXCEPTION WHEN OTHERS THEN\s+RAISE WARNING 'royal flush achievements for hand/
    );
    // The engine still names 10 a Royal Flush.
    expect(read('server/src/engine/dailyMissionEvents.ts')).toContain(
      "if (name.includes('royal')) return 10;"
    );
  });

  it('the login day is counted on the server clock, and each streak achievement in its own savepoint', () => {
    expect(login).toContain("v_today    date := (now() AT TIME ZONE 'UTC')::date;");
    expect(login).toContain(
      'v_streak := CASE WHEN v_last = v_today - 1 THEN v_streak + 1 ELSE 1 END;'
    );
    expect(login).toMatch(/IF v_last = v_today THEN\s+RETURN/);
    expect(login).toMatch(
      /EXCEPTION WHEN OTHERS THEN\s+RAISE WARNING 'fn_achievement_record_login/
    );
  });

  it('horses are players: nothing here branches on is_horse (CLAUDE.md 10.5)', () => {
    expect(body).not.toMatch(/is_horse/i);
    expect(royal).toContain('horses included');
  });
});

describe('the proof runs', () => {
  it('the native PostgreSQL proof applies this migration byte for byte on every migration change', () => {
    const proof = read('scripts/ci/test-achievement-diamonds-postgres.py');
    expect(proof).toContain('20261019155445_achievements_pay_diamonds_from_server_evidence.sql');
    expect(proof).toContain('psql(MIGRATION.read_text())');
    const workflow = read('.github/workflows/achievement-diamonds-native-proof.yml');
    expect(workflow).toContain('- supabase/migrations/**');
    expect(workflow).toContain('run: python3 scripts/ci/test-achievement-diamonds-postgres.py');
  });
});
