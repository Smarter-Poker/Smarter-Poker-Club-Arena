WITH recent AS MATERIALIZED (
  SELECT id,table_id,hand_number,created_at
  FROM public.hand_history WHERE created_at>now()-interval '24 hours'
), receipts AS MATERIALIZED (
  SELECT hand_id,table_id,hand_number FROM public.hand_atomic_commits
  WHERE hand_number BETWEEN (SELECT min(hand_number) FROM recent)
                        AND (SELECT max(hand_number) FROM recent)
)
SELECT count(*) AS hands_24h,count(c.hand_id) AS commits_24h,
       count(*) FILTER(WHERE h.created_at>now()-interval '60 minutes') AS hands_1h,
       count(c.hand_id) FILTER(WHERE h.created_at>now()-interval '60 minutes') AS commits_1h
FROM recent h LEFT JOIN receipts c
 ON c.hand_id=h.id AND c.table_id=h.table_id AND c.hand_number=h.hand_number
