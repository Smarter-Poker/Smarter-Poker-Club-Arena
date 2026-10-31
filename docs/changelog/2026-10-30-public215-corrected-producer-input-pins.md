# Public215 corrected producer input pins

The public-only draft assembler now requires protected World Hub producer `291a8e5658b6a706066b39fba6c75a714f578695`, which corrects the M2 worker import. It pins the replacement source partition `8440d9613fe3013b82f8a1d76150499fbbcb4bf87ee9af0bf4bc8a63430d5427` and selection protocol `973a54525509685a3533e984f9a147087fd16e9620e6a4c2ba77d315728f3797` for the fresh committed holdout.

Only those three constants change in `server/scripts/assemble-public215-input-draft.py`. Assembly algorithms, validators, census, R6 baseline pin and namespace handling remain byte-identical. The feature assembler and encoder graph are unchanged.

Validation: Python AST parsing and exact three-pin-only preimage comparison pass. The previous pins refuse the new configuration at the producer gate; the corrected assembler completes full public-draft qualification for 107 contexts, 6,099 M1 targets and 2,147 M2 candidates. Recipe, feature, physics, parity and dependency protocol bytes are unchanged. Approval, capture, training and certification remain separate gates.
