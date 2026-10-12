# Record the versioned adaptive consumer in the data ledger

The adaptive retention consumer moved to the statistics claim/finish RPCs, but the two private model-table entries in HorseDataLedger still named the earlier RPCs. Required Server Engine shard 2/4 failed its existing source-reader contract on job114939017103 for candidate744b7936d. Both entries now identify the actual versioned consumer calls; the sweep description includes retained sufficient statistics.

The existing HorseDataLedger contract reproduced the exact failure before the correction and passed all ten checks afterward. Assertions and runtime behavior are unchanged. Server TypeScript compilation passed. This source correction does not establish engine publication, adaptive activation, source coverage or physical reclamation.
