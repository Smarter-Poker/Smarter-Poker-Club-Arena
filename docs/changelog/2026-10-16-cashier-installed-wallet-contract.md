# Certify the installed selected-wallet Cashier functions

The concurrent selected-wallet migration `20261016024912` was installed while the Cashier release completed. Its registered-writer envelope is protected in #7068; the installed migration source MD5 `5350cad2640ab7bf33518794ad7a6c6b` matches that file exactly.

The live verifier still named superseded batch-transfer, intent-trigger and private Promo-core definitions. Pin the reviewed installed definitions, preserving owner, SECURITY DEFINER, search-path, ACL, RLS, transaction and journal assertions. The private cores remain inaccessible to browser and service callers. This changes verification only and applies no SQL migration.

Four regressions fail before and pass after, deriving each body fingerprint from the qualified migration and checking its declared full-definition post-image. Existing retained-core tests now derive the two updated cores from their current source instead of historical inventory. The full maintained SQL contract passes read-only against production. No financial command was submitted and no real player funds moved.
