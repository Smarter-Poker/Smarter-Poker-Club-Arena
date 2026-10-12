# Native Schema Restore Preserves Logical Column Identity

The Owning Leaderboard Auth Qualification Run `37585966420` Restored The Schema After The Startup-Capacity Correction, Then Refused Its Catalog Comparison. It Did Not Reach Auth Qualification. The Private Catalogs Were Removed By Its Owning Cleanup, So The Complete Difference Is Unknown.

Read-Only Source Inspection Found 31 Relations With Dropped Physical Column Slots, 458 Live Columns After Those Slots, And One Explicit-Column Publication. Ordinary PostgreSQL 17 `pg_dump` Omits Dropped Slots: Its `shouldPrintColumn` Preserves Them Only For Binary Upgrade. Comparing Physical `attnum` Values Therefore Rejects An Otherwise Identical Native Restore.

The Maintained Fingerprint Now Compares Exact Live Column Order And Explicit Publication Column Names In That Order. Types, Defaults, Permissions, Owners, Security, Constraints, Indexes, Triggers, Functions And Every Other Existing Field Remain Checked. The Full Final Byte Comparison Remains Required. No Binary Upgrade, Source Catalog Write Or Equality Waiver Is Added.

On A Difference, A Bounded Private-File Reader Reports Only Fixed Section Names, Counts, Hashes And Changed Field Indices Before Cleanup. It Never Prints Identifiers, Field Values, SQL Or Raw Errors. Malformed Evidence Remains Unknown. Successful Diagnostics Never Mean Catalog Equality.

Retained Focused Contracts Cover Logical Order And Publication Membership Changes, Private Input Refusal And Safe Diagnostic Output. The Updated Catalog Query Executes Read-Only Against The Source And Returns All 22 Sections. Full Disposable Catalog/Auth Qualification Still Requires The Corrected Owning Runtime; Source Tests And This Record Do Not Claim It Passed.

This Is Verification Tooling Only. No Application, Financial Migration, Historical Settlement, Production Setting Or Engine Runtime Is Changed.
