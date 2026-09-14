# Exercise engine image custody in ordinary PR CI

The previous PR proof built and imported the image, but never ran the release producer and artifact admission path. The existing resource workflow now invokes the producer with an explicit qualification profile, then verifies the uploaded image from a separate job. It replaces the earlier native invocation, keeping one engine image build and the existing 40-minute containment job limit.

Qualification uses the actual pull-request merge control SHA, exact event head/base commits, current run and attempt, and a separate descriptor schema, identity purpose and artifact name. The producer builds the exact PR head after verifying its relation to the workflow merge commit. It retains the same typechecked reference, archive normalization, private native importer, refusal matrix, resource limits and final cleanup gate. No GitHub event or source identities are substituted.

The receiving job downloads by the producer's immutable artifact ID, authenticates GitHub run/attempt/artifact/completed producer-job metadata, and hashes the received files before and after API reads. It also exercises real-byte refusals and a deliberately wrong artifact digest against the real API response. Current-context and production-profile refusals use the genuine PR environment. Its final receipt explicitly denies production admission, host qualification and deployment authorization.

The production repository-dispatch verifier and main/stale-source checks remain unchanged. Qualification artifacts cannot satisfy its identity, workflow and schema requirements. Native PR execution of this complete producer/upload/download/admission path is still required before claiming it qualified; production host acquisition and release remain separate obligations.
