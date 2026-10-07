# Leaderboard Isolation Restores Exact Owner ACLs

## Prepared Repair

The Actual Current-Schema Qualification Refused Database, Schema And Relation ACL Differences Before Auth Ran. Native PostgreSQL 17 Reproduction Shows That Archive Listing Without `--create` Omits Database And Database ACL Entries. The Restore Now Lists And Selects Both Explicitly, And Excludes Them From The Remaining Archive.

A SELECT-Only Source Export Captures Exact Non-NULL Database, Schema, Table And Sequence ACLs Before And After The Schema Export. Private Inputs Must Match Before Any Destination Replay. A Separate Guarded Atomic Transaction Replays Only Owner-Granted ACL Contents Under The Original Owner, Including Grant Options. Unsupported Grant Chains Or Owner Changes Refuse. Dynamic `pg_database_owner` Uses The Captured Database Owner. No Catalog Writes, CASCADE, Production Permission Changes Or Equality Relaxation Are Introduced.

Native Reproduction Also Shows That Table-Level REVOKE Can Remove Column Grants. The Export Therefore Captures Every Live Column ACL On Each Selected Relation, Requires Its Exact Preimage Before A Table Repair, Restores Its Owner-Granted Privileges And Grant Options, And Verifies Exact Readback Including NULL. The Generated DO Body Is Quoted As A Complete Literal, So Legal Delimiter-Bearing Names Cannot Escape It.

Native Pretty Definition Rendering Avoids Redundant Boolean Grouping Differences After Dump/Reparse. Operators, Meaningful Casts, Mixed Precedence, Validation And Trigger Enabled States Remain Compared. Native Positive And Negative Regressions Are Enforced In The Existing Accounting Shard Four Step, Without Adding A Job.

The Auth Script Is Rematerialized From The Maintained Preflight. The Prospective Financial Generator Pin Is Refreshed For That Reviewed Input; Original Financial Baselines Remain Unchanged.

## Qualification Boundary

Source And Narrow Native Regression Results Do Not Establish Full Current-Schema Equality, Actual Auth Qualification, Financial Runtime Qualification, Installation, Publication Or Launch Completion. Those Existing Gates Remain Required. No Synthetic Financial Test Runs Against Production, And No Player Balance Or Historical Settlement Is Changed By This Repair.
