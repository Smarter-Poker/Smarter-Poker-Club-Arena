# Fixture actors spend an armed turn

The isolated funded acceptance actor treated every changed action context as a new decision. Real engine wire DELTA69 followed an accepted call with a new context while retaining the answered actor and turn clock. This intermediate publication is part of the existing engine/browser contract; the next turn is armed on a new clock.

The maintained fixture actor now records both the submitted context and the hand/turn-clock identity, and rechecks both after pacing and financial preparation. It can act again for the same seat when authoritative state arms a new turn. Missing active turn clocks fail closed. HTTP refusals remain fatal, with no fallback or retry.

The native loopback regression reproduced the prior duplicate action (2 instead of 1), then passed with a later same-seat street turn. Existing action, malformed-frame, duplicate, abort and refusal checks remain enforced by the component fixture native workflow. This changes acceptance tooling only, not the production engine or player client.
