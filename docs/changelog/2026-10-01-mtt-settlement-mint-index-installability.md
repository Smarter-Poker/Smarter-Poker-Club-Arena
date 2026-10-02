# Install the existing mint-ledger access path

MTT fee settlement was blocked behind accepted-hand profile locks held by `fn_ca_horse_claim_due(500)`. Retained production cron failures show successive 120-second timeouts inside the diamond registrar's full-ledger supply sum. The covering indexes in merged PR #5602 were absent from both the live catalog and migration history; its migration lacked the transaction wrapper required by the maintained installer.

Preserve both existing concurrent index definitions and all table settings. Wrap only the settings in one transaction with five-second statement and one-second lock limits, so the existing installer can build and validate the indexes separately before applying the settings. No rewards, balances, ledger entries, schedules, batch limits, or financial rules change.

The maintained installer regression fails on the old file and passes with the wrapper. The existing concurrent-build guards, validity readback, migration history and post-install query-plan evidence remain required. This access-path improvement reduces ledger reads; it does not make an aggregate over growing history constant-time.
