\set ON_ERROR_STOP on

-- Usage (direct PostgreSQL 17 session, after every engine process is proved to
-- run the durable-witness writer SHA):
--
--   PGSERVICE=club_arena_cutover PGPASSFILE=/private/operator/.pgpass psql -X \
--     -v writer_sha=0123456789abcdef0123456789abcdef01234567 \
--     -v cutover_at=2026-09-08T23:15:00.000000Z \
--     -f scripts/ops/set-stats-equity-witness-fleet-cutover.sql
--
-- cutover_at is the evidence boundary: it must be no earlier than the last old
-- engine process exiting. The immutable singleton makes an exact replay a no-op
-- and refuses a different timestamp or SHA. Correcting a bad assertion requires
-- a reviewed forward migration; this script can never rewrite history.

\if :{?writer_sha}
\else
  \echo 'writer_sha is required (the full 40-character capable engine Git SHA)'
  \quit 3
\endif

\if :{?cutover_at}
\else
  \echo 'cutover_at is required (an explicit RFC3339 timestamp with UTC offset)'
  \quit 3
\endif

BEGIN;

SELECT set_config('ca.stats_equity_writer_sha', :'writer_sha', true);
SELECT set_config('ca.stats_equity_cutover_at', :'cutover_at', true);

DO $stamp$
DECLARE
  v_sha text := current_setting('ca.stats_equity_writer_sha');
  v_cutover_text text := current_setting('ca.stats_equity_cutover_at');
  v_cutover_at timestamptz;
  v_existing public.ca_stats_equity_witness_cutover%ROWTYPE;
BEGIN
  IF v_sha !~ '^[0-9a-f]{40}$' THEN
    RAISE EXCEPTION 'ALL_IN_EQUITY_WITNESS_WRITER_SHA_INVALID: %', v_sha;
  END IF;
  IF v_cutover_text !~ '(Z|[+-][0-9][0-9]:[0-9][0-9])$' THEN
    RAISE EXCEPTION
      'ALL_IN_EQUITY_WITNESS_CUTOVER_TIMEZONE_REQUIRED: %', v_cutover_text;
  END IF;

  v_cutover_at := v_cutover_text::timestamptz;
  IF v_cutover_at > clock_timestamp() THEN
    RAISE EXCEPTION 'ALL_IN_EQUITY_WITNESS_CUTOVER_IN_FUTURE: %', v_cutover_at;
  END IF;

  INSERT INTO public.ca_stats_equity_witness_cutover (
    id, writer_cutover_at, writer_sha
  ) VALUES (
    true, v_cutover_at, v_sha
  )
  ON CONFLICT (id) DO NOTHING;

  SELECT *
    INTO STRICT v_existing
    FROM public.ca_stats_equity_witness_cutover
   WHERE id;

  IF v_existing.writer_cutover_at IS DISTINCT FROM v_cutover_at
     OR v_existing.writer_sha IS DISTINCT FROM v_sha THEN
    RAISE EXCEPTION
      'ALL_IN_EQUITY_WITNESS_CUTOVER_CONFLICT: stored timestamp % SHA %, requested timestamp % SHA %',
      v_existing.writer_cutover_at,
      v_existing.writer_sha,
      v_cutover_at,
      v_sha;
  END IF;
END;
$stamp$;

COMMIT;

SELECT public.ca_stats_equity_witness_readiness() AS equity_witness_readiness;
