# Club Data deadline qualification observes each admitted request

The required client shard for the weekly receipt-index delivery failed in
`tests/components/club-data-page-renders.test.tsx:1784`: after one 55-second
fake-clock advance, the last captured AbortSignal was still active. The same
source passed both a focused local run and the whole 52-test component file.
The fixture overwrote its signal on every retry and advanced time inside a
single React `act`, allowing request-starting effects and the assertion to
observe different requests.

The fixture now settles startup effects, retains every request's signal, and
advances each existing 12-second attempt and 350/700/1400-ms retry interval
separately. It requires exactly four requests, verifies each signal is active
before its deadline and aborted afterward, and retains the final error-text
assertion. Production code, deadlines, retry count and permissions are unchanged.

The focused corrected test passed. The complete component file and TypeScript
compilation are checked before submission; hosted required checks must pass on
the final candidate. This is qualification repair for an actual delivery blocker,
not additional product work.
