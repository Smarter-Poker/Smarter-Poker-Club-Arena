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
