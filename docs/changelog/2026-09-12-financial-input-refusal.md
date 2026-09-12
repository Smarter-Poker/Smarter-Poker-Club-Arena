# Supplied financial inputs refuse instead of silently defaulting

The top-up HTTP handler now returns400 when a supplied operation ID is null, nonstring, empty, outside8–64 characters, or contains characters other than ASCII letters, digits and hyphens. Previously malformed IDs became undefined, allowing repeated requests to reach the engine without the caller's intended stable identity. Omitted IDs preserve existing compatibility; valid IDs are forwarded unchanged.

Insurance acceptance now returns400 for supplied nonnumeric or nonfinite coverage. Previously a JSON string such as"25" silently selected100 percent coverage. Omitted coverage still defaults to100; finite numeric coverage remains subject to the existing engine eligibility/domain rules. Decline and cashout behavior is unchanged. Preview retains numeric query-string parsing and refuses nonfinite parsed values.

The focused suite invokes the complete HTTP handlers, body reader and response writer while mocking authentication and the engine boundary. The same34 checks pass13/fail21 on the original source and pass34/fail0 on the candidate, with zero skipped. Server TypeScript compilation passed. These checks establish request refusal and compatible dispatch, not paid engine/SQL settlement or production correctness.

This is the narrow FWP03/G4-C64 and FWP04/G4-C58 candidate. Stable-key local stack reflection, insurance pricing/rounding and accepted-hand financial semantics remain separate findings. Independent candidate acceptance, protected integration, reuse of the native funded top-up/current-offer proof, and exact served verification are pending. No SQL, financial operation or game feature policy was changed.
