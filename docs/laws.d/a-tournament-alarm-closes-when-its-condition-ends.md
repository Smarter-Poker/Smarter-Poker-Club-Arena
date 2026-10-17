# tests/a-tournament-alarm-closes-when-its-condition-ends.law.test.ts

A "table can't start" or "tournament dark after rebuild" alarm closes itself on evidence its condition ended (event finished, a hand committed after it, or the table closed), never on age.
