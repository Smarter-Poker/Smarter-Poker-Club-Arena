# Club greeting persistence proof uses its current button

The direct production acceptance setup stopped before its preference, artwork and ticker journeys because `dismissClubEntryMessage` still searched for the retired `Do Not Show Me This Message Again` name. The published Club Message renders `Do Not Show Again`.

Use the real button scoped to the Club Message dialog. Preserve the successful dismissal RPC acknowledgement, hidden-dialog check and stacked Diamond invitation handling. This changes browser verification only, with no client, engine or database changes.

The production failure screenshot and guarded disposable-account cleanup are retained in the existing live-preferences evidence. Focused regression, normal submission checks and the corrected production journey are recorded there separately.
