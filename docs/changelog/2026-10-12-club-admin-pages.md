# Club Administration Pages

Scope: the nine owner-linked Operations, Dashboard, Player Command, Reports, Hand Review, Club Data, Control, Settings and Leaderboards pages. Remove page frames, simplify mobile layouts, add applicant review, and verify the connected actions. Preserve financial rules, existing API contracts, ownership checks, roster workspace persistence and other tasks. No engine change is planned.

Owner: this Codex task. Checkout: /Volumes/SmarterWork/agent-work/club-admin-pages-20261012/client. Branch: fix/club-admin-pages-20261012. Base: 8816e3f9f672e73bc5884ea04279c6e836ed3482. PR/publication pending.

Policy receipt: version 2.9; manifest a659f31c5c1c2b0864889508079a635dd5fe2fc98decfbfc9d3f9c80dd45ec3b. Full canonical policies and portable policy reader reviewed, with storage guide, root instructions, publishing/deploy paths, console skill and Operations history. Emission retained in /Volumes/SmarterArchives/agent-evidence/club-admin-pages-20261012/policy-read.txt. Later owner direction explicitly removes the console frames on the named pages.

Acceptance: responsive at 375, 393, 430 and desktop; readable loading/empty/error states; applicant list and authenticated review path; functional Control destinations and Settings save/readback; exact candidate checks, protected merge, static publication, both provenance endpoints and affected-route live proof. Production applicant decisions and financial changes are not test fixtures.

Live baseline: Operations has a narrow 660px framed hero; Control has a tall empty chassis and links below the fold; Settings has no title/navigation and a 600px single-column generic form. Applicant queue exists through fn_list_pending_members/fn_review_join_request but is absent from Player Command.

Status: implementation complete; protected integration, publication and live candidate proof pending. Unframed shared sections now serve Operations, Reports, Hand Review, Club Data, Leaderboards and Play Records. Dashboard uses the approved table command artwork, compact live readings and responsive content. Player Command uses one roster filter and links Applicants. Control writes through the existing authenticated message RPC; Settings retains existing persistence and adds synchronous duplicate-save protection. Find Player advanced filters are collapsed, and the notification prompt uses the approved popup artwork.

Owner scope update: Leaderboards outer frame removal and normal responsive rankings added during implementation.

Owner scope additions: all Play Records tabs (Overview, Tournaments, Results, Hands, Sessions, Leaderboards) lose their generic page frames. Find A Player reduces introductory copy and collapses advanced filters; notification opt-in uses the approved painted popup while preserving synchronous permission requests and cooldown policy.

Resumption reading: 2026-10-12T19:17:36Z canonical version 2.9 with the same manifest hash; full policies, root instructions, CLAUDE.md, publishing, deploy paths, storage and current checkpoint reviewed. No engine or database source change.

Validation: focused connected checks passed (172 tests), Control/Applicants (14), extended visual/search/push checks (64), and final roster/route/header/popup/recovery checks (101). The broad run had 36,291 passing tests, 16 failures and one existing skip; changed UI expectation failures were repaired and passed in focused checks. Remaining Git/subprocess tests exceeded their ordinary five-second deadline under the broad run; isolation on one worker is in progress, with no deadline or assertion weakened. Local phone/desktop source previews use explicitly synthetic backend data; live approval decisions and financial writes are excluded.
