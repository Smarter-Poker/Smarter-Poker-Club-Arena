# Explicit Horse Proof Keeps Its Pending Slot

The requested horse observation in run `40784165630` never reached a runner.
GitHub cancelled its zero-step live-table job at 23:48:23 UTC when publication
run `40788236382` claimed the same pending concurrency slot. The check annotation
explicitly named `post-deploy-live-table-production` as the replaced group.

Literal, non-mixed `horse_social: true` requests now own a static horse-observer
group in the existing workflow, matching the independent passive multirun lane.
Ordinary publication and multirun groups are unchanged. Every group keeps
`cancel-in-progress: false`; admission, exact engine identity, all behavior
assertions, isolated accounts and exact-account cleanup remain intact.

The real-expression queue regression failed before this change and passed after
it. This adds no publisher, workflow, timer, engine replacement or synthetic
table behavior. A new natural observation is still required after protected
integration; the cancelled run supplies no feature verdict.

The connected strict observer compilation also exposed TS2774 in the existing auth-lock diagnostic. Check `typeof original === 'function'` explicitly, retaining the unavailable-browser-API runtime guard. The unchanged baseline blob reproduced the compiler failure; unavailable-lock regressions and existing lock transparency tests pass with the correction.
