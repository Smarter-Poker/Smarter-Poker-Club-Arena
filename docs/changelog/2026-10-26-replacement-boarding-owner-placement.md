# Replacement boarding follows the original owner placement

The finite DSS boarding verifier expected a null agent, while the installed normal join owner now assigns an otherwise unassigned player to the club owner. The first ordinary join succeeded and retained its original receipt; verification then stopped.

Boarding now derives the exact expected Kingfish placement from fresh scoped club-owner, named-referral and settled owner-membership reads. It checks the original durable receipt and persisted member against that placement and rechecks authority before each remaining join. Different agents, authority errors or drift still refuse without rewriting an accepted membership. Original request IDs, subject login and capacity checks remain intact.

The native fixture captures the current join/referral definitions from migration `20261026031314_members_with_no_agent_sit_under_the_club_owner.sql`, pinned to the live catalog function hashes. Native cases cover Kingfish owner placement without an active agent row, the same placement with an active agent row, exact/concurrent replay, counters, zero chips and existing refusals. Service regression reproduces the original scope failure before the fix and resumes the accepted original receipt afterward. This is an operational CLI correction using existing APIs, with no engine activation dependency or database installation.
