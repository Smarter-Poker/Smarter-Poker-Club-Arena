# Lightning player evidence retains native refusal codes

The corrected live phone witness rendered its hand and fit the viewport, then received a refused Fast Fold. It correctly remained unqualified and closed its local session, but discarded the native refusal code. The report could not distinguish a stale hand, unavailable action or other refusal.

Retain the HTTP status, bounded uppercase native code, outgoing render hand IDs and request/reply timestamps on the existing action record. Raw response messages, frames, cards and credentials stay outside the artifact. An unknown code stays null, and every refused action still stops the witness with an unknown verdict. No retry, gameplay, access or financial behavior changes.

Regression coverage fails before this change because the refusal evidence is absent, then checks the native code, safe identities and rejection of a private payload. Actual browser verification remains required.
