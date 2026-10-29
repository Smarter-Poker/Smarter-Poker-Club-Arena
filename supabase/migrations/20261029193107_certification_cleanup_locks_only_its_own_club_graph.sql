-- Reserved by scripts/new-migration.mjs. Production preimages read 2026-10-29.
-- At 19:13:47 UTC PostgreSQL identified welcome cleanup PID4068188 holding
-- global gate530090,1 while live continuation writers timed out (36 records).
-- A try-lock avoids queue starvation but still blocks players once acquired.
-- Existing retired-club triggers take FOR KEY SHARE on the owning club for
-- gameplay/cashier writes. Use that existing scope exclusively, NOWAIT, while
-- retaining shared maintenance admission. All fixture identity, activity,
-- custody, monetary and transaction-bound deletion checks remain unchanged.
-- Cash games/schedules lack club FKs: a writer released after fixture deletion
-- must refuse the now-missing parent, rather than commit an orphan.
-- @live-proof: md5(pg_get_functiondef('public.fn_ca_prepare_unused_welcome_certification_board_leases(uuid)'::regprocedure))='9b0480f2e3b78233289c31f8484a5bb2' AND md5(pg_get_functiondef('public.fn_guard_retired_club_mutation()'::regprocedure))='66b05912e3963815a560db03d54c74c9' AND md5(pg_get_functiondef('public.fn_ca_prepare_post_reset_welcome_certification_fixture(uuid)'::regprocedure))='c0c18ff26859194b2ad98d3186b30f1d' AND md5(pg_get_functiondef('public.fn_ca_prepare_unused_welcome_certification_board_games(uuid)'::regprocedure))='11c2a704620600fad8b91d50f3b64e1a' AND md5(pg_get_functiondef('public.fn_ca_prepare_unused_welcome_certification_board_origins(uuid)'::regprocedure))='8bf604a9e6ea826412234d552e83e2a9' AND NOT has_function_privilege('service_role','smarter_private.certification_club_admission(uuid)','EXECUTE')
BEGIN;
SET LOCAL lock_timeout='1s';
SET LOCAL statement_timeout='30s';
CREATE FUNCTION smarter_private.certification_club_admission(p_club_id uuid)
RETURNS void LANGUAGE plpgsql SET search_path=pg_catalog AS $admission$
BEGIN
  IF NOT pg_try_advisory_xact_lock_shared(530090,1) THEN
    RAISE EXCEPTION 'CERTIFICATION_FIXTURE_MAINTENANCE_BUSY' USING ERRCODE='55P03';
  END IF;
  PERFORM 1 FROM public.clubs WHERE id=p_club_id FOR UPDATE NOWAIT;
END
$admission$;
REVOKE ALL ON FUNCTION smarter_private.certification_club_admission(uuid)
  FROM PUBLIC,anon,authenticated,service_role;
DO $patch$
DECLARE item record; before_text text; after_text text; signature regprocedure;
 prior_acl aclitem[];
 old_gate text := $oldgate$  /* A CERTIFICATION FIXTURE NEVER QUEUES IN FRONT OF THE PLATFORM (2026-10-03).
     Every buy-in, registration, seat and launch takes this gate SHARED. A
     waiting exclusive request sits in the lock queue and every later shared
     request queues behind it, so while this fixture waited for the gate the
     whole platform's purchases waited for the fixture (in the 24 h to 00:30
     UTC 2026-10-04: 79 fixture waits of 1 s or more, up to 7.6 s, with about
     4,500 purchase waits of 1 s or more on the gate). The fixture now asks
     without queueing, every 50 ms for up to 30 s, and still holds the gate
     exclusively to the end of its transaction once it has it. */
  DECLARE
    v_gate_tries integer := 0;
  BEGIN
    PERFORM smarter_private.certification_retention_admission();
    WHILE NOT pg_try_advisory_xact_lock(530090,1) LOOP
      v_gate_tries := v_gate_tries + 1;
      IF v_gate_tries >= 600 THEN
        RAISE EXCEPTION 'CERTIFICATION_FIXTURE_GATE_BUSY' USING ERRCODE = '55P03';
      END IF;
      PERFORM pg_sleep(0.05);
    END LOOP;
  END;
