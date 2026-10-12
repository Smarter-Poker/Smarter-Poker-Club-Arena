-- 20261003215102_bound_stats_quality_report
--
-- Reserved by scripts/reserve-migration-version.sh on 2026-10-03 21:51:02 UTC.
--
-- CLAUDE.md 10.9: the reasoning goes in this header, not just the SQL.
-- Say what was wrong, what this changes, and what you measured. A
-- migration whose header is its own filename is the next agent's mystery.
-- The first retirement body counted every historical hand_atomic_commits row
-- to display a protocol-2 coverage total. Production correctly stopped that
-- unbounded scan at the RPC's five-second statement budget. Protocol-2 has a
-- tighter exact identity: every accepted payload is either represented by an
-- immutable projection receipt or remains on the bounded outbox set as a
-- missing-current receipt. Compose those two already-counted values instead.
--
-- @live-proof: position('v_accepted_fact_payloads := v_projection_receipts + v_missing_receipts' in pg_get_functiondef('public.ca_stats_operational_quality()'::regprocedure)) > 0

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';

DO $patch$
DECLARE
  v_definition text;
  v_old text := $old$  SELECT count(*) FILTER (
           WHERE post_commit_payload #> '{accepted_hand_facts,stats_facts}' IS NOT NULL
         )
    INTO v_accepted_fact_payloads
    FROM public.hand_atomic_commits;

  SELECT count(*)
    INTO v_projection_receipts
    FROM public.ca_hand_fact_projection_receipts;$old$;
  v_new text := $new$  SELECT count(*)
    INTO v_projection_receipts
    FROM public.ca_hand_fact_projection_receipts;

  -- Every protocol-2 accepted payload is either already receipted or is still
  -- on the bounded outbox working set above. Counting all historical atomic
  -- commits would turn this five-second health door into an unbounded scan.
  v_accepted_fact_payloads := v_projection_receipts + v_missing_receipts;$new$;
BEGIN
  v_definition := pg_get_functiondef(
    'public.ca_stats_operational_quality()'::regprocedure
  );
  IF (length(v_definition) - length(replace(v_definition, v_old, ''))) /
       length(v_old) <> 1 THEN
    RAISE EXCEPTION 'Stats operational quality source drifted; refusing bounded patch';
  END IF;
  EXECUTE replace(v_definition, v_old, v_new);
END;
$patch$;

REVOKE ALL ON FUNCTION public.ca_stats_operational_quality()
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.ca_stats_operational_quality()
  TO service_role;

COMMIT;
