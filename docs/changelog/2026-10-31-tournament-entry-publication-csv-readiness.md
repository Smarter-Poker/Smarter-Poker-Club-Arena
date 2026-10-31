# CSV regression waits for ledger readiness

Tournament-entry publication run 41240829660 stopped on the cashier CSV formula-protection regression. It waited for the Export CSV label, which appears while the button is disabled and the ledger is still loading, then clicked before any rows existed.

The test now holds the ledger response deliberately, verifies export is disabled with no download while pending, resolves the response, and waits for enabled export and the actual download. Every BOM, CRLF, formula-prefix, raw-figure and timestamp assertion is retained. No cashier or financial source behavior changes.
