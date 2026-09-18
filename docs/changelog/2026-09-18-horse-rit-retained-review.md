# Horse retained-hand review accepts canonical RIT board history

A fixed production archive cohort contained one completed hand with nine Horse decisions and one run-it-twice board metadata row. The consumer rejected the whole hand as `invalid_records`: accepted history includes system board rows, but its action digest required player seats, UUID actors and wager amounts.

Completed-hand admission now recognizes only the existing five-field RIT producer shape, valid five-card boards and ordered board two/optional three. Ordinary actions retain strict validation. A canonical uncalled return may follow the board metadata. The original array, action ordinals, accepted execution bindings and stored records are preserved. Live decision-prefix validation remains unchanged, and no private card data is added to reports.

Validation: the existing review suite reproduced three failures before the repair, including a persisted read-only-store case. Focused regression protection covers valid two/three-run history, invalid metadata and ordering, preserved posts/returns/ordinals, immutable storage, and strict live-anchor rejection. Exact final compiler and test results are retained with the delivery evidence. Required hosted checks and canonical publication remain separate from local verification; no full-population capture or GTO qualification is claimed.
