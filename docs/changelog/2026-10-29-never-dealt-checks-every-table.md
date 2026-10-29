# Never-dealt evidence covers the whole tournament

GameServer read only the first 1,000 tournament tables before counting completed hands. A hand on the next table was invisible, so a running manager could be retired as never-dealt. A failed second page was also invisible.

The original decision now requires a complete ID-paged table inventory. Exact history and seat counts use at most 200 table IDs per request. Any unreadable page/count or retired generation prevents retirement. The existing age, ownership, original-hand and admission safeguards remain. No new sweep or repair loop.

Two real GameServer discovery regressions fail before the change and exercise a completed hand at table 1,001 and a failed second page. This boundary defect is not established as the cause of the current smaller stalled events. After the fix, 13 focused and 79 connected tests pass, including unreadable seat chunks and generation shutdown during the history read. Root and server TypeScript checks pass. Source reread and diff whitespace check pass. Hosted checks and engine activation remain pending.
