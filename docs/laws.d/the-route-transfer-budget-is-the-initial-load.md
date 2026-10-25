# tests/the-route-transfer-budget-is-the-initial-load.law.test.ts

The route-performance 3MB transfer budget counts the navigation document plus every resource requested before the initial-load boundary (the earlier of the load event and the page's first idle callback), so speculative idle prefetch landing before the snapshot cannot flip the verdict for the same build; with no load timestamp every byte counts (fail closed), and the total is still logged.
