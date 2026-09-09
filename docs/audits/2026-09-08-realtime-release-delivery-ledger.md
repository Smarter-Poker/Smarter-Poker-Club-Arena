# Realtime continuation release audit, September 8

Snapshot UTC: 2026-09-08T13:47:49.534485+00:00

This audits delivery of the 33 continuation PRs and the separately named
#3641 integration PR. It is not certification that every requested behavior
is fixed. The reported frozen iPad table and long hand-gap outliers remain
open. A merged commit, a served artifact and a working user flow are separate
claims. Tests and a healthy engine do not establish the affected device flow.

Frontend served by Hetzner: `e981a26013af737d33484b11c43a943bf45613fb`. Engine: `e142d385`.

| PR    | Change                                                                         | On Main | Client Code In Served Frontend | Server Code In Running Engine |
| ----- | ------------------------------------------------------------------------------ | ------- | ------------------------------ | ----------------------------- |
| #3566 | fix(realtime): recover stalled channel handshakes                              | Yes     | Yes                            | Not An Engine Change          |
| #3573 | fix(realtime): prepare live table state from the lobby                         | Yes     | Yes                            | Not An Engine Change          |
| #3583 | fix(realtime): recover warm slots on renewed table intent                      | Yes     | Yes                            | Not An Engine Change          |
| #3592 | perf(engine): overlap independent next-hand input reads                        | Yes     | Not A Client Change            | Yes                           |
| #3601 | fix(realtime): bind prepared sockets to transport identity                     | Yes     | Yes                            | Not An Engine Change          |
| #3603 | fix(realtime): isolate pending auth across connection lifecycles               | Yes     | Yes                            | Not An Engine Change          |
| #3606 | fix(auth): keep stale session reads out of the token cache                     | Yes     | Yes                            | Not An Engine Change          |
| #3613 | fix(rabbit-hunt): keep delayed reveals on their purchased hand                 | Yes     | Yes                            | Not An Engine Change          |
| #3624 | fix: return paid rabbit cards without waiting on metadata                      | Yes     | Not A Client Change            | Yes                           |
| #3633 | agent/codex realtime continuation sep08/fix/unified reconnect protection       | Yes     | Not A Client Change            | Yes                           |
| #3637 | fix: retain database timeout through response body completion                  | Yes     | Not A Client Change            | Yes                           |
| #3640 | feat: expose bounded timing counters for settlement steps                      | Yes     | Not A Client Change            | Yes                           |
| #3641 | Integrated next-hand rest and Rabbit Hunt completion                           | Yes     | Yes                            | Yes                           |
| #3649 | perf: remove routine timer event console writes                                | Yes     | Not A Client Change            | Yes                           |
| #3663 | agent/codex realtime continuation sep08/fix/thaw reconnect allowance           | Yes     | Not A Client Change            | Yes                           |
| #3666 | fix(engine): reuse Rabbit Hunt purchase receipts after timeouts                | Yes     | Not A Client Change            | Yes                           |
| #3668 | agent/codex realtime continuation sep08/fix/bounded token connect              | Yes     | Yes                            | Not An Engine Change          |
| #3674 | fix(realtime): isolate shared channels across account changes                  | Yes     | Yes                            | Not An Engine Change          |
| #3676 | fix(db): index arena settings club foreign key                                 | Yes     | Not A Client Change            | Not An Engine Change          |
| #3681 | Avoid unchanged table summary round trip during settlement                     | Yes     | Not A Client Change            | Yes                           |
| #3683 | Reduce Omaha evaluation CPU with exhaustive score equivalence                  | Yes     | Not A Client Change            | Yes                           |
| #3685 | Correct stale Club Arena deployment summary to Hetzner origin                  | Yes     | Not A Client Change            | Not An Engine Change          |
| #3690 | Warm Spin and Sit N Go tables while their game panel is open                   | Yes     | Yes                            | Not An Engine Change          |
| #3691 | Bound speculative roster and token waits so table entry can recover            | Yes     | Yes                            | Not An Engine Change          |
| #3695 | fix: keep engine HTTP retries within their original login                      | Yes     | Yes                            | Not An Engine Change          |
| #3717 | fix: keep reconnection alive when the session probe hangs                      | Yes     | Yes                            | Not An Engine Change          |
| #3719 | fix: let spectators watch full running Spins and heads-up games                | Yes     | Yes                            | Not An Engine Change          |
| #3731 | perf: skip unchanged time-bank settlement requests                             | Yes     | Not A Client Change            | Yes                           |
| #3736 | fix: bound stale release shells and validate origin config before replacing it | Yes     | Not A Client Change            | Not An Engine Change          |
| #3744 | fix: bound engine HTTP authentication waits                                    | Yes     | Yes                            | Not An Engine Change          |
| #3746 | fix: install staged Caddy config with service-readable permissions             | Yes     | Not A Client Change            | Not An Engine Change          |
| #3753 | fix: decode Base64url session claims as UTF-8                                  | Yes     | Yes                            | Not An Engine Change          |
| #3763 | fix: bind initial engine requests to their initiating login                    | Yes     | Yes                            | Not An Engine Change          |
| #3765 | fix: expose correlated next-hand delay outliers                                | Yes     | Not A Client Change            | PENDING                       |

