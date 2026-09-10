-- UNAPPLIED. Run outside the coactivation transaction after 00-expand.sql.
CREATE INDEX CONCURRENTLY agent_commissions_legacy_open_source_idx
 ON public.agent_commissions(club_id,user_id,created_at)
 WHERE settled_at IS NULL AND commission_capture_version IS NULL;
