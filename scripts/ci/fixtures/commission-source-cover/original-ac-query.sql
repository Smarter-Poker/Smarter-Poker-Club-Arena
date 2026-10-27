   INSERT INTO pg_temp._rw_ac SELECT a.* FROM (SELECT s.source_type,s.source_id FROM pg_temp._rw_sources s ORDER BY s.source_id,s.source_type) s
    CROSS JOIN LATERAL (SELECT ac.source_type,ac.source_id,ac.club_id,ac.user_id,ac.amount,ac.commission_rate,ac.settled_at FROM public.agent_commissions ac
     WHERE ac.source_id=s.source_id AND ac.source_type=s.source_type OFFSET 0) a;