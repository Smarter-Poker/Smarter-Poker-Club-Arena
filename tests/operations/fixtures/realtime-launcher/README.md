These credential-free fixtures preserve the pinned launcher preimages used by
the Docker build. They are not service implementations or native proof.

- `realtime.sh`: Elixir v1.19.5 `Mix.Tasks.Release.Init.cli_text`, with its
  documented heredoc indentation removed and its two EEx expressions rendered
  for release name `realtime` and default `-mode $RELEASE_MODE`. Supabase
  Realtime v2.134.10 `mix.exs` has no reboot-system-after-config override.
  SHA256: `b35710db4fe3c141340dac83d02fbe9d3c8407ff600eb98915f54feb69e227a9`.
- `env.sh`: exact Supabase Realtime v2.134.10 `rel/env.sh.eex` bytes, containing
  no EEx expressions. SHA256:
  `3fbe75e1c0ea82357e01a38af7666f2f54fac8e389c303084a45a48aeb178121`.
- `runtime.exs`: exact Supabase Realtime v2.134.10 `config/runtime.exs` bytes.
  SHA256: `6892bee389b9974972ece8e8737d2cdbe8bac50e82f2776037641e786b16d84c`.
  The fixture adds only the loopback address to the HTTP listener's socket
  options. The genuine service must prove the resulting Linux listener at run time.

Sources:
https://github.com/elixir-lang/elixir/blob/v1.19.5/lib/mix/lib/mix/tasks/release.init.ex
https://github.com/elixir-lang/elixir/blob/v1.19.5/lib/mix/lib/mix/tasks/release.ex
https://github.com/supabase/realtime/blob/v2.134.10/rel/env.sh.eex
https://github.com/supabase/realtime/blob/v2.134.10/mix.exs
https://github.com/supabase/realtime/blob/v2.134.10/config/runtime.exs

Elixir template copyright 2021 The Elixir Team and 2012 Plataformatec, licensed
under Apache-2.0; the complete upstream license is `LICENSE.elixir`.
Supabase Realtime is also Apache-2.0 licensed.
