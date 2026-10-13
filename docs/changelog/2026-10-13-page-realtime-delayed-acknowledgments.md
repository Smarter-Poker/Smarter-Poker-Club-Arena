# Page realtime acknowledgments and recovery

Supabase returned valid page-channel acknowledgments 20.4–33.6 seconds after transmission during the October 13 Realtime incident. The SDK 10-second join deadline discarded those replies. SDK 2.90.1 also scheduled another rejoin while an earlier rejoin was pending, replacing its reference before a delayed reply could arrive.

The existing page subscription helper now retains a bounded 60-second join budget. On failure it retires the SDK binding through public unsubscribe and forwards the original failure to the existing owning recovery factory/backoff. Shared client, heartbeat, engine transport and financial HTTP deadlines retain their established behavior. No new recovery loop or database migration is introduced.

Player Management requires every enabled member, wallet and audit feed to acknowledge before reporting connected. Account, club, role and retry transitions preserve pending or degraded coverage. Historical-report qualification and the installed financial custody safeguards remain unchanged.

Six helper/SDK regressions fail against the prior helper, and three pending-feed regressions fail against the prior Members source. The corrected 64 focused cases, normal push source contracts and related tests, TypeScript and production build pass. The maintained production certificate now requires matching join references, accepted database bindings, no connection retirement/rejoin during observation, and Simple/Advanced coverage at mobile and desktop sizes for all three pages. Provider mitigation, publication and fresh live certification remain separate evidence; source validation alone does not close the task.
