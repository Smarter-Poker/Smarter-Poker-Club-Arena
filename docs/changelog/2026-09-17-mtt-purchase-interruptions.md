# Preserve tournament purchase outcomes across interruptions

Add-on and rebuy callers now require a confirmed receipt before announcing success. Lost replies preserve the original saved request and offer confirmation retry. Add-on expiry and every rebuy dismissal/hold-release path retain an outstanding purchase; late callbacks cannot alter a different table, user or prompt. Missing table engines return an explicit unavailable decline response instead of false success.

Only a fresh build or validation failure before publishing any recoverable intent is classified as not submitted. Shared-storage readback failures, saved requests and RPC errors remain unconfirmed. Payment rules, SQL, original request identities and Diamond shortcuts are unchanged. An explicit add-on Close dismisses presentation without deleting the saved request.

Existing focused verification passes 105 client cases, 15 server cases and both compilers. New cases reproduce the former false unpaid claim, missing-engine success, cross-tab intent readback race, five-second deferred-exit race and context/StrictMode behavior. Normal required CI remains necessary before publication. No production purchase or financial fault injection was performed.

This is a bounded interruption repair. Post-submit refusals still lack a typed authoritative no-charge receipt, so destructive rebuy decline remains blocked while the outcome is unconfirmed. The existing decline protocol's already-funded no-op is not a payment-recovery receipt. Full hosted purchase and played-tournament certification remains separate.
