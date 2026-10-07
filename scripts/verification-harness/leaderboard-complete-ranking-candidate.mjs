// UNQUALIFIED isolated-only proposal. Never installs or executes SQL.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
export const rankingPredecessor = new URL(
  '../../supabase/migrations/20260831002500_leaderboard_historical_period_contract.sql',
  import.meta.url
);
export function buildCompleteRankingCandidate(source) {
  assert.equal(
    createHash('sha256').update(source).digest('hex'),
    '1b268fa4775c2406adaef0eb2cd6d1f88346e36ed48e70a48e8cc6d031d99467'
  );
  const header = 'CREATE OR REPLACE FUNCTION public.fn_club_leaderboard_by_dates(';
  assert.equal(source.split(header).length, 2);
  const end = '\n$function$;';
  let definition = header + source.split(header)[1].split(end)[0] + end;
  const legacy = definition.slice(definition.indexOf('BEGIN\n') + 6);
  function once(old, next) {
    assert.equal(definition.split(old).length, 2);
    definition = definition.replace(old, () => next);
  }
  once(
    '  v_min_hands integer := 20;',
    '  v_min_hands integer := 20;\n  v_period text;\n  v_basis jsonb;\n  v_previous jsonb;\n  v_previous_start date;'
  );
  once(
    'BEGIN\n',
    `BEGIN
  -- Only closed canonical product rounds can select prospective V2.
  IF v_end <= v_today AND EXTRACT(DOW FROM v_start)=0 AND v_end=v_start+7 THEN
    v_period:='weekly';
  ELSIF v_end <= v_today AND EXTRACT(DAY FROM v_start)=1 AND v_end=(v_start+interval '1 month')::date THEN
    v_period:='monthly';
  END IF;
  IF v_period IS NOT NULL THEN
    v_basis:=public.fn_leaderboard_complete_round_basis(p_club_id,v_period,v_start,v_end);
    IF v_basis->>'basis_version'='complete_capture_v2' AND v_basis->'complete'='true'::jsonb THEN
      v_previous_start:=CASE v_period WHEN 'weekly' THEN v_start-7 ELSE (v_start-interval '1 month')::date END;
      BEGIN
        v_previous:=public.fn_leaderboard_complete_round_basis(p_club_id,v_period,v_previous_start,v_start);
        IF v_previous->>'basis_version'<>'complete_capture_v2' OR v_previous->'complete'<>'true'::jsonb THEN v_previous:=NULL; END IF;
      EXCEPTION WHEN SQLSTATE '55000' THEN
        -- Only genuinely unavailable previous complete capture means unknown.
        IF SQLERRM='LEADERBOARD_CAPTURE_UNAVAILABLE' THEN v_previous:=NULL; ELSE RAISE; END IF;
      END;
      RETURN QUERY
      WITH inputs AS (
        SELECT false AS previous,d.* FROM jsonb_to_recordset(v_basis->'rows') AS d(
          user_id uuid,hands_played numeric,total_winnings numeric,total_losses numeric,
          tournaments_won numeric,total_rake numeric,sum_big_blind numeric)
        UNION ALL
        SELECT true AS previous,d.* FROM jsonb_to_recordset(COALESCE(v_previous->'rows','[]'::jsonb)) AS d(
          user_id uuid,hands_played numeric,total_winnings numeric,total_losses numeric,
          tournaments_won numeric,total_rake numeric,sum_big_blind numeric)
      ), scored AS (
        SELECT d.*,CASE p_metric
          WHEN 'hands_played' THEN d.hands_played
          WHEN 'tournaments_won' THEN d.tournaments_won
          WHEN 'roi' THEN CASE WHEN d.total_losses>0 AND d.hands_played>=v_min_hands THEN (d.total_winnings-d.total_losses)/d.total_losses END
          WHEN 'bb100' THEN CASE WHEN d.sum_big_blind>0 AND d.hands_played>=v_min_hands THEN 100*(d.total_winnings-d.total_losses)/d.sum_big_blind END
          ELSE d.total_winnings-d.total_losses END AS score
        FROM inputs d
      ), ranked AS (
        SELECT s.*,rank() OVER(PARTITION BY s.previous ORDER BY s.score DESC NULLS LAST)::integer AS position,
          row_number() OVER(PARTITION BY s.previous ORDER BY s.score DESC NULLS LAST,s.user_id) AS ordinal,
          count(*) OVER(PARTITION BY s.previous)::integer AS total
        FROM scored s WHERE (s.hands_played>0 OR s.tournaments_won>0 OR s.total_winnings<>0 OR s.total_losses<>0)
      )
      SELECT r.user_id,r.hands_played,r.total_winnings,r.total_losses,r.tournaments_won,r.total_rake,r.sum_big_blind,
        CASE WHEN v_previous IS NULL OR old.score IS NULL THEN NULL ELSE old.position-r.position END,
        (p_metric NOT IN('roi','bb100') OR (r.hands_played>=v_min_hands AND
          (CASE WHEN p_metric='roi' THEN r.total_losses ELSE r.sum_big_blind END)>0)),
        r.position,r.total,v_start
      FROM ranked r LEFT JOIN ranked old ON old.previous AND old.user_id=r.user_id
      WHERE NOT r.previous ORDER BY r.ordinal LIMIT p_limit OFFSET GREATEST(COALESCE(p_offset,0),0);
      RETURN;
    ELSIF v_basis->>'basis_version' IS DISTINCT FROM 'legacy_v1' THEN
      RAISE EXCEPTION USING ERRCODE='55000',MESSAGE='LEADERBOARD_COMPLETE_BASIS_REQUIRED';
    END IF;
  END IF;
`
  );
  assert.ok(definition.endsWith(legacy), 'Legacy/live/noncanonical body changed');
  return `-- UNQUALIFIED source proposal; no migration version or runtime proof.
BEGIN;
SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='30s';
DO $guard$ BEGIN
  IF session_user<>'leaderboard_qualification_bootstrap' OR current_user<>session_user
    OR inet_server_addr() IS NOT NULL OR current_database()<>'postgres' THEN
    RAISE EXCEPTION 'Disposable bootstrap socket required';
  END IF;
  IF NOT EXISTS(SELECT 1 FROM pg_proc p WHERE p.oid=to_regprocedure('public.fn_club_leaderboard_by_dates(uuid,text,date,date,integer,integer)')
    AND md5(p.prosrc)='00824a10870941337666dea8adcaa39c' AND md5(pg_get_functiondef(p.oid))='b0efe3c4e9f3f7aac7c6cf9a6985ea6c'
    AND pg_get_userbyid(p.proowner)='postgres' AND p.prosecdef
    AND p.proconfig=ARRAY['search_path=public, pg_temp']::text[]
    AND (SELECT string_agg(CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END||':'||a.privilege_type,',' ORDER BY CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END||':'||a.privilege_type) FROM aclexplode(p.proacl) a)='authenticated:EXECUTE,postgres:EXECUTE,service_role:EXECUTE') THEN
    RAISE EXCEPTION 'Exact club ranking predecessor drift';
  END IF;
END $guard$;
${definition}
COMMIT;
`;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    assert.equal(process.argv.length, 2);
    process.stdout.write(buildCompleteRankingCandidate(readFileSync(rankingPredecessor, 'utf8')));
  } catch {
    console.error('Unqualified complete ranking candidate refused: reviewed source changed');
    process.exitCode = 1;
  }
}
