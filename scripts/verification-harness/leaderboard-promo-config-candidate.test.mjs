import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  buildPromoConfigCandidate,
  configPredecessor,
} from './leaderboard-promo-config-candidate.mjs';
const source = readFileSync(configPredecessor, 'utf8');
test('only guarded funding gate and publication are replaced, preserving false-overlay semantics', () => {
  const sql = buildPromoConfigCandidate(source);
  assert.equal(sql.match(/CREATE OR REPLACE FUNCTION/g).length, 2);
  assert.doesNotMatch(
    sql,
    /club_opening_setups|fn_complete_club_opening_setup|v_opening_seed|UPDATE.*seed|REVOKE|GRANT EXECUTE/
  );
  const start = source.indexOf('CREATE FUNCTION public.fn_publish_leaderboard_reward_program(');
  const original = source.slice(
    start,
    source.indexOf('\n$function$;', start) + '\n$function$;'.length
  );
  const restored = sql
    .slice(
      sql.indexOf('CREATE OR REPLACE FUNCTION public.fn_publish_leaderboard_reward_program('),
      sql.lastIndexOf('\n$function$;') + '\n$function$;'.length
    )
    .replace('CREATE OR REPLACE FUNCTION', 'CREATE FUNCTION')
    .replace(
      /\n  IF COALESCE\(p_overlay_enabled, false\) THEN\n    RAISE EXCEPTION 'LEADERBOARD_PROMO_ONLY\|Club Bank Overlay Is Not Allowed For Leaderboard Prizes'\n      USING ERRCODE = '22023';\n  END IF;/,
      ''
    );
  assert.equal(restored, original);
  assert.ok(sql.indexOf('IF NOT v_can_manage') < sql.indexOf('LEADERBOARD_PROMO_ONLY'));
  assert.ok(
    sql.indexOf('LEADERBOARD_PROMO_ONLY') <
      sql.indexOf('INSERT INTO public.leaderboard_reward_program_versions')
  );
  assert.match(sql, /p_overlay_enabled boolean DEFAULT false/);
  assert.match(sql, /Disposable bootstrap socket required/);
  assert.match(sql, /postgres:EXECUTE,service_role:EXECUTE/);
});
test('entire predecessor bytes and extraction boundaries cannot drift', () => {
  for (const altered of [
    source + '\n',
    source.replace('v_opening_seed numeric', 'v_opening_seed bigint'),
    source.replace('IF NOT v_can_manage', 'IF true'),
  ])
    assert.throws(() => buildPromoConfigCandidate(altered));
});
