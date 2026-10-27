# Horse read inspection refusal reasons

The read-only verification of the deployed horse history fixes exited before journal inspection without identifying its failed guard. The existing workflow now names invalid SSH metadata, missing or busy engine locks, and an image mismatch. All existing locks, exact revision checks, pinned SSH and finite selections remain enforced. No engine restart is involved.

Validation: four focused controls, including executable refusal paths that assert no journal execution after a failed guard. Live receipt verification remains pending the protected workflow delivery.
