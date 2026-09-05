# tests/a-complete-read-is-ordered-by-something-unique.law.test.ts

A paged `fetchAllRows` read over people-bearing rows ends its ordering with a unique column. `.range()` only partitions a set under a total order; /friends paged `friendships` by a `created_at` with 214-row tie groups and silently rendered 1,274 of 1,309 friends (2026-09-05).
