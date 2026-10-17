# tests/a-deleted-wallet-return-takes-the-lock-the-stage-holds.law.test.ts

The deleted-wallet bank return locks agents, club_members and clubs FOR NO KEY UPDATE, the lock the round-3 rakeback stage already holds, so a hand inserting rows against the club can no longer deadlock the weekly close.
