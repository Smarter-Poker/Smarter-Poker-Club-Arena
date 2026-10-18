# The Lightning worker-off choice is a string

After a verified Madness shadow drain, GitHub rejected `stage=off` with HTTP
422 because `off` was not an allowed choice. The unquoted YAML choice is
boolean false under YAML 1.1 parsing. Quote that scalar so the existing worker-off
action can be dispatched normally. A source regression runs before every stage
operation and preserves the quoted choice. No engine, database or control-door
behavior changes.
