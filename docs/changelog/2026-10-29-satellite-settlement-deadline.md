# Satellite settlement receives the database outcome

The satellite writer and serialized outcome resolver used the ordinary 15-second client while their current database statement budgets are 30 and 45 seconds. The multi-qualifier eligibility, writer and resolver have the same mismatch with their 30-second database budgets. All five now use the existing 50-second maintenance client, matching ordinary tournament terminal settlement. Replay identity, receipt validation, attempts and unknown-outcome fencing remain unchanged.

Five actual SDK/bounded-transport regressions fail before the correction: a 20-second write is abandoned and a 40-second resolver answer becomes unknown. Multi-qualifier write, resolver and eligibility responses also reproduce the lost answer. The retained tests also prove an uncooperative transport remains bounded and unknown. No production payout or fault injection is used. This is a reproduced terminal-settlement defect, not attribution for the active multi-player stalls.

Validation: 301 connected transport, receipt, settlement, recovery and source-contract cases pass; root and server TypeScript pass. Five new failures reproduced before their respective fixes; the bounded unknown-outcome positive control also passes. Engine activation and live proof remain pending.
