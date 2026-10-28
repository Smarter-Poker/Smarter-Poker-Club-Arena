# Keep historical exploit neutrality separate from usable-wrap repair

The October 16 closed-gate corpus predates the independent usable-wrap classifier. Its PLO6 cash and tournament streams changed under the intentional new default even before opponent-read engagement; the coverage failure cascaded from those two replay failures.

Follow the corpus's existing historical-isolation pattern: only within this test, call the real draw evaluator and restore the original nutty boolean (nut flush, raw big wrap, or nut low). Every other physical field, original corpus byte, chain/RNG assertion, variant/mode coverage and >90% coverage floor stays intact. There is no runtime opt-out and no hash regeneration.

Both original failing PLO6 replays pass with this single isolation. Current physical and connected pricing tests independently exercise the repaired classifier without that mock. Historical equality does not claim current strategy equivalence to old strategy or certify live profitability.
