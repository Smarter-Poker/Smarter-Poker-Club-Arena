# Mission settlement blocks shell reload

Mission claim, claim-all, reroll and freeze purchase acquire a scoped reload lease synchronously before their first asynchronous operation. A successful reward retains a separate lease through its settlement acknowledgement; dismissal, errors, and unmount retire the owning leases. Independent holders cannot release one another.

The existing shell gate checks leases before scheduling, at the settle timer, and after worker handover. It records reload telemetry and cooldown only after the final eligibility check. A blocked adoption remains pending for the existing poll; no new timer, RPC retry, or UI change is introduced.

The focused law exercises both claim paths, spending success/refusal/error, unmount, independent lease ownership, the settle race, and the asynchronous handover race. This fixes a demonstrated source wiring gap. The original Daily Missions and Wallet browser failures lack a navigation trace, so their exact causes remain unproven.
