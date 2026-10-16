# Recipient wallet choice and main-bank funding

Owner direction October 15 supersedes the August 25 forced-agent destination rule. Owners, co-owners, admins, super agents, agents and sub agents choose the recipient player or agent wallet when held. Admins continue to hold only agent wallets. Existing downline permissions remain in force.

The wallet modal, classic Send/Distribute, transfer modal, Super Agent dashboard and Trade batch composer now carry the explicit destination into their original RPC and durable retry identity. Recovery restores that destination; a deliberate wallet change creates a new intent. Claim backs follow the original transaction metadata. The Trade cashier permits bank-authorized self funding into either held wallet; ordinary agent-wallet self sends remain refused.

Bank-to-agent sends acquired the club row before the agreement advisory lock taken by the retained agent-row helper. Agent money operations take those locks in the opposite order. The bank wrapper now acquires agreement authority before entering its retained core, preserving the exact-intent gate and accounting behavior. A two-session PG17 regression demonstrates that the old bank send locks the club while waiting on agreement authority; the patched send waits before locking the club.

The bank cashier renders definitive errors and success inside its frame. A refused or failed send no longer depends on a toast being visible. Unknown responses retain the existing recovery identity and warning.

Qualification: real retained SQL bodies in isolated PG17, role/wallet balance and single-journal cases, identical retries and wallet conflicts, ineligible-wallet/downline/self refusals, bank self funding and migration replay refusal. Mounted React regressions cover wallet selection and visible bank refusal. Baseline UI and native regressions fail before the fix. The live bank RPC was additionally exercised with the established service identity in a single self-aborting transaction for both self destinations; no chips or test transactions were committed.

A missing declaration for the already imported Messenger request module prevented the required TypeScript check on the base revision. Its declaration is supplied as the minimal compilation prerequisite; runtime behavior is unchanged.

Delivery and final checks are recorded in the task checkpoint under the external evidence archive. No engine replacement is required.

The Super Agent dashboard now reads each recipient role and offers the held wallets. AgentService passes the selected destination through its existing durable operation and verifies the same destination in the receipt; a lost response preserves that exact choice on retry. Dedicated prepaid-float funding remains explicitly an Agent Wallet action.

The Send Out screen now defaults to the sender's Agent Wallet and lets them choose their authorized Agent, Main Bank, personal Promo, Club Promo and Player Wallet sources, with current balances. Each recipient's name and player ID share the top line; one destination dropdown and the selected balance occupy the second line. Agents default to Agent Wallet. The destination dropdown includes their held Player, Agent and Promo wallets. A scoped server read returns only authorized recipient balances.

The batch records the exact source and destination per item. Recovery persists both before submission and refuses to mutate an unresolved intent. The backward-compatible database extension uses explicit promo aliases so existing clients keep their historical API contract. Agent-to-Promo sends retain their ten-minute reversal and credit repayment. Player source sends debit only the authenticated operator's own balance, use the established exact-intent/journal owners and keep downline, role and wallet eligibility checks. Native PostgreSQL tests cover all15source/destination combinations, unchanged retries, conflicting-source refusal, rollback on journal failure, simultaneous retries, source balances, journal identity, and private balance-read authorization. Local evidence is separate from protected installation/publication and live proof.
