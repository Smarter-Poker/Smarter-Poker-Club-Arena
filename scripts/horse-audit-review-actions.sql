-- One review, bounded public action pages. Example using configured psql auth:
-- psql -X -v review_id=2373791 -v after_action=0 -v page_size=8 -f scripts/horse-audit-review-actions.sql
-- Pass the last action_index as after_action. No action-list substring or
-- truncated JSON is treated as the end: total_actions/has_more are explicit.
-- Controller calls record chips paid; bets/raises/all_in record street totals.
-- Missing original public-node prices stay NULL, never reconstructed guesses.
WITH review AS (
  SELECT id, horse_user_id, actions FROM public.horse_hand_reviews
  WHERE id = :review_id::bigint
), page AS (
  SELECT r.id, r.horse_user_id, e.action, e.action_index,
         jsonb_array_length(r.actions) AS total_actions
  FROM review r CROSS JOIN LATERAL jsonb_array_elements(r.actions)
    WITH ORDINALITY e(action, action_index)
  WHERE e.action_index > :after_action::bigint
  ORDER BY e.action_index
  LIMIT least(8, greatest(1, :page_size::integer))
)
SELECT id AS review_id, action_index, total_actions,
       action_index < total_actions AS has_more,
       action->>'stage' AS street, action->>'action' AS action,
       action->'amount' AS amount,
       action->>'userId' = horse_user_id::text AS hero,
       coalesce(action->'publicNode'->>'status','unavailable') AS price_evidence,
       action->'publicNode'->'pot' AS pot_before,
       action->'publicNode'->'toCall' AS to_call,
       action->'publicNode'->'currentBet' AS current_bet,
       action->'publicNode'->'minRaiseTo' AS min_raise_to,
       action->'publicNode'->'maxRaiseTo' AS max_raise_to
FROM page ORDER BY action_index;
