BEGIN;
SELECT fn_union_pnl_certify_posthand_escrow('1c531058-25b9-4aad-b4f0-1641d1d085ea',31008564,md5(fn_union_pnl_prove_posthand_escrow('1c531058-25b9-4aad-b4f0-1641d1d085ea',31008564)::text),encode(extensions.digest(convert_to(smarter_private.posthand_escrow_original_snapshot('1c531058-25b9-4aad-b4f0-1641d1d085ea',31008564)::text,'UTF8'),'sha256'),'hex'));
\ir boundaries.sql
\ir projection-boundaries.sql
\ir certificate-corruption.sql
DO $test$ DECLARE proof jsonb;old_sha text;BEGIN
 SELECT original_sha256 INTO STRICT old_sha FROM smarter_private.posthand_escrow_certificates;
 IF old_sha!~'^[a-f0-9]{64}$' OR EXISTS(SELECT 1 FROM smarter_private.posthand_escrow_certificates WHERE original::text~'(hole_cards|community_cards|stats_facts|actions|accepted_hand_facts)') THEN RAISE EXCEPTION 'certificate retained raw play';END IF;
 BEGIN PERFORM fn_union_pnl_certify_posthand_escrow('1c531058-25b9-4aad-b4f0-1641d1d085ea',31008564,md5(fn_union_pnl_prove_posthand_escrow('1c531058-25b9-4aad-b4f0-1641d1d085ea',31008564)::text),encode(extensions.digest(convert_to(smarter_private.posthand_escrow_original_snapshot('1c531058-25b9-4aad-b4f0-1641d1d085ea',31008564)::text,'UTF8'),'sha256'),'hex'));RAISE EXCEPTION 'duplicate admitted';EXCEPTION WHEN SQLSTATE '55000' THEN IF SQLERRM<>'POSTHAND_ESCROW_CERTIFICATE_ALREADY_EXISTS' THEN RAISE;END IF;END;
 RAISE NOTICE 'PASS bounded original certificate, no raw cards/play, duplicate refuses';
 BEGIN UPDATE smarter_private.posthand_escrow_certificates SET original=original||'{"pending_ids":[]}';RAISE EXCEPTION 'certificate update admitted';EXCEPTION WHEN SQLSTATE '55000' THEN IF SQLERRM<>'POSTHAND_ESCROW_CERTIFICATE_IMMUTABLE' THEN RAISE;END IF;END;
 BEGIN DELETE FROM smarter_private.posthand_escrow_certificates;RAISE EXCEPTION 'certificate delete admitted';EXCEPTION WHEN SQLSTATE '55000' THEN IF SQLERRM<>'POSTHAND_ESCROW_CERTIFICATE_IMMUTABLE' THEN RAISE;END IF;END;
 BEGIN TRUNCATE smarter_private.posthand_escrow_certificates;RAISE EXCEPTION 'certificate truncate admitted';EXCEPTION WHEN SQLSTATE '55000' THEN IF SQLERRM<>'POSTHAND_ESCROW_CERTIFICATE_IMMUTABLE' THEN RAISE;END IF;END;
 RAISE NOTICE 'PASS immutable update/delete/truncate refuses';
 DELETE FROM hand_atomic_commits WHERE hand_number=31008564;
 proof:=fn_union_pnl_prove_posthand_escrow('1c531058-25b9-4aad-b4f0-1641d1d085ea',31008564);
 IF proof->>'status' IS DISTINCT FROM 'proven' THEN RAISE EXCEPTION 'retained canonical original certificate unproved: %',proof;END IF;
 RAISE NOTICE 'PASS raw canonical absent, original sealed pending-ID certificate preserves exact proof';
END $test$;
\ir hand-lines-after.sql
\i :arithmetic_after
\i :arithmetic_after_projected
ROLLBACK;
DO $test$BEGIN IF EXISTS(SELECT 1 FROM smarter_private.posthand_escrow_certificates) OR NOT EXISTS(SELECT 1 FROM hand_atomic_commits WHERE hand_number=31008564) THEN RAISE EXCEPTION 'certificate rollback failed';END IF;RAISE NOTICE 'PASS certificate/raw-removal trial rolls back exact originals';END $test$;
