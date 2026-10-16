# Agents Are Prepaid And Carry No Credit Line

Dan, October 2026: Club Arena agents have no credit lines; every agent is
prepaid from now on.

## What Was Wrong

Every agent row already read prepaid (146 rows: all `is_prepaid`,
`credit_limit` 0, `credit_used` 0), but nothing held the rule, and two screens
contradicted it:

- The promote dialog on a member's page still asked Prepaid Or Credit Line and
  took a credit limit.
- The Create Agent form on Agent Management required a credit limit above 0,
  and `AgentService.createAgent` sent `is_prepaid = false` when the caller left
  it out. Create Agent could not make a prepaid agent at all.
- Agent Management had a Credit Limits view and a Credit Extended figure, and
  the agent dashboard's credit tab offered Set Credit Line To and Reduce Credit
  Line By.

## The Root Fix

Migration `20261016001952_agents_are_prepaid_and_carry_no_credit_line`:

- `fn_agent_default_prepaid` now runs `BEFORE INSERT OR UPDATE OF is_prepaid,
  credit_limit` on `agents`. It refuses any credit limit above 0 with
  "Agents Are Prepaid. Credit Lines Are Not Offered." and stores every agent as
  prepaid with a zero line.
- `CHECK (is_prepaid AND credit_limit = 0)` as `agents_are_prepaid`.
- The migration aborts unless every existing row already satisfies it, so no
  balance or term moves.

## The Screens

- Promote dialog: no funding choice; it always sends prepaid and says
  "Every Agent Is Prepaid."
- Create Agent: no credit limit field; the summary reads Funding: Prepaid.
  `AgentService.createAgent` always sends prepaid and refuses a credit line
  before calling the server.
- Agent Management: the Credit Limits view and Credit Extended figure are gone;
  the head reads Funding: Prepaid.
- Agent dashboard: the credit tab is now Agent Funding, with Send Prepaid
  Chips as its one action.
- The new club opening checklist no longer says "Choose Prepaid Or Credit".

Pinned by `tests/a-credit-line-is-spendable.law.test.ts` (section rewritten to
the new rule), `tests/unit/AgentService.test.ts`,
`tests/components/agent-management-authority-revocation.test.tsx` and
`tests/unit/theAgentNetworkReachesSomething.test.ts`.

## Installed

Installed on production 2026-10-16 and recorded as version `20261016001952`;
the file was renamed from its reserved `20261015221413` to match. Read back:
the constraint is validated and the trigger covers insert and update. A
rolled-back probe confirmed a credit limit of 100 is refused with "Agents Are
Prepaid. Credit Lines Are Not Offered." and `is_prepaid = false` is stored as
prepaid.
