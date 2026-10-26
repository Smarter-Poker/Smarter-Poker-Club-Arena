# PLO6 River Calls Retain Their Decision Receipt

The V58/V59 river rule can cap a PLO6 raise or jam at a call. The receipt boundary admitted the rule's folds but rejected its calls, causing a valid worker answer to be refused as an invalid policy graph.

The boundary now admits this final-node de-escalation only for PLO6. With the original request present, it requires the single-board river, six hole cards, a legal call, sufficient chips behind and the exact additional-chip call price. Context-free retained receipts still require a positive priced call. Other games, streets, boards and unpriced calls remain refused. This changes receipt admission, not the strategy's equity thresholds or qualification assertions.

A synthetic production-worker run reproduced the rejection and retained its physical request and graph. The regression replays that graph and tests incorrect contexts and prices. This establishes a reproducible refusal class; it does not establish that every historical production refusal had this cause, or certify live deployment.
