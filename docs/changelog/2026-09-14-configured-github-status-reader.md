# Read pull-request status with the configured GitHub client

Agents can read current Actions checks without exporting a token when the configured GitHub CLI is available. Explicit environment credentials keep precedence; rejected credentials, unavailable clients, malformed responses, and unreadable rules remain unknown. Reads have a deadline, and errors do not echo credential-bearing child diagnostics.

The reader reports the approving-review minimum from the effective main-branch rules separately from check status. Unknown is distinct from zero. A blocked pull request no longer promises that enabling auto-merge will clear every requirement.

Validation: 59 tests across the authentication/transport suite, existing status-verdict law, and source-window guard passed with the normal repository setup. Live reads using the configured CLI without environment tokens resolved current PR heads and required checks. These checks establish local reader behavior; merge and deployment remain separate evidence.
