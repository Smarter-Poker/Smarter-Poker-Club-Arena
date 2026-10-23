# Keep Recorded Board Awards Visible In Summary

Hand Summary placed uncontested board awards in Detail's overflow-hidden frame. As a direct child of the modal's scrolling flex body, that frame shrank to two pixels and hid the recorded payout rows.

Summary now prints those same recorded amounts through its existing two-column row layout. Detail keeps its existing frame. Cards, privacy, pot allocations, monetary formatting and No Showdown behavior are unchanged.

The real-modal browser regression fails before and passes after at 375x812 and 1280x720, checking row containment, both recorded board amounts, loaded private cards and horizontal overflow. It runs in the existing required CSS Beat check. The component regression also pins the Summary and Detail variants.
