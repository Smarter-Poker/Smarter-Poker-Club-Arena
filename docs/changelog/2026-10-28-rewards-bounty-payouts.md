# Rewards Includes Bounty Winnings

Scope: Club Arena tournament Rewards payouts, including regular, progressive and mystery bounty winnings. Preserve place projections and all financial writes. Client-only; no new engine contract or migration.

Cause: the lobby snapshot and realtime mappings dropped tournament_players.bounty_winnings, and Rewards rendered only the place ladder. Carry the recorded cumulative cash awards through initial load, inserts, updates and snapshot recovery. Display place prize, bounties and total for decided places, plus bounty recipients outside the ladder (including players still in play). Current head values are never counted as received winnings.

Acceptance: every recorded bounty recipient appears; combined totals use recorded place prizes; realtime/reconnect retain the amount; non-bounty and satellite behavior remains intact; checks, protected merge, client publication and both public provenance endpoints plus affected live proof.

Policy receipt: 2026-10-29T01:19:43.713Z, policy 2.9, manifest a659f31c5c1c2b0864889508079a635dd5fe2fc98decfbfc9d3f9c80dd45ec3b. Full canonical four-policy reader output read; portable check against canonical matched. Base ac6a620704. Owner: chat 01a1853d, branch agent/rewards-bounty-payouts-20261028. Required root, publishing, deploy-path and console references read.

Validation: TypeScript app compiler passed; 42 focused tests passed and 329 covering tests passed (15 files). Five new assertions fail against the unchanged base and pass with the fix. Four copy gates and diff whitespace check passed. Browser renders captured at 393px and 1080px in /Volumes/SmarterArchives/agent-evidence/rewards-bounty-01a1853d/. Private locked root dependencies installed on the external SSD. GitHub repo permissions and required CA_ORIGIN secret names are present.

Production read-only baseline: tournament 853b3df9-9e15-4d05-97b1-7a38dd0345c1 has Rooster in 8th with prize 72.55 and bounty_winnings 97.00; waffle and button remain playing with 210.00 and 130.00 bounty_winnings. This confirms the counter contains received amounts missing from the pictured view. Source fn_collect_bounty and terminal residual settlement increment bounty_winnings with cash awards, including the champion award; current_bounty is excluded from received totals.

Delivery: protected checks, merge, publisher and live proof pending.
