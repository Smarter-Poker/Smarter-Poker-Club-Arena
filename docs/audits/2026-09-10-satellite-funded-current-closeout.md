# Current funded satellite component closeout

The current installed helper can count one pre-start qualifier twice, subtract the version 2 entry fee twice, and seed phantom bounty from an empty direct-ledger join. This candidate fixes those three components while preserving the current global settlement-lock helper and the reader's newer ticket-redemption inflow.

This independently completes the helper correction first recorded in d5beef474dc2558307d1bb9af31a9fda0421a074 and reconciled in df72341a360bbf9126a0603c1eb12dadfeb0d00b. The old migration must not be applied: it expects escrow reader 99606ee5 and would replace the newer ticket-inflow reader. The new CLI-created migration is `20260910160106_satellite_seats_count_once_and_keep_the_funded_prize.sql`.

| Function                    | Fresh installed body MD5         | Proposed body MD5                |
| --------------------------- | -------------------------------- | -------------------------------- |
| fn_award_satellite_seat     | cc53a9560c7b211c9c052a186dabc96c | 2c21c56c6a9d4a2f8ee79082bd4fef57 |
| fn_ca_escrow_on_rake_record | 233661d2164a417c2a76c8e0cbfbe9cc | 3e628d6a57a93eeb61d494ee33f989a3 |
| fn_ca_tournament_escrow     | 52c3b25be3904e86f1a8558ce542ec61 | 56663389f8348d2ab35a54460c0b7632 |

The five direct authority envelopes were captured read-only at 15:59:31 UTC. They retain owner postgres, service-only execution, security mode, volatility, strictness, exact arguments/defaults/return shape and search path. Preflight fails closed on missing or changed authority; postflight requires the exact proposed bodies. The unchanged global helper remains 343015440ea5c84ee4ca7ae583c73d30. The roster trigger must remain enabled with its actual INSERT/DELETE/UPDATE OF status,tournament_id row shape. Transaction-local lock and statement ceilings are 1s and 10s.

The reader change is exactly one `LEFT JOIN` becoming `JOIN`; the ticket-redemption CTE, its addition to inflow and cross join remain byte-for-byte. No wallet, escrow, seat, journal or historical receipt row is rewritten by the migration. Future reader calculations for existing tournaments can change when correcting the phantom bounty.

The final native evidence records 24 named checks and five observed PostgreSQL lock waits. The unchanged original module covers all three admitted target states, real paid source registration, cash/bounty component conservation, duplicate replay, insufficient source, closure, last-place contention and a competing paid target entry. A separate hand-barrier case preserves the current global lock composition and clean migration replay.

Additional checks reproduce the current baseline's count 2 and target prize 150 for a bounty 5 award, versus corrected count 1 and 175/5/20 prize/bounty/fee. Actual SET ROLE service_role successfully awards and replays; authenticated and anon cannot execute the award or escrow reader. Two late AFTER-payout faults first observe the target seat, transfer, receipt, all expected source/target escrows and wallet total 1600, then prove complete rollback by equality across 11 financial relations. Ten source-envelope/trigger drift cases refuse before changing financial rows. A synthetic ticket-redemption journal input demonstrates unchanged reader inflow 200 before and after correction with ledger triggers enabled; this is specifically a reader test, not a complete ticket redemption flow.

This is an isolated selected financial subgraph with actual captured SQL writers. Source purchases use the registration/wallet/entitlement/ledger path. Auth identity, external lifecycle, some relation shapes and the local postgres relation grants are explicit fixture boundaries. It is not full production schema, RLS, HTTP, physical-chair or complete outer satellite-delivery proof. No production data was used or modified.

The candidate introduces no RPC and no client or manager caller. It is independent of the held exact-K qualification proposal and its absent Stage-B final-seat core. Applying this helper alone does not activate that held proposal. Exact-K, already-open legacy tab adoption and the full terminal financial certificate remain separately held.

Production application was not performed. Root is retaining the verified candidate for the explicit PokerIQ-Production deployment approval.
