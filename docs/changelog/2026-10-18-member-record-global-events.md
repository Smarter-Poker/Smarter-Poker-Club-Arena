# Every club member record follows every mutable source

The shared record implementation and funded-hand projection apply to all clubs and members. The October 18 follow-up closes source-event gaps found while verifying every displayed field. Club renames, player-number changes (including the upline number), membership joined-date changes, table-status changes and agent wallet/status changes now invalidate the affected records. Fee-row removals and transaction corrections/removals also invalidate the totals they change. No money or hand source rows are rewritten, and no repair schedule is added.

| Displayed fields                                          | Authoritative source and update delivery                                                                 |
| --------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| Name, alias, username, avatar, player number, last active | profiles column trigger → private member record signal → full scoped read                                |
| Home club                                                 | clubs.name trigger → every club membership signal                                                        |
| Role, joined, nickname, remark, capabilities              | club_members trigger plus viewer-membership realtime; notes retain unsaved local drafts                  |
| Upline name and ID                                        | member relationship trigger plus parent identity trigger → direct children                               |
| Online / seated / Watch At Table                          | profile presence door; seat trigger; table status/club trigger; locator authorization rechecked on click |
| Player, agent and promo wallets                           | existing roster-wallet subscriptions plus agent source trigger → authoritative wallet reads              |
| Direct and total downlines                                | membership/profile status triggers recursively invalidate ancestors                                      |
| Cash / MTT hands and net, all win/loss windows            | transaction-owned funded-club daily capture; facts signal → detail and win/loss refresh                  |
| Fees                                                      | cash and tournament fee ledgers insert/update/delete → record signal                                     |
| Claimed back, sent out                                    | chip transactions insert/update/delete → both old and new parties                                        |
| Expanded downline rows, role controls                     | record revision and current viewer role/capabilities                                                     |
| Change history                                            | existing private player-history channel, scoped authorization and reconnect                              |
| Overall, seven days, custom dates                         | server range parameters; range changes explicit; reconnect/focus/online reconcile scoped record          |
| Linked statistics                                         | same funded projection and authorized statistics RPC                                                     |

Native PostgreSQL tests reproduce missing events before this migration and verify both independent clubs afterward, all profile columns, membership fields, upline ID, table status, wallet status/removal, transaction correction/removal, fee removal, no-op context suppression and private payload/ACL. The existing required Data Console native check invokes this fixture, retaining original attribution/concurrency tests.

Production read-only coverage at 19:54 UTC: eight clubs, 2,010 memberships, initialized projection with 60,316 rows across six clubs with recorded activity. Global conservation: 47,376,888 hands and all eleven summed hand metrics match the original projection exactly. Per-user comparison covers 1,008 users with recorded activity, zero mismatches. Clubs/members without hands correctly have empty aggregates. This is global database coverage, not a claim that every record was manually opened or every production field mutated.
