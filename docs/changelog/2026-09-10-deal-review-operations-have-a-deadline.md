# Deal Review Operations Have A Complete Request Deadline

The shared Supabase transport bounds auth HTTP calls but leaves ordinary RPC fetch and response-body waits unbounded. The auth helper also awaits its initial session lookup without a total caller deadline. Either could keep the review screen busy indefinitely.

The existing roster single-attempt deadline is extracted into a shared request helper, retaining its existing twelve-second default. Roster reads retain their retry policy and domain errors. Deal operations use exactly one attempt around authentication, RPC, and response parsing. Metadata and proposal reads share one operation deadline.

The request signal reaches the PostgREST builder. A post-auth signal check prevents a timed-out or cancelled action from starting its mutation later. Component cleanup aborts the account/event context. Timeout remains an unknown outcome followed by authoritative readback, with no automatic mutation retry. Server-owned review deadlines remain authoritative.

## Verification

- 143 tests passed across five files, including all 29 existing roster resilience tests.
- Five new rendered integration scenarios use the actual PostgREST client with synthetic fetch responses, covering never-resolving auth, fetch, and body; read retry; and unmount cancellation.
- Late auth completion after timeout or unmount never starts a mutation.
- Lost vote responses clear the busy state and resolve through consent readback with one mutation request.
- Full client source strict TypeScript passed.
- Logs: /tmp/codex-chip-ui-deadline-tests.log and /tmp/codex-chip-ui-deadline-tsc.log.

No production operations or publication occurred in this lane. Native lifecycle and integrated deployment/browser gates remain with the coordinated Phase 3 release.
