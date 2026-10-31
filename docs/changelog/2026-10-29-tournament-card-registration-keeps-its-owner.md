# Tournament registration cards keep their event and viewer

The card did not rerun its registration read when authentication hydrated. A delayed old event response could mark the next event registered, and an earlier fallback lookup could overwrite a newer confirmed parent answer. Three rendered cases reproduce those defects before this correction.

Give the card state an event/viewer identity and fence each registration lookup through its completion. A confirmed parent answer or effect cleanup retires older lookups. Query errors and throws preserve the existing unavailable state; a pending lookup does not advertise an unconfirmed paid entry. Countdown and purchase authority remain unchanged. This is not attributed as a server-freeze cause.

Three rendered regressions fail before and pass after. All 94 connected card, satellite, query-failure and source-contract cases pass; root TypeScript passes. Normal push, hosted checks, protected merge, client publication and live proof remain pending.
