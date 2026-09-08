/* A HAND IS REFUSED FOR THE FRACTION IT CREATES, NOT ONE IT INHERITED (2026-09-08)

   fn_ca_commit_hand_settlement_before_lease_generation refuses an accepted
   tournament hand whose written stack is fractional. The guard was added at
   12:56 today inside a 70KB migration about something else entirely, with no
   comment and no rule cited - while every other guard in the same block
   carries its reasoning. The written standard is
   docs/laws.d/a-chip-is-two-decimal-places-everywhere.md, under which 6249.50
   is a legal chip value, so per CLAUDE.md 10.8 this is a defect rather than a
   conflict of laws.

   But whole tournament chips IS real poker truth, so both halves were wrong.
   The engine defect is fixed at source separately: PokerEngine.distributePot
   divided every pot into cents rather than indivisible chips, so a 959-chip
   pot chopped two ways paid 479.50 each.

   What made this an outage rather than a wart is that the guard tested the
   stack the hand ENDED with. A player already holding 6249.50 therefore failed
   EVERY future hand: the refusal is deterministic, all five retries are
   identical, the engine generation is terminated and the table stalls for good.

   Measured on production 2026-09-08 17:35 UTC:
     - 7 tournaments carried a fractional seat, and exactly those 7 were stalled
     - 12 seats held 6.00 chips of fraction in total
     - every affected tournament had an EVEN number of fractional seats and a
       WHOLE chips_in_play (2,630,000.00 / 312,000.00 / 234,000.00 / 3,000.00)
     - tournament_players.chip_count carried zero fractional rows

   So nothing is missing: each .50 is one half of a single chip split two ways.

   Tolerate the history, refuse the future - the same shape as the NOT VALID
   constraints elsewhere in this repo. A hand that INTRODUCES a fraction still
   refuses whole; a hand whose player carried one in does not. */
DO $mig$
DECLARE v_src text; v_new text; v_n int; v_a text; v_b text; v_check text;
BEGIN
  IF NOT (current_user IN ('postgres','service_role')) THEN
    RAISE EXCEPTION 'operator-only';
  END IF;

  SELECT pg_get_functiondef(p.oid) INTO v_src
    FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
   WHERE n.nspname='public' AND p.prosrc LIKE '%accepted tournament hand produced fractional stack%';
  IF v_src IS NULL THEN
    RAISE EXCEPTION 'the fractional-stack guard was not found';
  END IF;

  IF position('A HAND IS REFUSED FOR THE FRACTION IT CREATES' in v_src) > 0 THEN
    RAISE NOTICE 'already applied; nothing to do';
    RETURN;
  END IF;

  v_a := 'IF v_written<>trunc(v_written) THEN' || E'\n' ||
         '        RAISE EXCEPTION ''accepted tournament hand produced fractional stack % for %'',v_written,v_uid;';
  v_n := (length(v_src) - length(replace(v_src, v_a, ''))) / length(v_a);
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'the fractional-stack guard appears % times, expected exactly 1 - the function has changed and this edit must be re-read against it', v_n;
  END IF;

  v_b := '/* A HAND IS REFUSED FOR THE FRACTION IT CREATES, NOT ONE IT INHERITED' || E'\n' ||
         '         (2026-09-08). Tournament chips are indivisible, so a hand that SPLITS' || E'\n' ||
         '         one is a real defect - PokerEngine.distributePot divides pots in cents' || E'\n' ||
         '         rather than whole chips, which is fixed at source separately. But this' || E'\n' ||
         '         guard tested the stack the hand ENDED with, so a player already holding' || E'\n' ||
         '         6249.50 failed every future hand: the refusal is deterministic, all 5' || E'\n' ||
         '         retries are identical, the engine generation dies and the table stalls' || E'\n' ||
         '         for good. Measured 17:35 UTC: 7 tournaments carried a fractional seat' || E'\n' ||
         '         and exactly those 7 were stalled. No chips were missing - 12 seats held' || E'\n' ||
         '         6.00 of fraction, every tournament had an EVEN number of them, and' || E'\n' ||
         '         chips_in_play was whole in all four (each .50 is one half of a single' || E'\n' ||
         '         chip split two ways). Tolerate the history, refuse the future. */' || E'\n' ||
         '      IF v_written<>trunc(v_written) AND v_before=trunc(v_before) THEN' || E'\n' ||
         '        RAISE EXCEPTION ''accepted tournament hand produced fractional stack % for % (entered the hand with %)'',v_written,v_uid,v_before;';

  v_new := replace(v_src, v_a, v_b);
  IF v_new = v_src THEN
    RAISE EXCEPTION 'substitution produced no change';
  END IF;

  EXECUTE v_new;

  SELECT pg_get_functiondef(p.oid) INTO v_check
    FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
   WHERE n.nspname='public' AND p.prosrc LIKE '%accepted tournament hand produced fractional stack%';
  IF v_check IS NULL
     OR position('A HAND IS REFUSED FOR THE FRACTION IT CREATES' in v_check) = 0
     OR position('v_written<>trunc(v_written) AND v_before=trunc(v_before)' in v_check) = 0 THEN
    RAISE EXCEPTION 'post-condition failed: the narrowed guard is not present after the replace. Nothing written.';
  END IF;

  RAISE NOTICE 'fractional-stack guard narrowed to fractions this hand created';
END $mig$;
