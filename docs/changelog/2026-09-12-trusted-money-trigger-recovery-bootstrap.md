# Trusted Money Trigger Recovery Bootstrap

Adds trusted default-branch verification for exact, already-installed migration records, with a separate reporter identity, bounded evidence freshness, full committed-file checks and explicit pull-request head reporting. New or changed money triggers still require their declarations in the same migration.

This bootstrap retains the existing strict CI check and an empty recovery policy. Reporter provisioning, live verification, source-bound protection and independent acceptance must finish before the separate activation change. It installs no database proposal and grants no historical exception.
