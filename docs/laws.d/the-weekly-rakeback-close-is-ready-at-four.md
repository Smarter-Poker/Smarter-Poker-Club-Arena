# tests/the-weekly-rakeback-close-is-ready-at-four.law.test.ts

The weekly rakeback close is ready at four (2026-10-26): the running week's inventory seal layers are staged during the week as each six-hour window settles (ended over five minutes ago, no xid-holding or prepared transaction older than its end), never taking the running week's book lock and only once the week start is sealed; job 272 calls the close on every tick until every scope active in the last 14 days has had its first visit since 4:00 AM, for at most 12 hours.
