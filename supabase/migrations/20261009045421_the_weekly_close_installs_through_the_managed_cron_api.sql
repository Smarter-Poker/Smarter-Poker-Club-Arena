-- Version reserved by scripts/new-migration.mjs: 20261009045421.
-- Replaces never-installed 20261009005558: managed postgres can read cron.job
-- but cannot SELECT FOR UPDATE. The supported cron.alter_job API owns writes.
-- A repeatable-read snapshot makes any intervening row update fail with 40001,
-- rather than overwrite another editor's command or metadata. Its native UPDATE
-- then holds the row lock through the exact whole-row postimage check and commit.
-- No grants, ownership, schedule, budgets, coordinator or payer changes.
-- Job 272 already wakes every five minutes, but its conditional skipped an
-- ordinary, ungated Monday close until 04:40 America/Chicago. Admit the due
-- week's first 40 minutes as well, so 04:00 and a thawed 04:05 tick both reach
-- the existing coordinator. Its due checks, gates, freeze, advisory lock,
-- attempt budget and money-round receipts remain the authority.
-- Only this exact job's command changes; no second scheduler or payer.
-- @live-proof: (SELECT jobid=272 AND active AND schedule='*/5 * * * *' AND md5(command)='a532167f5019f181dd10e48102e40cfc' FROM cron.job WHERE jobname='union-weekly-rakeback-close')
BEGIN;
SET TRANSACTION ISOLATION LEVEL REPEATABLE READ;
SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '60s';

DO $migration$
DECLARE
  before_job cron.job%ROWTYPE;
  after_job jsonb;
  command_after text;
  anchor text := $anchor$WHEN extract(minute FROM now()) BETWEEN 40 AND 44$anchor$;
  replacement text := $replacement$WHEN extract(minute FROM now()) BETWEEN 40 AND 44 OR (now() >= public.fn_union_accounting_run_at(public.fn_union_week_start(now())) AND now() < public.fn_union_accounting_run_at(public.fn_union_week_start(now())) + interval '40 minutes')$replacement$;
BEGIN
  SELECT * INTO STRICT before_job FROM cron.job
    WHERE jobname='union-weekly-rakeback-close';
  IF before_job.jobid<>272 OR before_job.active IS DISTINCT FROM true
    OR before_job.schedule<>'*/5 * * * *'
    OR md5(before_job.command)<>'3d27a473c11051deb6fe00ceffd4e409' THEN
    RAISE EXCEPTION 'weekly close cron is not the pinned preimage' USING ERRCODE='55000';
  END IF;
  IF (length(before_job.command)-length(replace(before_job.command,anchor,'')))/length(anchor)<>1 THEN
    RAISE EXCEPTION 'weekly close admission anchor count differs' USING ERRCODE='55000';
  END IF;
  command_after:=replace(before_job.command,anchor,replacement);
  IF md5(command_after)<>'a532167f5019f181dd10e48102e40cfc' THEN
    RAISE EXCEPTION 'weekly close cron postimage differs' USING ERRCODE='55000';
  END IF;
  PERFORM cron.alter_job(before_job.jobid,command:=command_after);
  SELECT to_jsonb(j) INTO STRICT after_job FROM cron.job j WHERE jobid=before_job.jobid;
  IF after_job IS DISTINCT FROM jsonb_set(to_jsonb(before_job),'{command}',to_jsonb(command_after)) THEN
    RAISE EXCEPTION 'weekly close cron changed beyond its command' USING ERRCODE='55000';
  END IF;
END
$migration$;

COMMIT;
