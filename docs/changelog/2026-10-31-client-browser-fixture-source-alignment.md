# Client Browser Fixture Inputs Follow Their Assertions

Post-deploy client job124456598051 aligned its page tests from checkout22445691a to the newer live release8ae85c1c, but left local component styles and artwork at the old revision. The general browser sweep could not collect because the selected mobile lobby spec read the newly added LobbyFilterLabel.css. Dedicated journeys passed; the general sweep produced no verdict.

The client alignment step now selects src and public together with tests/e2e when production is an ancestor or descendant of the checkout. Its existing lineage, retained-runtime, authentication and support authority rules remain intact. The engine lane, browser assertions, cleanup and time budgets are unchanged.

The regression executes the actual workflow alignment in an isolated Git repository. It checks newer source additions, changed styles and artwork, older-page alignment, and preservation of the trusted authentication harness. The regression failed against the previous workflow; the focused provenance and verification suites pass after correction. Hosted publication and live certificate results are recorded in the existing credit checkpoint.
