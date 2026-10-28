# Accounting retains time to finish Spin qualification

Horse tournament predicate delivery run40528107352 failed its required aggregate because accounting shard1 exceeded its40-minute job limit. Provider annotations explicitly name the job deadline; all preceding executed steps passed. Spin started35m52s into the job and was canceled4m23s later. Seven retained intermediate image results passed, but the canceled full qualification remains incomplete.

The last successful comparable CI run40520906517 finished the same Spin step in5m23s. Combining the observed current prefix with that successful duration needs41m15s before artifact cleanup. The existing accounting job budget is50minutes, providing about20percent variance headroom. No case selection, financial assertion, per-statement limit, fixture deadline, cleanup requirement or required aggregate verdict changes. Hosted execution must still complete successfully; the canceled attempt is not reclassified as passing.
