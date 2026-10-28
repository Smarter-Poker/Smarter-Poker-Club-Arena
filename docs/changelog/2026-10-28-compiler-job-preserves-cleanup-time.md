# Compiler job preserves cleanup time

PR8443 job122933361176 ran from16:11:16 to16:26:20UTC. Every functional step passed, including the real chip-journal transactions, TypeScript, invariants, SLO evaluation and fleet-throughput rules. The last guard ended16:26:17; the 15-minute outer deadline cancelled node_modules cache cleanup one second later. The required aggregate correctly refused the cancelled job. Comparable PR8440 job122904827866 completed successfully in14:26.

Raise only typecheck_compile's outer budget to20minutes, adding five minutes for the observed checkout/execution variance and cache/cleanup. Every step, command, financial assertion, internal timeout and required result remains enforced. Refresh the six active workflow identity leaves and append explicit historical evidence without changing any qualification state. The cancelled run remains cancelled; the corrected exact head still requires normal hosted qualification.