## Branch reconciliation

The locally named integrate-next-hand-gap branch has head 887caa0e, exactly
the pushed head of merged #3641. Its different branch name does not represent
an orphaned implementation. The unused reconnect-maintenance-clocks branch
head is already an ancestor of main and has no independent unmerged commit.
The remaining continuation branches have corresponding PRs in this ledger.
No reset, force-push, hook bypass or direct main push was used.

## Database And Origin

Production migration ledger contains 20260908032311 (reconnect thaw) and
20260908040659 (arena settings FK index). The index
public.idx_ca_arena_settings_club_id_fk is both valid and ready. The latter
belongs to public.ca_arena_settings; an initial check against the abbreviated
name arena_settings failed without changing anything, then the correct
migration target was verified.

Hetzner origin Caddy was active with /etc/caddy/Caddyfile mode 0644, root:root.
The deployed file SHA-256 is
cbf77db44f27c7d3640362be6e8271218a85ec3ba808973b89930515f2931d79.
Both public root and deep table URL cache headers were verified with the
60-second stale-while-revalidate policy after World Hub #1584. The staging
permission regression caused a 55-second interruption from 12:27:41 to
12:28:36 UTC; the service was restored and the script correction merged in
#3746. This is a known repaired regression, not a clean deployment claim.

World Hub #1563 (9bef2dbed9685c2b05eb23a99182f07bef8e58e5) and #1584
(fa0ae14ba5e701f659770a039b0914c72f5798be) were both verified as ancestors
of deployed World Hub d74c244de34cf4a1545fc501f6a5e9a8265417fc.

## Reported Table, Not A Resolved Incident

The screenshot identifies Madness NLH 2/5. The running database table is
58b2c844-9057-445e-ae0b-7850edcf9078. During this audit the engine reported
three dealable players and progressed from hand 8179436, and the browser
subscribed to that table and displayed hand 8180027 with live actions. That
proves a working path in the test browser, not the owner's iPad path.
The public engine DNS resolves to 5.161.252.33 with no AAAA record, ruling
out a stale advertised IPv6 destination in this lookup.

The server's current-process metrics showed two stale-client events and no
auth refusal or handshake timeout events. The screenshot preceded this
process restart, so those counters cannot exclude its failure. Client beacons
also await authentication and can themselves be blocked by a hanging SDK.

## New Work From This Incident

Club Arena #3778 and World Hub #1591 bound actual authentication network/body
work while preserving SDK session locks and retryable-error session retention.
The real SDK regression reproduces a blocked refresh and proves queued session
reads are released afterward. It does not establish the screenshot's cause.
These PRs have separate merge and publication checks; they are not counted as
live solely because their branches were pushed.

Remaining: actual iPad/browser or installed-shell connection diagnosis;
hand-gap outlier correlation after #3765's normal engine adoption; HTTP
mutation response deadlines; session-revocation identity ownership; durable
maintenance thaw/resume-wave compensation; physical network-switch testing.
The observed healthy browser is not a substitute for these verifications.

## 19:08 UTC delivery reconciliation

This later snapshot supersedes delivery status above, without rewriting the
historical incident evidence. Public and origin `build-info.json` both served
`95b11188d7ce4e9b33b71bb0a218e3544724920c`, built 18:47:49 UTC, run 34264938814. Cache-busted engine health served `6f11ed3f` with maintenance
idle and all 251 tables resumed across eight waves.

Engine deployment 34264479798 / job 102190302161 succeeded through the normal
Hetzner workflow. Its exact target was
`6f11ed3f7337766543ed68e87de58e4f17e4f6c8`. Logs prove the new image started
at 18:55:48, the public hostname served it at 18:56:20, and `engine_leader`
reported the changed version at 18:56:22. The duplicate queued run
34264499597 was cancelled by the existing workflow, not by this agent.

Each cell below was recomputed with `git merge-base --is-ancestor` against
fresh `origin/main`, the actual public artifact SHA and actual engine SHA.
Repository inclusion in the frontend does not execute server code.

