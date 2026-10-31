# Caddy preflight receives its configuration

The isolated Linux bootstrap fixture explicitly pipes stdin for its real Caddy configuration preflight. Its shared command helper continues to ignore stdin for other commands. Previously that helper discarded the supplied configuration, so Caddy refused EOF before the four bootstrap scenarios executed.

A regression extracts the maintained helper and preflight options and sends exact bytes through an actual child process reading stdin. It fails with the discarded input and passes with the explicit pipe. Production configuration and bootstrap behavior are unchanged; successful hosted execution remains required.
