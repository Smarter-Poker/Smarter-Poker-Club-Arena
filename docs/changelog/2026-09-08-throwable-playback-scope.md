# Throwable playback scope and completion history

Completed throws could replay after a backlog of more than 512 receipts displaced their arrival history. Completed receipt history now updates on completion; active and queued events retain their own duplicate protection.

Each table and account visit now owns a distinct playback scope. Retained receive and completion callbacks cannot insert or remove animations in a later visit, including a return to the same table.

Validation: 107 focused tests pass, including a 514-event backlog and stale callbacks across table and account changes. TypeScript and the production build pass. Character coverage remains 51 of 80 enabled IDs. Donkey artwork generation returned no image, so no placeholder character was registered.
