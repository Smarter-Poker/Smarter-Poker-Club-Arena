# A Deadlocked Bust Payment Is Never Retried

Migration `20261022091134_a_deadlocked_bust_payment_yields_to_its_partner_instead_of_r.sql`, applied to production 2026-10-22 09:11 UTC.

The retry added earlier the same night in `20261022030638` did not work. Postgres log, Midnight Bounty (77c43fe1), 06:11:38 to 06:11:42 UTC: one payment detected the same deadlock four times, about one second apart. Its cycle partner was waiting on the tournaments row (relation 27579) that the bust's own transaction holds at top level. A subtransaction retry cannot release that lock, so every retry re-closed the cycle and held the engine's hand commit four seconds longer.

The wrapper now retries only 55P03 (lock timeout) and 40001 (serialization failure). On a deadlock this payment step is abandoned at once and the transaction commits. Its partner then gets the lock. When the partner is another bust's payer it reads the committed bust and pays every unpaid place; otherwise the next bust or the terminal settlement does.

Evidence: 827 places paid at the bust since 02:00 UTC, median 2.4 s, 99th percentile 17 s. The Midnight Bounty completed with all 29 places settled.

Law: `tests/a-deadlocked-bust-payment-is-never-retried.law.test.ts`.
