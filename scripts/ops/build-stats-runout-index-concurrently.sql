-- Run as one top-level statement on a direct session, never a transaction.
CREATE INDEX CONCURRENTLY idx_ca_hand_facts_runout_time_cover
 ON public.ca_hand_facts (played_at)
 INCLUDE (hand_id, all_in_equity)
 WHERE was_all_in = true AND went_to_showdown
   AND coalesce(all_in_street, '') <> 'river';
