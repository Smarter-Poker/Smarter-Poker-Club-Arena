-- Retire raw review cards/actions through the original immutable settled-horse
-- disposal boundary. Preserve all review summaries and replay identities.
BEGIN;
SET LOCAL lock_timeout='2s';
DO $guard$ BEGIN
 IF md5(pg_get_functiondef('public.sp_prune_horse_hand_reviews()'::regprocedure)) IS DISTINCT FROM '4c237420934d9afa9f6800125ef95d2a'
 OR md5(pg_get_functiondef('smarter_private.horse_adaptive_disposal_certificate_matches(uuid,uuid,bigint,text)'::regprocedure)) IS DISTINCT FROM 'b512986eabb51dc559d4bc2d138b2a39'
 THEN RAISE EXCEPTION 'HORSE_REVIEW_RETENTION_PREIMAGE_CHANGED'; END IF;
END $guard$;
CREATE FUNCTION smarter_private.horse_review_raw_disposable(p_hand uuid,p_table uuid,p_played timestamptz) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,smarter_private AS $fn$
 SELECT COALESCE(isfinite(p_played) AND p_played<statement_timestamp()-interval '8 days'
 AND EXISTS(SELECT 1 FROM smarter_private.horse_adaptive_disposal_certificates c
 WHERE c.hand_id=p_hand AND c.table_id=p_table
 AND smarter_private.horse_adaptive_disposal_certificate_matches(c.hand_id,c.table_id,c.hand_number,c.request_hash)),false)
$fn$;
REVOKE ALL ON FUNCTION smarter_private.horse_review_raw_disposable(uuid,uuid,timestamptz) FROM PUBLIC,anon,authenticated,service_role;
CREATE FUNCTION smarter_private.horse_review_raw_retention_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,smarter_private SET lock_timeout='2s' AS $fn$
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended('horse-review-retention:'||NEW.hand_id::text,0));
 IF TG_OP='UPDATE' AND (NEW.hand_id IS DISTINCT FROM OLD.hand_id OR NEW.table_id IS DISTINCT FROM OLD.table_id OR NEW.played_at IS DISTINCT FROM OLD.played_at)
 THEN RAISE EXCEPTION 'HORSE_REVIEW_RETENTION_IDENTITY_IMMUTABLE'; END IF;
 IF smarter_private.horse_review_raw_disposable(NEW.hand_id,NEW.table_id,NEW.played_at) THEN
  NEW.hole_cards:=NULL; NEW.board:=NULL; NEW.actions:=NULL;
 END IF;
 RETURN NEW;
END $fn$;
REVOKE ALL ON FUNCTION smarter_private.horse_review_raw_retention_guard() FROM PUBLIC,anon,authenticated,service_role;
CREATE TRIGGER horse_review_raw_retention_guard BEFORE INSERT OR UPDATE ON public.horse_hand_reviews FOR EACH ROW EXECUTE FUNCTION smarter_private.horse_review_raw_retention_guard();
CREATE FUNCTION smarter_private.compact_horse_review_raw(p_hands uuid[]) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,smarter_private SET lock_timeout='2s' AS $fn$
DECLARE n integer;
BEGIN
 IF cardinality(p_hands)>250 THEN RAISE EXCEPTION 'HORSE_REVIEW_RETENTION_BATCH_TOO_LARGE'; END IF;
 UPDATE public.horse_hand_reviews r SET hole_cards=NULL,board=NULL,actions=NULL
 WHERE r.hand_id=ANY(p_hands) AND (r.hole_cards IS NOT NULL OR r.board IS NOT NULL OR r.actions IS NOT NULL)
 AND smarter_private.horse_review_raw_disposable(r.hand_id,r.table_id,r.played_at);
 GET DIAGNOSTICS n=ROW_COUNT; RETURN n;
END $fn$;
REVOKE ALL ON FUNCTION smarter_private.compact_horse_review_raw(uuid[]) FROM PUBLIC,anon,authenticated,service_role;
CREATE FUNCTION smarter_private.horse_review_raw_on_disposal() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,smarter_private AS $fn$
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended('horse-review-retention:'||NEW.hand_id::text,0));
 PERFORM smarter_private.compact_horse_review_raw(ARRAY[NEW.hand_id]); RETURN NEW;
END $fn$;
REVOKE ALL ON FUNCTION smarter_private.horse_review_raw_on_disposal() FROM PUBLIC,anon,authenticated,service_role;
CREATE TRIGGER horse_review_raw_on_disposal AFTER INSERT ON smarter_private.horse_adaptive_disposal_certificates FOR EACH ROW EXECUTE FUNCTION smarter_private.horse_review_raw_on_disposal();
-- Preserve the original non-review business horizons. Whole review deletion
-- must itself prove original horse-only successful completion; a current horse
-- profile or the age of a review never supplies that proof.
DO $patch$
DECLARE original text; replacement text;
BEGIN
 original:=pg_get_functiondef('public.sp_prune_horse_hand_reviews()'::regprocedure);
 replacement:=replace(original,'  delete from horse_hand_reviews where created_at < now() - interval ''30 days'';',
 '  PERFORM smarter_private.compact_horse_review_raw(ARRAY(SELECT c.hand_id FROM smarter_private.horse_adaptive_disposal_certificates c JOIN public.horse_hand_reviews r ON r.hand_id=c.hand_id WHERE (r.hole_cards IS NOT NULL OR r.board IS NOT NULL OR r.actions IS NOT NULL) AND smarter_private.horse_review_raw_disposable(r.hand_id,r.table_id,r.played_at) ORDER BY c.qualified_at LIMIT 250));
  delete from horse_hand_reviews r where id IN (SELECT h.id FROM smarter_private.horse_adaptive_disposal_certificates c JOIN public.horse_hand_reviews h ON h.hand_id=c.hand_id WHERE h.created_at < now() - interval ''30 days'' AND smarter_private.horse_review_raw_disposable(h.hand_id,h.table_id,h.played_at) ORDER BY c.qualified_at,h.id LIMIT 250);');
 IF replacement=original THEN RAISE EXCEPTION 'HORSE_REVIEW_RETENTION_ANCHOR_CHANGED'; END IF;
 EXECUTE replacement;
END $patch$;
COMMENT ON FUNCTION smarter_private.compact_horse_review_raw(uuid[]) IS 'Eight-day successful original horse-only raw review retention. Removes only hole_cards/board/actions; all net, leak, identity, receipt and diagnostic values remain. At most 250 supplied hand identities.';
COMMIT;
