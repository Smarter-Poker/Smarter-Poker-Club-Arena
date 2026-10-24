# Lightning Keeps Live Cards And Original Controls

A fast fold can deliver the next hand before the old seat's fold animation timeout. The action change cancelled that timeout while retaining its folding pose, so the main felt kept hiding cards that the table tab correctly displayed. The original seat action transition now releases the old folding pose when the action changes away from fold. The normal fold animation duration remains unchanged.

The extra Lightning statistics/tools row, duplicate fold text row and decision queue below the tabs are removed from the table page. The original action panel, instant fold preselection, tab urgency indicators and explicit tab selection remain. Player names, stakes, pot and gameplay labels are preserved.

The real SeatSlot rerender regression fails before and passes after the fix. Focused tests also retain animation, seat rendering, original Lightning actions and no automatic table switching checks. This is client-only and uses the serving engine contract.

The hidden Fold & Watch keyboard binding and its remembered-choice write are removed as well. Shift+F and the original fold/preselection use immediate release.

This client batch also includes the funded-anchor handoff and safe public-observer consumer. Public observer snapshots cannot promote matching player IDs into hero ownership or recover private cards/actions. Funded room entry remains an explicit player gesture, using the original seat truth independently of the public roster. The operations workspace uses the selected game's actual owning club when a union routing view is present, retaining the existing authorized RPC checks. No engine implementation, maintenance window or migration is included in this client batch.
