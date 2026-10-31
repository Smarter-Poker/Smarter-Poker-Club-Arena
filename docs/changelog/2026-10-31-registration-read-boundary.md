# Bound original tournament registration waits

The original registration RPC and its roster read could remain pending forever. The browser retained a safe payment identity, but its in-memory operation and navigator lock never settled, so subsequent clicks joined the same hung work.

Each admission, roster and optional start-nudge request now has a finite response boundary and an AbortSignal. Its budget imports the maintained client authority/read budget from `gameManagementReadDeadline.ts` (currently 10 seconds), rather than defining another independent timeout. Timeout rejects before abort to prevent an abort response from entering the existing same-id admission replay branch. Racing each awaited step prevents late responses from continuing into events or start-time writes even when transport ignores abort. No automatic payment retry was added.

An unconfirmed admission or roster leaves the original request pending. A later explicit request reuses that identity and can accept its matching durable receipt. Once receipt and roster are confirmed, optional freshness/start-nudge timeout is reported but cannot misrepresent the known registration as failed. Existing MTT, SNG, Spin and seat-first satellite selection remains unchanged.

Regression coverage uses the actual service and persisted intent owner against a held loopback HTTP response for admission and roster. It covers duplicate clicks, no timeout replay, late-response retirement and subsequent explicit same-request recovery. Isolated cases also preserve known success when optional reads/writes hang across applicable formats. This proves client behavior, not production SQL idempotency, ledger correctness or live publication. No production registrations or monetary writes were performed.
