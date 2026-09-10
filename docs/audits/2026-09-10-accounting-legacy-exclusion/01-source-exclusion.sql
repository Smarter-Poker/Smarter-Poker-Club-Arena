-- UNAPPLIED. The marker is prospective and immutable; historical NULL remains payable.
-- Marker 1 never falls back to a historical payer, even when capture is deferred.
CREATE FUNCTION public.fn_ca_commission_uses_captured_source(p_source_type text,p_source_id uuid)
RETURNS boolean LANGUAGE sql STABLE SET search_path TO public,pg_temp AS $f$
 SELECT coalesce(p_source_type='rake_settlement',false) AND EXISTS(
  SELECT 1 FROM public.hand_atomic_commits h
  WHERE h.hand_id=p_source_id AND h.commission_capture_version=1);
$f$;
REVOKE ALL ON FUNCTION public.fn_ca_commission_uses_captured_source(text,uuid)
 FROM PUBLIC,anon,authenticated,service_role;
-- This local marker makes the legacy-open partial index bounded after cutover.
CREATE FUNCTION public.fn_ca_classify_commission_source() RETURNS trigger
LANGUAGE plpgsql SET search_path TO public,pg_temp AS $f$
DECLARE v_expected integer;
BEGIN
 IF TG_OP='UPDATE' THEN
   IF NEW.source_type IS DISTINCT FROM OLD.source_type
     OR NEW.source_id IS DISTINCT FROM OLD.source_id
     OR NEW.commission_capture_version IS DISTINCT FROM OLD.commission_capture_version THEN
     RAISE EXCEPTION 'Commission source identity and authority are immutable' USING ERRCODE='23514';
   END IF;
   RETURN NEW;
 END IF;
 v_expected:=CASE WHEN public.fn_ca_commission_uses_captured_source(NEW.source_type,NEW.source_id) THEN 1 ELSE NULL END;
 IF NEW.commission_capture_version IS NOT NULL AND NEW.commission_capture_version IS DISTINCT FROM v_expected THEN
   RAISE EXCEPTION 'Commission source authority contradicts accepted hand' USING ERRCODE='23514';
 END IF;
 NEW.commission_capture_version:=v_expected;
 RETURN NEW;
END $f$;
REVOKE ALL ON FUNCTION public.fn_ca_classify_commission_source() FROM PUBLIC,anon,authenticated,service_role;
CREATE TRIGGER aa_classify_commission_source BEFORE INSERT OR UPDATE OF source_type,source_id,commission_capture_version
 ON public.agent_commissions FOR EACH ROW EXECUTE FUNCTION public.fn_ca_classify_commission_source();
-- Compiled old owners may reach this relation after replacement of their bodies.
-- Validate the final monetary receipt against the exact still-payable legacy basis.
-- A mismatch raises and rolls back the earlier debit and credit in the same call.
CREATE FUNCTION public.fn_ca_legacy_commission_receipt_excludes_captured() RETURNS trigger
LANGUAGE plpgsql SET search_path TO public,pg_temp AS $f$
DECLARE v_amount numeric;v_rows bigint;
BEGIN
 -- Every final receipt is checked, including historical-only windows. This also
 -- rejects an old Round2 cursor whose historical basis became paid while it waited.
 SELECT coalesce(sum(ac.amount),0),count(*) INTO v_amount,v_rows
 FROM public.agent_commissions ac
 WHERE ac.club_id=NEW.club_id AND ac.user_id=NEW.user_id
   AND ac.created_at>=NEW.period_start AND ac.created_at<NEW.period_end
   AND ac.settled_at IS NULL
   AND ac.commission_capture_version IS NULL
   AND NOT EXISTS(SELECT 1 FROM public.agent_commission_settlements s
     WHERE s.club_id=ac.club_id AND s.user_id=ac.user_id
       AND ac.created_at>=s.period_start AND ac.created_at<s.period_end);
 IF NEW.amount IS DISTINCT FROM round(v_amount,2) OR NEW.rows_count IS DISTINCT FROM v_rows THEN
   RAISE EXCEPTION 'Legacy commission receipt includes captured source or stale payable basis; retry'
     USING ERRCODE='40001';
 END IF;
 RETURN NEW;
END $f$;
REVOKE ALL ON FUNCTION public.fn_ca_legacy_commission_receipt_excludes_captured()
 FROM PUBLIC,anon,authenticated,service_role;
CREATE TRIGGER ca_legacy_commission_receipt_excludes_captured BEFORE INSERT
 ON public.agent_commission_settlements FOR EACH ROW
 EXECUTE FUNCTION public.fn_ca_legacy_commission_receipt_excludes_captured();
