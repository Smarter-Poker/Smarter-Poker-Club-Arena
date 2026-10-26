# Control Upgrades Activate The Requested Generation

The engine-control installer validated an older canonical generation and set its format flag to current. Its final activation gate then mistook that format flag for a match to the requested revision. A new immutable generation could launch successfully while the global control link still named the old one; the independent production proof correctly refused it.

Forward upgrades now atomically activate the requested generation even when the predecessor already uses the canonical directory format. Same-revision installation leaves the link unchanged. Earlier protected-main ancestry, exact-byte validation, divergence refusal and newer-generation downgrade refusal remain intact. Existing release requests retain their immutable generation pins.

A connected disposable-filesystem regression executes the actual installer validation, ancestry admission and activation blocks against real Git commits and generation manifests. It reproduces the stale-link failure before the fix, then proves forward activation, same-revision idempotence and downgrade refusal. The existing release-seal law runs it. Independent production proof still checks the global control link and its protected source bytes.
