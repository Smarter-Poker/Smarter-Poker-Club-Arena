# League results preserve their measurement verdict

The nightly runner already recognized inert duplicate-deal experiments and logged them as harness faults, but its database upsert omitted the existing status and refusal_reason columns. New rows therefore defaulted to measured, including four V53 matchups with zero divergence on October 25 and 26.

The original upsert now records the worker verdict as inert with a reason, or measured with a null reason. It uses the verdict before rounding, retains the original metrics, and clears an earlier reason when the same result key is rerun. No strategy, card, promotion rule, schema, or historical result changes.

Focused regression drives the actual runLeague worker-to-upsert path for zero divergence, nonzero edge with zero variance, and a genuine measurement whose stored figures round to zero. The existing human-field write contract includes the two established columns. Publication and natural nightly write proof remain separate delivery gates.
