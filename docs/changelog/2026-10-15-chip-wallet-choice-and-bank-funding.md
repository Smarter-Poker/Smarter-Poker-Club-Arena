# Recipient wallet choice and main-bank funding

Owner direction October 15 supersedes the August 25 forced-agent destination rule. Owners, co-owners, admins, super agents, agents and sub agents choose the recipient player or agent wallet when held. Admins continue to hold only agent wallets. Existing downline permissions remain in force.

The wallet modal, classic Send/Distribute, transfer modal, Super Agent dashboard and Trade batch composer now carry the explicit destination into their original RPC and durable retry identity. Recovery restores that destination; a deliberate wallet change creates a new intent. Claim backs follow the original transaction metadata. The Trade cashier permits bank-authorized self funding into either held wallet; ordinary agent-wallet self sends remain refused.

Bank-to-agent sends acquired the club row before the agreement advisory lock taken by the retained agent-row helper. Agent money operations take those locks in the opposite order. The bank wrapper now acquires agreement authority before entering its retained core, preserving the exact-intent gate and accounting behavior. A two-session PG17 regression demonstrates that the old bank send locks the club while waiting on agreement authority; the patched send waits before locking the club.

The bank cashier renders definitive errors and success inside its frame. A refused or failed send no longer depends on a toast being visible. Unknown responses retain the existing recovery identity and warning.

Qualification: real retained SQL bodies in isolated PG17, role/wallet balance and single-journal cases, identical retries and wallet conflicts, ineligible-wallet/downline/self refusals, bank self funding and migration replay refusal. Mounted React regressions cover wallet selection and visible bank refusal. Baseline UI and native regressions fail before the fix. The live bank RPC was additionally exercised with the established service identity in a single self-aborting transaction for both self destinations; no chips or test transactions were committed.

A missing declaration for the already imported Messenger request module prevented the required TypeScript check on the base revision. Its declaration is supplied as the minimal compilation prerequisite; runtime behavior is unchanged.

Delivery and final checks are recorded in the task checkpoint under the external evidence archive. No engine replacement is required.

The Super Agent dashboard now reads each recipient role and offers the held wallets. AgentService passes the selected destination through its existing durable operation and verifies the same destination in the receipt; a lost response preserves that exact choice on retry. Dedicated prepaid-float funding remains explicitly an Agent Wallet action.
