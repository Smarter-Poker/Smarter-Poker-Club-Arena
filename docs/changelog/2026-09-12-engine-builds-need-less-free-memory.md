# Engine builds need less free memory

The bounded builder correctly refused a release when the production host had
less than its required 1.25 GiB available. Its successor uses a 896 MiB builder
while retaining the original 768 MiB compiler heap and the same 256 MiB host reserve,
zero swap and single CPU limit. The required free memory is therefore 1.125 GiB.
The refusal now records both the available and required amounts.

The new builder name keeps the previous builder's settings separate. Exact
resource readback, complete runtime comparison against the fully typechecked
build, real out-of-memory containment, cancellation and cleanup checks still
apply. No release may fall back to an unbounded build or bypass the host reserve.
