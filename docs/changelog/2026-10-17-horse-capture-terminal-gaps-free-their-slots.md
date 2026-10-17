# Horse Capture: Lost Windows No Longer Block New Capture

- Phase 14 capture holds at most 256 unfinished requests. Requests whose source window had already expired ("gaps")
  can never run again, but they kept their slot forever. On 2026-10-17, 254 of them plus 2 queued requests filled
  every slot, so all new capture was refused.
- Only work that can still run now holds a slot. Expired gaps are retired after 32 days, like finished work.
- Proof: local Postgres 17 with the same 254 gaps + 2 queued: a new request is admitted, health reports the open work,
  prune retires old gaps in batches of 100 and keeps recent ones.
