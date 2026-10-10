-- Agent wallets are not in WAL publication. Invalidate permitted roster reads
-- at their authoritative row change, without publishing balances or hot rows.
BEGIN;
SET LOCAL lock_timeout = '4s';
SET LOCAL statement_timeout = '30s';

CREATE POLICY "club members receive roster wallet signals"
ON realtime.messages FOR SELECT TO authenticated
USING (extension = 'broadcast' AND EXISTS (
  SELECT 1 FROM (SELECT CASE
    WHEN realtime.topic() ~ '^club-roster-wallet:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    THEN split_part(realtime.topic(), ':', 2)::uuid ELSE NULL END AS club_id) topic
  WHERE topic.club_id IS NOT NULL AND (SELECT auth.uid()) IS NOT NULL AND (
    EXISTS (SELECT 1 FROM public.club_members m
      WHERE m.club_id = topic.club_id AND m.user_id = (SELECT auth.uid())
        AND coalesce(m.status, 'approved') IN ('active','approved'))
    OR EXISTS (SELECT 1 FROM public.profiles p
      WHERE p.id = (SELECT auth.uid()) AND p.is_admin)
    OR public.fn_union_oversees_club(topic.club_id, (SELECT auth.uid()))
  )
));

CREATE FUNCTION public.fn_publish_agent_wallet_change()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
BEGIN
  IF TG_OP = 'UPDATE' AND
    ROW(OLD.club_id, OLD.user_id, OLD.status, OLD.agent_wallet_balance, OLD.promo_wallet_balance)
    IS NOT DISTINCT FROM
    ROW(NEW.club_id, NEW.user_id, NEW.status, NEW.agent_wallet_balance, NEW.promo_wallet_balance)
  THEN RETURN NEW; END IF;
  -- Transport failure cannot roll back an authoritative financial transaction.
  -- Rejoin/visibility re-reads recover persisted balances, with no repair loop.
  BEGIN
    IF TG_OP <> 'INSERT' THEN
      PERFORM realtime.send(jsonb_build_object('club_id', OLD.club_id, 'user_id', OLD.user_id),
        'wallet_changed', 'club-roster-wallet:' || OLD.club_id::text, true);
    END IF;
    IF TG_OP = 'INSERT' OR (TG_OP = 'UPDATE' AND
      ROW(OLD.club_id, OLD.user_id) IS DISTINCT FROM ROW(NEW.club_id, NEW.user_id)) THEN
      PERFORM realtime.send(jsonb_build_object('club_id', NEW.club_id, 'user_id', NEW.user_id),
        'wallet_changed', 'club-roster-wallet:' || NEW.club_id::text, true);
    END IF;
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'Agent wallet signal delivery failed: %', SQLERRM;
  END;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$function$;
REVOKE ALL ON FUNCTION public.fn_publish_agent_wallet_change()
  FROM PUBLIC, anon, authenticated, service_role;

CREATE TRIGGER agent_wallet_changed
AFTER INSERT OR DELETE OR UPDATE OF club_id,user_id,status,agent_wallet_balance,promo_wallet_balance
ON public.agents FOR EACH ROW EXECUTE FUNCTION public.fn_publish_agent_wallet_change();

INSERT INTO public.ca_declared_money_triggers(table_name,trigger_name,note)
VALUES ('agents','agent_wallet_changed','Private identity-only wallet invalidation; no balances broadcast and transport failure cannot roll back a financial write.');

COMMENT ON FUNCTION public.fn_publish_agent_wallet_change() IS
'Private bounded wallet invalidation containing only club/user identity; unchanged values emit nothing and transport failure never rolls back source.';
COMMIT;
