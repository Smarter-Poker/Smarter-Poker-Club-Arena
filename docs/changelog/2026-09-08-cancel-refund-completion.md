# Finish cancellation financial work before closing registrations

Cancellation cleanup previously closed all registrations and tables even after refund evidence, settlement or fee reversal failed. An already refunded player was skipped before fee reversal, making a refund-success/fee-failure split unrecoverable on the next pass.

The original helper now stops on missing financial evidence, partial or unconfirmed refund, and failed fee work. Fully refunded players still reach unfinished fee reversal without another settlement call. Registrations close only after these steps succeed; a registration-close failure also leaves tables open.

Twelve executable cases exercise the real helper with scripted external I/O. Eleven failed before correction; all twelve pass afterward, alongside the five existing gross-entitlement cases, server TypeScript and all 6,563 server tests. Real concurrent fee-reversal sessions, historical cancelled rows, and deployed runtime remain separate verification work. No new recovery process or wallet writer is introduced.
