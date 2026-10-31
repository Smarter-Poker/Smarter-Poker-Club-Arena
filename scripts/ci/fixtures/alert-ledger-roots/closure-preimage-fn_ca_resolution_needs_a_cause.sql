CREATE OR REPLACE FUNCTION public.fn_ca_resolution_needs_a_cause()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_cause text := btrim(coalesce(NEW.root_cause, ''));
  v_ref   text := btrim(coalesce(NEW.correction_ref, ''));
  -- COALESCE, not a bare comparison: a NULL closure_basis must read as "not
  -- aged out" (false), never as NULL, or both fences below silently pass.
  v_aged  boolean := COALESCE(NEW.closure_basis = 'aged_out_unverified', false);
  v_ok    boolean;
BEGIN
  IF NEW.status <> 'resolved' OR OLD.status = 'resolved' THEN
    RETURN NEW;
  END IF;

  IF length(v_cause) < 40 THEN
    RAISE EXCEPTION
      'An incident is not resolved until the cause is written down. Supply root_cause: what was actually wrong, in a sentence (at least 40 characters). Got %.',
      CASE WHEN v_cause = '' THEN 'nothing' ELSE '"' || v_cause || '"' END
      USING ERRCODE = 'P0404';
  END IF;

  -- 2026-09-01: the auto_repair_status='repaired' bypass is GONE. Any writer
  -- could set that flag in the same UPDATE that resolved, which made the law
  -- optional for exactly the actor it was written to govern (the same shape
  -- as the [allow-revert] token incident of 2026-08-31). The automated
  -- reconciler now writes 'verified: <evidence>' like every other resolver.
  --
  -- 2026-09-20: 'aged-out:' joins the list, FENCED OFF from 'verified:' in
  -- BOTH directions. Until today the escalation tick closed a silence-retired
  -- incident with correction_ref 'verified: not seen again for N hours', so an
  -- unread event stream and a re-measured all-clear were recorded with the
  -- same word in the same field - 43 rows carry that wording. Silence is
  -- "I could not tell" (law 10.86 rule 1). It gets its own prefix, and the two
  -- can no longer be mistaken for one another.
  v_ok := v_ref ~* '^(migration\s+\S|PR\s*#\d|chip_ledger\s+\S|correction:\S)'
       OR v_ref ~* '^(ruling:|verified:|no-change-needed:|aged-out:)\s*\S';

  IF NOT v_ok THEN
    RAISE EXCEPTION
      'An incident is not resolved until something stops it happening again. Supply correction_ref as one of: "migration <name>", "PR #<n>", "chip_ledger <id>", "correction:<key>", "ruling: <decision>", "verified: <evidence>", "aged-out: <what went quiet>", or "no-change-needed: <why>". Got %.',
      CASE WHEN v_ref = '' THEN 'nothing' ELSE '"' || v_ref || '"' END
      USING ERRCODE = 'P0404';
  END IF;

  IF v_aged AND v_ref !~* '^aged-out:\s*\S' THEN
    RAISE EXCEPTION
      'closure_basis is ''aged_out_unverified'', so correction_ref must begin "aged-out: ". An incident retired because its event stream went quiet was not verified, and must not be filed under any evidence prefix. Got %.',
      CASE WHEN v_ref = '' THEN 'nothing' ELSE '"' || v_ref || '"' END
      USING ERRCODE = 'P0404';
  END IF;

  IF NOT v_aged AND v_ref ~* '^aged-out:' THEN
    RAISE EXCEPTION
      'correction_ref begins "aged-out: " but closure_basis is %. Set closure_basis to ''aged_out_unverified'', or supply real evidence under one of the other prefixes.',
      COALESCE('''' || NEW.closure_basis || '''', 'not set')
      USING ERRCODE = 'P0404';
  END IF;

  RETURN NEW;
END;
$function$
;
