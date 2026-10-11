# Player Command Grant Focus Transitions

Choosing A Recipient Removed The Focused Picker Button, And Change Removed Its Own Button. Focus Fell To The Page Body Until The Next Tab. The Shared Dialog Trap Stayed Mounted, So Its Initial Focus Effect Did Not Run For Either Step Transition.

PromoVaultPage Now Transfers Focus To Quantity To Send After Choosing A Recipient And Search Players After Change. A Transition Flag Limits The Layout Effect To These Explicit Actions; Quantity And Busy Renders Do Not Restart Focus Or The Dialog Trap. Initial Focus, Escape, Cancel, Opener Restoration, Permissions, Request Ownership And Audited Grant Submission Remain Intact. Artwork Is Unchanged.

The Actual Component Failed Both Pointer And Enter Transition Checks Before The Repair. All Eight Vault Accessibility Cases Pass Afterward, With Immediate Choose/Change Assertions Before Any Next Tab, Quantity Rerender Focus, Both Tab Directions, Escape And Exact Opener Restoration. Tests Assert No Grant RPC Is Submitted. Before/After Logs Are Retained In The Existing External Player Command Evidence Folder.

Production Grant Execution Was Not Tested: The Observed Live Item Had No Owned Stock. Publication And Cold Live Verification Belong To The Owning Release Task.

The Same Live Review Also Demonstrated A Zero-Stock Tile Named Grant That Opened Buy For An Admin. Its Accessible Name Now Follows The Existing Action Branch: Grant For Owned Stock, Buy For A Manager Without Stock, And Check Availability For A Read-Only Viewer Without Stock. Both Zero-Stock Component Cases Failed Before The Label Repair And Pass Afterward. The Admin Case Checks Buy Initial Focus And Exact Cancel Return; The Read-Only Case Checks The Existing No-Stock Status Without Opening A Dialog. Neither Submits A Financial RPC. All Ten Vault Accessibility Cases Pass; The Prior Positive-Stock Grant And Transition Assertions Remain Intact.
