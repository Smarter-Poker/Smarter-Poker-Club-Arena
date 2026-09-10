-- Native fixture: exact captured installed view, options and grants.
CREATE VIEW public.agent_commissions_unsettled WITH(security_invoker=true) AS
 SELECT id,
    club_id,
    user_id,
    amount,
    commission_rate,
    source_type,
    source_id,
    notes,
    created_at,
    settled_at
   FROM agent_commissions ac
  WHERE settled_at IS NULL AND NOT (EXISTS ( SELECT 1
           FROM agent_commission_settlements s
          WHERE s.club_id = ac.club_id AND s.user_id = ac.user_id AND ac.created_at >= s.period_start AND ac.created_at < s.period_end));
REVOKE ALL ON public.agent_commissions_unsettled FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT,REFERENCES,TRIGGER,MAINTAIN ON public.agent_commissions_unsettled TO authenticated;
GRANT ALL ON public.agent_commissions_unsettled TO service_role;
