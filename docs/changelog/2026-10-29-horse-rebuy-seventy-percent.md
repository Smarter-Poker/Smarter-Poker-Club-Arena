# Horses choose rebuys on 70 percent of eligible busts

The October 29 owner instruction replaces the previous 75 percent share with 70 percent. The original deterministic draw remains bound to tournament, player and accepted busting hand. Repeated reads and restarts retain the same decision. The ordinary purchase transaction still owns funding, caps, pricing and deadline enforcement; this change does not reopen a closed offer.

The choice-law regression fails against the prior constant and checks the exact share, repeatability, invalid bust identities and 10,000 draws independently across players, events and hands. Connected input-device and think-time tests cover the caller.

Investigation of event 1bb5fe6f-bebb-4a8e-b05a-64d8e425b5fb found six offered Horse busts: three purchases, two deterministic declines and one willing Horse whose offer expired without a purchase receipt. Two further busts happened after the configured 64-minute entry window. Three persisted funding receipts agree with the UI. The exact cause of the missing willing purchase remains unproven; changing the probability does not establish its repair.

## Missed-purchase hardening

A regression using the actual input method reproduces ready answers expiring behind another Horse's slow purchase response. Four bounded independent inputs now use the original purchase transaction. The direct input returns to arm future due moments while purchase promises remain retained; it never sends a second purchase for a generation whose response is still pending. The sweep can await that same pending operation. Database eligibility, funding, settlement/seat locks, exact-generation receipts and cutoff remain authoritative. A locally expired offer is never submitted as a new input.

Null, false and thrown purchase responses remain unproven rather than becoming final answers. This preserves the existing bounded continuation and authoritative reread, including a possibly committed lost response. Freeze/stop checks remain in both paths. Regression coverage includes ready and later-due answers beside a held response, bounded concurrency, unknown-response recovery, pre-cutoff success and expiry refusal.

Single-line `horse-rebuy-decision/v1` records on the original input carry tournament/player/bust identity, the deployed choice share, choice, phase, due time, deadline, attempt/response times, SQLSTATE and a fixed failure category. No raw error payload is copied. Deduplicate choices by tournament/player/hand; purchase attempts and successful receipt responses are separate observations. The existing explicitly invoked scoped read-only log reader retains these allowlisted fields and rejects malformed or unselected records. Neither diagnostics nor the reader purchases or repairs anything.

The specific historical miss remains unattributed because the retained incident log contained zero bytes and its archive was unavailable. The isolated reproduction proves the serial response blocker, not that it caused that historical case. Source delivery and live verification must be reported separately.
