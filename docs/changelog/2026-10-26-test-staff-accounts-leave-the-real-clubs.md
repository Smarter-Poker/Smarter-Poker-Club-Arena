# Test staff accounts leave the real clubs

Dan, 2026-10-26: "REMOVE ANY AND ALL 'STAFF MEMBERS' I HAVEN'T CREATED ANY,
ITS ONLY ME FOR KINGS CLUB".

## What was there

Read 2026-10-26: every admin in KINGS CLUB (14), Deep Stack Society (14) and
Midway Union (11) was a post-deploy verification identity (PostDeployxxxxx,
`ca-customization-cert-postdeploy-*@example.invalid`), created 2026-10-23 to
2026-10-25, zero balance, unseated. No real person held a staff role.

## Cause

Post-Deploy E2E makes one zero-balance admin per run and removes it through
`cleanup_reserved_certification_account`. On 14 runs that door refused
(`CERTIFICATION_PROTECTED_MEMBERSHIP_HAS_AUTHORITY_OR_CUSTODY`, for example run
40208304104 on 2026-10-25) and nothing removed the membership afterwards.

20261026031314 (members with no agent sit under the club owner) would then have
made the door refuse every future run, because a new test member now joins
under the owner and the door read any agent as authority.

## Fix (migration 20261026050506 and the setup script)

1. The test admin is promoted with `agent_id` cleared: staff sit under no agent.
2. The cleanup door reads an upline that is the club owner as no authority. A
   real agent or a parent agent is still refused.
3. The identities already left behind were removed in the same transaction:
   11 through the cleanup door itself (it removes their staff memberships and
   leaves the sign-in to the Auth API, as for any run that completes); 3 the
   door refuses for unrelated reasons (two own an unretired test club, one holds
   a half-made pending row) had their memberships departed through the
   lifecycle departure write.

KINGS CLUB now has no staff but its owner, KingFish. Nothing moved money.

Pinned by `tests/test-staff-never-stay-in-the-real-clubs.law.test.ts`.
