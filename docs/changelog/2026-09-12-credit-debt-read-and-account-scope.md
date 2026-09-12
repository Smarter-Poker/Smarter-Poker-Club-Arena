# Credit invoice availability and account scope

Failed invoice reads now report unavailable debt and allow a later retry. Invoice panels clear the previous agent's rows when the selection changes and ignore obsolete read and payment continuations. Only a successful empty response displays an empty invoice list.

Credit checks initialize their account identity from the existing canonical identity source. Same-account token refreshes preserve valid reads and failure circuits, while account replacement fences pending results. A reinstatement response received after replacement does not publish success into the new account; its error states that the dispatched operation may already have committed.

Financial health shows the latest unavailable or partial suspension scan and its timestamp, including disabled checks. The existing overdue rules, server operations, suspension thresholds and default warning-only policy are preserved.

Validation: independent source reviews 0067/ADD01/ADD02, including mounted caller and canonical identity checks; 70 focused repository tests pass after integration. Local whole-project typecheck has the same missing native SDK diagnostics on baseline and candidate. Protected CI, served publication and authenticated financial-flow evidence remain separate release gates.
