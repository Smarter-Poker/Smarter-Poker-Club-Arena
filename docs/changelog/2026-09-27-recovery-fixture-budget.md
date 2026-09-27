# Compose the recovery fixture's actual time budgets

During the exact integrated conservation-index suite, the real shell recovery fixture completed after 5.047 seconds but Vitest refused its default five-second budget. The fixture itself already supplies a 20-second absolute recovery deadline. A later unchanged isolated run passed all five cases in 3.70 seconds; this diagnosis does not erase the failed full run.

Derive a 21-second subprocess limit and 26-second outer test budget from the unchanged 20-second fixture deadline. A hung subprocess now terminates and its error or nonzero exit explicitly fails the test. Exact local/public health, sealed desired identity and rollback assertions are retained. Production source, deadlines, release safety reserves and runtime behavior are unchanged. The final integrated full suite must pass with this correction before submission.