| PR    | On main | In public artifact commit | In running engine commit |
| ----- | ------- | ------------------------- | ------------------------ |
| #3810 | Yes     | Yes                       | Yes                      |
| #3816 | Yes     | Yes                       | Yes                      |
| #3817 | Yes     | Yes                       | Yes                      |
| #3820 | Yes     | Yes                       | Yes                      |
| #3824 | Yes     | Yes                       | Yes                      |
| #3827 | Yes     | Yes                       | Yes                      |
| #3833 | Yes     | Yes                       | Yes                      |
| #3835 | Yes     | Yes                       | Yes                      |
| #3839 | Yes     | Yes                       | Yes                      |
| #3843 | Yes     | Yes                       | Yes                      |
| #3845 | Yes     | Yes                       | Yes                      |
| #3850 | Yes     | Yes                       | Pending                  |
| #3854 | Yes     | Yes                       | Pending                  |

#3839's BBJ receipt function migration and #3845's resolved-add-on replay
migration were also separately applied and verified in production; see their
incident audits for exact function digests and natural settlement recovery.
Neither application manually completed a hand or changed a balance.

#3850 (maintenance reconnect wave clock) and #3854 (Spin draw readback)
remain **not running in the engine** at this snapshot, despite being merged
and present in the public repository artifact. The next engine adoption must
be verified before claiming either server behavior is live. The new settlement
blockage telemetry is likewise tracked separately from already served code.

## Production Reconciliation, 20:03-20:06 UTC

The scheduled Hetzner deployment run 34270395338 / job 102210235665 succeeded.
Its public-host probe at 19:56:53 and engine_leader proof at 19:56:55 both report
ad6342dfbe4699357a88be7c9e3aacc4d5ac3ae3, replacing 6f11ed3f. A fresh public
health read independently reports ad6342df. This adopts #3850 reconnect wave
compensation, #3854 Spin draw readback and #3857 settlement blockage health.
All eight resume waves completed, 267 of 267 tables resumed. Settlement fields
are present with status ok and zero blocked settlements at this sample.

Both public Club Arena and ca-static build-info agree on
b0eeaf65c52ae257c2a7bcb17cfa818404e5461a, built 19:45:29 by publisher run 34270591657. These are public artifact reads, not assumptions from merged PRs.

The reported Madness table is dealing hand 8303519 with six seated and five
dealable players. Both previously stuck Spin tournaments now report RUNNING in
the database. The bounded four-minute engine log sample contains no repeat of
the prior Spin draw readback loop.

Remaining latency is material: at 20:06, the 2,000-sample hand-gap window is
p50 2,003ms, p90 8,125ms, max 29,304ms. Settlement post-commit phase p90 is
10,753ms and awaiting post-hand work p90 is 4,976ms. Per-phase percentiles have
different sample populations and must not be summed. Seven durable envelopes
were pending in a contemporaneous database sample, with the oldest only seconds
old. These measurements do not support closing the hand-delay incident.

The new cash buy-in receipt function was applied at catalog version
20260908194834 and verified separately. Its durable client recovery change is
still awaiting branch publication and CI at this checkpoint. Physical iPad
home-screen and offline/reconnect testing remain unverified because the browser
connection tool times out. No production buy-in or financial test was performed.

## Publication verification around 21:00 UTC

Cash recovery PR #3860 merged as 61df0dc0e0a5e06d7319d42cae801a477eaab057.
CI 34274558668 passed; Hetzner publication 34275395230 served the same SHA from
both public and origin build-info (built 20:34:54 UTC). The later public build
is ba8804f916cc3b057d076e0c6a83a42d2ffca66d, built 20:51:56 UTC, run 34277055749. The scheduled engine cutover now reports version 61df0dc0;
its next-hand sample set was still empty during the maintenance window.

Settlement alert PR #3861 merged as e36633be204e546aead6836bca778bfbf4f41297.
Monitoring deploy 34275598564 succeeded. Prometheus evaluated the installed
PokerSettlementBlocked rule at 20:47:52 UTC with health ok, state inactive and
the expected 60-second hold and maintenance exclusion. No synthetic alert sent.

The physical iPad home-screen/offline flow and a paid join remain unverified.
Browser CDP refresh is unavailable. Publication proof is not end-to-end gameplay
proof, and hand-gap outliers remain under investigation.

## 23:15 UTC repository and release reconciliation

