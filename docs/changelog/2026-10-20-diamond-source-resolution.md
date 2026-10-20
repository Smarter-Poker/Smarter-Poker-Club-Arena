# Diamond resolution reaches its drift episode

The Diamond health source 912032 resolved at 2026-10-20 02:35 UTC, but its drift episode 9a49fa52-aef7-4ed2-b05c-e56eba78f85b remained open. Critical source insertion already paged through drift; source resolution had no corresponding transition.

The original source update now resolves its Diamond rule episode in the same transaction only when every critical source of that rule is resolved and the source has a resolution note. Insert and resolution share a transaction lock for the rule. Reopening a critical calls the existing paging authority. No scheduled repair is added. The migration re-saves the observed resolved source to deliver its missing transition without changing its resolution history.

Qualification uses isolated PostgreSQL for the actual trigger functions, source/drift persistence, multiple open sources, missing notes, unrelated rules/sources, duplicate updates, rollback, consumer failure and private privileges. Existing notification delivery remains covered by its existing qualification. Required CI executes this regression in accounting shard 3.
