# Mystery receipt validation uses bounded credit-key lookups

The two mystery events in the existing 18-event held-house-fee operation each
scanned approximately 560,000 wallet credit keys three times while validating
terminal payment evidence. A bounded production read measured 168 ms for the
residual-key scan and 604 ms for the obligation checks for one event. This
unnecessary work consumed the existing five-second owner-operation budget;
these component measurements are not a full-operation timing guarantee.

The migration adds a `text_pattern_ops` index and explicit bytewise prefix
bounds to the four dynamic prefix queries in
`fn_ca_mystery_bounty_completion_evidence`. The existing locale-aware primary
key remains. Every original LIKE predicate, recipient, amount, inventory,
interval, and combined-evidence check remains unchanged. Prefixes ending in a
colon use the next ASCII byte as their exclusive bound; residual UUID prefixes
use the successor of the final hex digit, retaining arbitrary Unicode suffixes.

The maintained held-fee native qualification compares the original and changed
validator over mixed, legacy, obligation, and split-payment evidence plus
missing, wrong-recipient, wrong-amount, malformed Unicode, gap, and overlap
cases. Prepared custom and generic plans must use the bounded index under ICU
collation without disabling sequential scans. Source binding includes the
migration, fixture, runner, and qualification module; predecessor drift must
roll back the entire migration.

The migration changes no financial data. It preserves function ownership,
permissions, and configuration, refuses predecessor drift or an index-name
collision, and creates the index in the same short transaction under a
five-second statement limit and one-second lock limit. Required protected
merge, exact installation/readback, and the existing self-aborting financial
probe remain separate from source qualification. No engine replacement is
required.