Public and origin build-info agree on 5c07d06c09291d931d6b4f0eec2559000d1188de (built 23:09:53 UTC, run 34289206356).
The running engine reports 276faa64, exact repository target 276faa64d658f966202f8ba4425041f9fb0d74d1.
Each inclusion below is recomputed with git merge-base against those commits.
An engine column saying No for a client-only fix is not a missing client release;
repository inclusion does not imply that one runtime executes the other runtime code.
DB migrations and the monitoring rule require the separate proofs recorded in
their incident audits. The new warm-entry-state-proof work is still local at
this snapshot and is not counted as published.

| PR    | On main | In served client commit | In running engine commit |
| ----- | ------- | ----------------------- | ------------------------ |
| #3566 | Yes     | Yes                     | Yes                      |
| #3573 | Yes     | Yes                     | Yes                      |
| #3583 | Yes     | Yes                     | Yes                      |
| #3592 | Yes     | Yes                     | Yes                      |
| #3601 | Yes     | Yes                     | Yes                      |
| #3603 | Yes     | Yes                     | Yes                      |
| #3606 | Yes     | Yes                     | Yes                      |
| #3613 | Yes     | Yes                     | Yes                      |
| #3624 | Yes     | Yes                     | Yes                      |
| #3633 | Yes     | Yes                     | Yes                      |
| #3637 | Yes     | Yes                     | Yes                      |
| #3640 | Yes     | Yes                     | Yes                      |
| #3641 | Yes     | Yes                     | Yes                      |
| #3649 | Yes     | Yes                     | Yes                      |
| #3663 | Yes     | Yes                     | Yes                      |
| #3666 | Yes     | Yes                     | Yes                      |
| #3668 | Yes     | Yes                     | Yes                      |
| #3674 | Yes     | Yes                     | Yes                      |
| #3676 | Yes     | Yes                     | Yes                      |
| #3681 | Yes     | Yes                     | Yes                      |
| #3683 | Yes     | Yes                     | Yes                      |
| #3685 | Yes     | Yes                     | Yes                      |
| #3690 | Yes     | Yes                     | Yes                      |
| #3691 | Yes     | Yes                     | Yes                      |
| #3695 | Yes     | Yes                     | Yes                      |
| #3717 | Yes     | Yes                     | Yes                      |
| #3719 | Yes     | Yes                     | Yes                      |
| #3731 | Yes     | Yes                     | Yes                      |
| #3736 | Yes     | Yes                     | Yes                      |
| #3744 | Yes     | Yes                     | Yes                      |
| #3746 | Yes     | Yes                     | Yes                      |
| #3753 | Yes     | Yes                     | Yes                      |
| #3763 | Yes     | Yes                     | Yes                      |
| #3765 | Yes     | Yes                     | Yes                      |
| #3778 | Yes     | Yes                     | Yes                      |
| #3780 | Yes     | Yes                     | Yes                      |
| #3810 | Yes     | Yes                     | Yes                      |
| #3816 | Yes     | Yes                     | Yes                      |
| #3817 | Yes     | Yes                     | Yes                      |
| #3820 | Yes     | Yes                     | Yes                      |
| #3824 | Yes     | Yes                     | Yes                      |
| #3827 | Yes     | Yes                     | Yes                      |
| #3833 | Yes     | Yes                     | Yes                      |
| #3835 | Yes     | Yes                     | Yes                      |
| #3839 | Yes     | Yes                     | Yes                      |
| #3843 | Yes     | Yes                     | Yes                      |
| #3845 | Yes     | Yes                     | Yes                      |
| #3850 | Yes     | Yes                     | Yes                      |
| #3854 | Yes     | Yes                     | Yes                      |
| #3857 | Yes     | Yes                     | Yes                      |
| #3860 | Yes     | Yes                     | Yes                      |
| #3861 | Yes     | Yes                     | Yes                      |
| #3866 | Yes     | Yes                     | Yes                      |
| #3871 | Yes     | Yes                     | Yes                      |
| #3876 | Yes     | Yes                     | Yes                      |
| #3877 | Yes     | Yes                     | Yes                      |
| #3881 | Yes     | Yes                     | Yes                      |
| #3884 | Yes     | Yes                     | No                       |
| #3888 | Yes     | Yes                     | No                       |

The schema refresh workflow 34288381344 first failed because two database
reads returned HTTP 503 during schema-cache unavailability. Its failed jobs
were rerun through the supported GitHub action, and attempt 2 succeeded.
The browser E2E connection remains unavailable; no paid join was executed.
Hand-delay acceptance remains open: at 23:15:40 the 2,000-sample median was
8,497ms and p90 17,057ms at 663 active tables / 397 tournaments. Earlier low-load
two-second results must not be represented as a sustained production fix.
