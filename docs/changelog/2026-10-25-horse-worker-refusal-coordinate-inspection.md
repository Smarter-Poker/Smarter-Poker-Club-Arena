# Retain sanitized horse worker refusal coordinates

The existing manual read-only tournament diagnostic omitted isolated horse decision receipt refusals. It now identifies the original `reference_shape` reporter message and returns only its exact timestamp, named code and table UUID. The existing bounded two-hour stream also retains these events, so ordinary gameplay noise in the newest tail does not hide them. At most 128 sanitized witnesses are retained, with explicit truncation and coverage limits.

The original error does not contain a hand or request identifier. The report states that a hand coordinate is unavailable; it never borrows one from adjacent gameplay or error properties. Original private decision inputs still require a separate exact retained journal read. No cards, raw errors, stack text, secrets or arbitrary log content leave the diagnostic.

The existing manual workflow, canonical pinned SSH credentials, expected engine identity checks, fixed commands, time/byte/record bounds and read-only behavior remain intact. Focused parser tests cover real Node Error output, malformed and unrelated messages, private suffix rejection, bounded witness retention and streaming beyond a noisy tail.

The streaming test's synthetic log producer now reads its 540 KB fixture from a temporary file instead of a single command-line argument. Linux limits one argument to 128 KB, so hosted CI refused to start the producer (`Argument list too long`) while macOS accepted it. The diagnostic script and every assertion are unchanged.
