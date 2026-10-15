# Agents Set The Rakeback Their Players Receive

Dan, 2026-10-15: "THE OWNER ASSIGNS THE AGENT A SPECIFIC RAKE BACK AMOUNT FOR
EACH AGENT, THAT AMOUNT THEY ASSIGN IS FOR THE AGENT ACCOUNT THAT THEY PLAY
UNDER AS WELL AS ANY AND ALL SUB AGENTS UNDER THEM. THE AGENT ASSIGNS WHAT THEY
WANT TO GIVE THEIR PLAYERS, THIS SHOULDN'T BE DONE BY THE PERSON PROMOTING
THEM."

## Screens

- Promote To Agent (player page): the Player Rakeback field is gone. The
  promoter sets "Agent Rakeback Percent (0 To 70)", the agent's own rate,
  which covers their own account and every sub agent under them, plus funding.
- Add Agent (agents screen): the Player Rakeback slider is gone; same rate label.
- Agent Dashboard, Your Rates: "Your Rakeback (Set By The Club)", "Rakeback You
  Give Your Players", and a field to set it (0 to the lesser of 50% and their
  own rate).

## Server (`20261015163259_agents_set_the_rakeback_their_players_receive`)

- `fn_club_set_member_role`, `fn_create_agent`: no player rakeback needed; a
  promotion that does not name one starts at 0. The upline's player rakeback no
  longer caps it; the agent's own commission does.
- `fn_guard_agent_agreement`: player rakeback capped by the agent's own
  commission instead of the parent's player rakeback; an upline's player
  rakeback no longer limits its sub agents'. Commission and credit keep their
  upline caps.
- `fn_agent_set_player_rakeback(club, rate)`: the agent's own door; audited,
  and captured by accounting_agreement_history through the agents trigger.
- An agent's 0 now means 0. `fn_calculate_cash_rakeback_periods`,
  `fn_rakeback_split_check`, `fn_rakeback_split_write` and
  `fn_player_rakeback_rate` paid the legacy volume ladder (5% to 30%) whenever
  an agent's offer was 0; the ladder now applies only to players with no agent.
  Read before the change: all 1,575 players with an agent sit under an agent
  with a non-zero offer; the one active agent at 0 has no players. No current
  figure moves. `fn_accounting_legacy_certify_week` is untouched (closed weeks).

Law `tests/promotion-assigns-the-rate.law.test.ts` updated in the same commit.