$oldgate$;
 old_read text := '  SELECT * INTO v_club FROM public.clubs WHERE id=p_club_id';
 new_read text := E'  PERFORM smarter_private.certification_club_admission(p_club_id);\n  SELECT * INTO v_club FROM public.clubs WHERE id=p_club_id';
BEGIN
  FOR item IN SELECT * FROM (VALUES
    ('public.fn_ca_prepare_unused_welcome_certification_board_leases(uuid)','52135b92428b122b02b2bb6094758442'),
    ('public.fn_ca_prepare_post_reset_welcome_certification_fixture(uuid)','463ffcd7f4a6cc77ccc648a033a9a618'),
    ('public.fn_ca_prepare_unused_welcome_certification_board_games(uuid)','023dad99aeb5671a19cbc83ba622d2d4'),
    ('public.fn_ca_prepare_unused_welcome_certification_board_origins(uuid)','7d43b2872d4dad240b67c4c2267c6d50')
  ) p(sig,pre_hash) LOOP
    signature:=item.sig::regprocedure;
    before_text:=pg_get_functiondef(signature);
    SELECT proacl INTO prior_acl FROM pg_proc WHERE oid=signature;
    IF md5(before_text)<>item.pre_hash
       OR strpos(before_text,old_read)=0
       OR (length(before_text)-length(replace(before_text,old_gate,'')))/length(old_gate)<>1 THEN
      RAISE EXCEPTION 'CERTIFICATION_CLUB_SCOPE_PREIMAGE_CHANGED: %',item.sig;
    END IF;
    -- Only the first club read gets admission; post-reset revalidates it later.
    after_text:=replace(before_text,old_gate,'');
    after_text:=overlay(after_text placing new_read from strpos(after_text,old_read) for length(old_read));
    EXECUTE after_text;
    IF pg_get_functiondef(signature)<>after_text
       OR (SELECT proacl FROM pg_proc WHERE oid=signature) IS DISTINCT FROM prior_acl
       OR has_function_privilege('anon',signature,'EXECUTE')
       OR has_function_privilege('authenticated',signature,'EXECUTE')
       OR has_function_privilege('service_role',signature,'EXECUTE') THEN
      RAISE EXCEPTION 'CERTIFICATION_CLUB_SCOPE_POSTIMAGE_CHANGED: %',item.sig;
    END IF;
  END LOOP;
END
$patch$;
DO $guard$
DECLARE before_text text; after_text text; prior_acl aclitem[];
 anchor text := '  IF (v_club_id IS NOT NULL OR v_old_club_id IS NOT NULL) AND EXISTS (';
 addition text := $missing$  -- These two owning stores have no club FK. Recheck after the shared
  -- parent lock: cleanup may have deleted that parent while this writer waited.
  IF TG_OP <> 'DELETE' AND TG_TABLE_NAME IN ('cash_games','tournament_schedules')
     AND v_club_id IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM public.clubs WHERE id=v_club_id) THEN
    RAISE EXCEPTION 'CLUB_NOT_FOUND: game records require their owning club'
      USING ERRCODE='23503';
  END IF;

$missing$;
BEGIN
 SELECT proacl INTO prior_acl FROM pg_proc WHERE oid='public.fn_guard_retired_club_mutation()'::regprocedure;
 before_text:=pg_get_functiondef('public.fn_guard_retired_club_mutation()'::regprocedure);
 IF md5(before_text)<>'941df8f6c1a4857d46885ddf7c1941d8' OR (length(before_text)-length(replace(before_text,anchor,'')))/length(anchor)<>1 THEN
  RAISE EXCEPTION 'CERTIFICATION_PARENT_GUARD_PREIMAGE_CHANGED';
 END IF;
 EXECUTE replace(before_text,anchor,addition||anchor);
 after_text:=pg_get_functiondef('public.fn_guard_retired_club_mutation()'::regprocedure);
 IF replace(after_text,addition,'')<>before_text OR
   (SELECT proacl FROM pg_proc WHERE oid='public.fn_guard_retired_club_mutation()'::regprocedure) IS DISTINCT FROM prior_acl THEN
  RAISE EXCEPTION 'CERTIFICATION_PARENT_GUARD_POSTIMAGE_CHANGED';
 END IF;
END
$guard$;
COMMIT;
