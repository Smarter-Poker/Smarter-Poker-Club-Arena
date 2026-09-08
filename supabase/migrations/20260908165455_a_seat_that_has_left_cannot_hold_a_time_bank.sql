/* A SEAT THAT HAS LEFT CANNOT HOLD A TIME BANK (2026-09-08)

   fn_ca_commit_hand_settlement applies the accepted hand's time-bank state to
   table_seats, counts the rows it touched, and refuses the WHOLE hand unless
   the count equals the number of items in the payload.

   Two tests could satisfy an item: the UPDATE matched a live seat, or a live
   seat already stored exactly that state. NEITHER can be satisfied once the
   seat is gone - a player who stood up between the deal and the commit, or
   whose row the departed-seat sweep has since removed. The count came up
   short, the hand was refused, and because the player never comes back EVERY
   RETRY WAS IDENTICAL: after 5 attempts the engine generation was terminated
   and the table stalled permanently.

   Measured on production 2026-09-08 16:44-16:50 UTC:
     - 13 tables stalled on 'atomic hand commit refused (time_bank_seat_mismatch)'
     - 13 of 13 had a seat exit within 15 minutes of their refusal, proved from
       ca_seat_stack_exits (table_seats itself no longer shows it - 584 exits in
       two hours and the departed rows are pruned behind them)
     - hand throughput 7,312/hour against 14,994 in the same hour a day earlier
     - 795 open drift incidents, 507 of them the three engine sources cascading
       from this one refusal, one incident per hand

   The chips were never at risk: the alert itself says the hand COMMITTED and
   only its post-commit envelope was held back. A departed seat holds no time
   bank, so there is nothing to preserve and nothing to refuse. A seat that is
   still LIVE and disagrees is untouched by this branch and still refuses whole.

   Applied inside the :55 maintenance freeze because CREATE OR REPLACE FUNCTION
   costs a ~28s PostgREST schema reload (CLAUDE.md section 2). */
DO $mig$
DECLARE
  v_src text; v_new text; v_n int; v_anchor text; v_add text; v_check text;
BEGIN
  IF NOT (current_user IN ('postgres','service_role')) THEN
    RAISE EXCEPTION 'operator-only';
  END IF;

  SELECT pg_get_functiondef(p.oid) INTO v_src
    FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
   WHERE n.nspname='public' AND p.proname='fn_ca_commit_hand_settlement'
     AND p.prosrc LIKE '%time_bank_seat_mismatch%';
  IF v_src IS NULL THEN
    RAISE EXCEPTION 'fn_ca_commit_hand_settlement carrying the time-bank gate not found';
  END IF;

  IF position('A SEAT THAT HAS LEFT CANNOT HOLD A TIME BANK' in v_src) > 0 THEN
    RAISE NOTICE 'already applied; nothing to do';
    RETURN;
  END IF;

  v_anchor := '        v_row_count := 1;' || E'\n' ||
              '      END IF;' || E'\n' ||
              '      v_updated := v_updated + v_row_count;';
  v_n := (length(v_src) - length(replace(v_src, v_anchor, ''))) / length(v_anchor);
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'the time-bank tally site appears % times, expected exactly 1 - fn_ca_commit_hand_settlement has changed and this edit must be re-read against it', v_n;
  END IF;

  v_add := '        v_row_count := 1;' || E'\n' ||
           '      END IF;' || E'\n' ||
           '      /* A SEAT THAT HAS LEFT CANNOT HOLD A TIME BANK (2026-09-08).' || E'\n' ||
           '         The two tests above prove a LIVE seat carries the requested state.' || E'\n' ||
           '         Neither can be satisfied once the seat is gone - a player who stood' || E'\n' ||
           '         up mid-hand, or whose row the departed-seat sweep has since removed.' || E'\n' ||
           '         That left v_updated short and refused the whole hand; because the' || E'\n' ||
           '         player never comes back every retry was identical, so the engine' || E'\n' ||
           '         generation died and the table stalled for good. Measured 2026-09-08:' || E'\n' ||
           '         13 of 13 stalled tables had a seat exit within 15 minutes of the' || E'\n' ||
           '         refusal, and hand throughput had halved. A departed seat holds no' || E'\n' ||
           '         time bank, so there is nothing to preserve and nothing to refuse.' || E'\n' ||
           '         A seat that is still LIVE and disagrees does not reach this branch' || E'\n' ||
           '         (the UPDATE would have matched it) and still refuses the hand whole. */' || E'\n' ||
           '      IF v_row_count = 0 AND NOT EXISTS (' || E'\n' ||
           '        SELECT 1' || E'\n' ||
           '          FROM public.table_seats s' || E'\n' ||
           '         WHERE s.table_id = p_table_id' || E'\n' ||
           '           AND s.user_id = (v_item->>''user_id'')::uuid' || E'\n' ||
           '           AND (' || E'\n' ||
           '             (v_exact_seat_generation' || E'\n' ||
           '               AND s.id = (v_item->>''seat_id'')::uuid' || E'\n' ||
           '               AND s.joined_at = (v_item->>''seat_joined_at'')::timestamptz)' || E'\n' ||
           '             OR (NOT v_exact_seat_generation AND s.left_at IS NULL)' || E'\n' ||
           '           )' || E'\n' ||
           '      ) THEN' || E'\n' ||
           '        v_row_count := 1;' || E'\n' ||
           '      END IF;' || E'\n' ||
           '      v_updated := v_updated + v_row_count;';

  v_new := replace(v_src, v_anchor, v_add);
  IF v_new = v_src THEN
    RAISE EXCEPTION 'substitution produced no change';
  END IF;

  EXECUTE v_new;

  SELECT pg_get_functiondef(p.oid) INTO v_check
    FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
   WHERE n.nspname='public' AND p.proname='fn_ca_commit_hand_settlement'
     AND p.prosrc LIKE '%time_bank_seat_mismatch%';
  IF v_check IS NULL
     OR position('A SEAT THAT HAS LEFT CANNOT HOLD A TIME BANK' in v_check) = 0
     OR position('time_bank_seat_mismatch' in v_check) = 0 THEN
    RAISE EXCEPTION 'post-condition failed: the departed-seat branch or the original refusal is missing after the replace. Nothing written.';
  END IF;

  RAISE NOTICE 'departed-seat branch installed; refusal preserved for live seats';
END $mig$;
