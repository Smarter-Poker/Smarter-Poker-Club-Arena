# tests/only-a-critical-reaches-a-person.law.test.ts

A push notification reaches a person only for an unresolved critical carrying a non-zero discrepancy; a warning, a 0.00 and a resolution are recorded as `notify_withheld` and never sent (Dan, 2026-09-06). `fn_ca_escrow_on_close` stamps the close note and raises nothing, because at COMPLETED the prizes are not yet paid and it was reporting the prize pool as missing chips.
