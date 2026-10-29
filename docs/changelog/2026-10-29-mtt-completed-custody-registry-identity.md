# Match completed custody against the registry's actual identity

Completed tournament custody compared break IDs with an original-engine map keyed by table IDs. Nonempty stopped-break, pending no-start and arrival-wake registries therefore refused an otherwise valid physical-release seal and retained the original manager/engine graph.

Validate engine identity for break/request-keyed registries and the explicit table binding for pending no-start continuations. Preserve the base's exact original set, stop fence, physical release, lifecycle and settlement checks. Foreign engines and incorrect table bindings still retain the original custody.

Three regressions using real stopped engines fail before the fix; negative cases preserve unknown custody. This fixes a demonstrated retention path. It does not establish that this path caused the production V8 heap-exhaustion incidents.
