# 2026-08-26 — Cashier Send Out / Claim Back deep audit

Requested by Dan: "deep dive into the send out and claim back cashier
functionality... test that all roles can send out and claim back properly,
that sending chips, promo funds or tickets works with no issues."

Every defect below was CONFIRMED against production inside transactions that
were ROLLED BACK (scripts/dev/probe-rpc.sql pattern, auth.uid() impersonated
via request.jwt.claims). Zero chips moved during the audit. Fixes shipped in
migration `20260826_cashier_send_out_and_claim_back_audit_fixes.sql` (applied
to production via Supabase MCP `apply_migration`) and in this PR's client
changes. Probes were then re-run — also rolled back — against the fixed
functions and all pass.

## Confirmed defects and their fixes

| #   | Severity | Defect (probe evidence)                                                                                                                                                                                                     | Fix                                                                                                                                                                                                                                                                 |
| --- | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Critical | First send to a never-funded agent raised 23502: all three send RPCs auto-created the recipient agents row without NOT-NULL commission_rate / player_rakeback_rate. Probe P2: raw not-null violation.                       | `fn_ensure_agent_row` (union-min commission, rakeback 0), used by fn_agent_wallet_send / fn_club_bank_send / fn_promo_wallet_send. Probe R2: send succeeds, auto-coerced to agent wallet.                                                                           |
| 2   | Critical | Approving a chip request whose requester had LEFT the club debited the approver, credited nobody, reported success. Probe P10: approver 500 -> 480, credit NULL.                                                            | fn_respond_chip_request approval now DELEGATES to fn_agent_wallet_send — membership refused before money moves, and per Dan 2026-08-25 the approval spends the AGENT WALLET. Probe R10: refused, float unchanged. R10b: valid approve spends the float 1000 -> 985. |
| 3   | Critical | Cancelling a ticket after the issuer left burned the escrow: ticket cancelled, refund landed nowhere, success reported. Probe P6c: refund_bal NULL, 25 chips gone.                                                          | Cancel refuses when the refund UPDATE matches no row; ticket stays issued. Probe R6: refused, ticket_status=issued.                                                                                                                                                 |
| 4   | High     | status='active'-only membership tests in fn_request_chips / fn_respond_chip_request / fn_wallet_claim_back locked out the ~98% of members whose rows carry the legacy 'approved'. Probe P5: "you are not an active member". | All membership tests use coalesce(status,'active') in ('active','approved'). Probe R5: request accepted.                                                                                                                                                            |
| 5   | High     | Tickets were a dead end: fn_redeem/fn_cancel_tournament_ticket existed and NOTHING in either repo called them. Escrowed value unreachable.                                                                                  | New Tickets tab on CashierTradePage: holders redeem, issuers cancel, badge counts held unredeemed tickets, all roles (players included). Pinned by tests/tickets-are-redeemable.test.ts.                                                                            |
| 6   | High     | Ticket issue accepted only DIRECT assignees while the roster offers the whole recursive downline. Probe P4: depth-2 refused.                                                                                                | fn_issue_tournament_ticket now uses fn_club_cashier_can_transact — the same edge the roster is built from. Probe R4: accepted.                                                                                                                                      |
| 7   | Medium   | Promo send had NO downline rule (probe P7: agent sent promo to a stranger, success) and refused staff (owner/co-owner/admin) promo floats the wallet law says they hold (probe P8).                                         | fn_promo_wallet_send: fn_club_cashier_can_transact added; recipient role set for agent_wallet dest widened to staff+agents. Probes R7 (refused), R8a/R8b (staff floats fundable by staff senders).                                                                  |
| 8   | Medium   | Ticket redemption wrote only wallet_transactions — invisible in the club chip ledger.                                                                                                                                       | fn_redeem writes the matching chip_transactions row.                                                                                                                                                                                                                |
| 9   | Medium   | op_id replay lookups matched (club, type, op_id) with no caller pin: replaying somebody else's op_id (readable off a chip_transactions row you were party to) returned a confident "success, replayed" receipt.             | All replay pre-checks and unique_violation handlers now also match the caller; a foreign op_id re-raises.                                                                                                                                                           |
| 10  | Low      | fn_request_chips / fn_issue_tournament_ticket accepted sub-cent amounts (rounded debit vs unrounded credit drift).                                                                                                          | Hundredths guard added, matching the send RPCs.                                                                                                                                                                                                                     |
| 11  | Low      | Chip Request tab offered agent-tier viewers Approve buttons on requests the server would refuse ("not addressed to you"); badge counted the whole club.                                                                     | Client filters list and badge to (mine or addressed-to-me) for agent tier. Staff unchanged.                                                                                                                                                                         |
| 12  | Low      | .tabBadge CSS was nested inside .tabActive, so the badge was styled ONLY on the tab you were already on.                                                                                                                    | Rule moved to top level.                                                                                                                                                                                                                                            |

## What was verified clean

- fn_agent_wallet_send / fn_agent_wallet_claim_back: 10-minute window enforced
  by the database clock (probe P9b refused a forced-expired claim), partial
  claims tracked in metadata, per-target op_id idempotency backed by
  chip_transactions_agent_wallet_op_id_uidx (race-safe), lock ordering sound.
- fn_club_bank_send / fn_club_bank_claim_back / fn_club_bank_reverse: role
  gates, downline checks, 7-day reversal window, spent-chips guard all correct.
- Recursive downline (super agent -> agent -> player) send: probe P3 passed.
- Legacy unanchored path fn_cashier_send_chips / fn_cashier_claim_back has no
  EXECUTE for authenticated (revoked earlier) — dead, as intended.
- CashierTradePage client: idempotency nonce lifecycle, selection pruning,
  server-anchored countdowns, batch failure surfacing — all as documented in
  the page header; no defects found in those paths.

## Behavioral change to announce

Chip request APPROVAL now spends the approver's AGENT WALLET (was: personal
chip_balance). This is the 2026-08-25 law — "any chips sent or claimed back
transact from the Agent Wallet" — applied to the one send path that still
predated it. An approver with chips but an unfunded float will now see
"Your Agent Wallet Has Not Been Funded Yet" and should fund the float from
the Club Bank first. Approvals also stamp the 10-minute reversible window,
like every other agent-wallet send.
