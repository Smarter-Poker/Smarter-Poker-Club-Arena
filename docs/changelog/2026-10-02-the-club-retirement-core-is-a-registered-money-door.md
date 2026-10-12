# The Club Retirement Core Is A Registered Money Door (2026-10-02)

## Context

Migration `20261002152925_club_retirement_safe_unwind` (PR #5837) renamed the
original `fn_retire_settled_club(uuid,text,text)` to
`fn_retire_settled_club_core_20260906` and put a new owner-facing wrapper of
the old name in front of it. The registry row in `ca_money_rpc_registry` stayed
with the old name; the body that writes `clubs.chip_treasury` moved to a name
the registry had never seen.

From about 15:29 UTC `fn_ca_money_rpc_drift()` returned
`fn_retire_settled_club_core_20260906`, and `fn_ca_midway_burnin_gate()`
failed `no_unregistered_money_rpcs = 1`.

## What this adds

Migration `20261002191630_the_club_retirement_core_is_a_registered_money_door`
registers the core as `approved`, the same way the earlier `*_core_YYYYMMDD`
subroutines are registered (`fn_agent_wallet_send_core_20260830` and others).

The core is not a leftover. The wrapper calls it for every retirement after its
welcome unwind and opening-grant checks. Only `service_role` can call it.
Before the migration registers it, it checks that the core exists and that
`anon` and `authenticated` cannot execute it. Afterwards it checks that no
`fn_retire_settled_club*` balance writer is left unregistered.

No function body changes.

The companion lane-doctrine finding
(`global_lane_callers_are_reviewed: fn_retire_settled_club`) was already
cleared live by migration `20261002165000_welcome_reset_indexed_hand_checks`
(open PR #5841). This change does not touch it.
