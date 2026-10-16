# Mobile Table Buy-In Audit

The follow-up audit of #7052 and #7073 found three connected buy-in defects. The sheet retained a prior refusal when reopened; its backdrop ignored parent-controlled processing; and the table released its submit latch before definitive journal cleanup finished, allowing a corrected click to recover the rejected payload.

Clear transient refusal text when the sheet opens, apply the existing processing guard to every dismissal door, and await bounded journal cleanup before releasing the table callback. Unknown financial outcomes still retain their original request and idempotency key. A cleanup failure does not reinterpret a confirmed purchase as a failed purchase.

Regression evidence: four new cases failed on the preimage (both artwork variants for dismissal, reopened refusal, delayed journal cleanup); all 34 buy-in cases passed after the repair. Connected payout, Run It Twice, reconnect, seat controls and card-layout tests passed (300 cases). Rendered layout and protected publication/live proof are recorded in the task checkpoint. No engine replacement or database migration is required.
