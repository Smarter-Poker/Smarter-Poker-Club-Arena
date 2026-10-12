# Simple Cashier By Default

The Cashier opens in Simple mode on phones and desktop. The compact view shows
current players, their IDs and player chip balances, roster search, and persistent
Claim Back, Send Ticket and Send Out actions above the global navigation.
Player management links and selection continue to use the existing routes and
guarded dialogs. Deleted-account filtering and financial semantics are unchanged.

Advanced restores records, settlement, requests, tickets, reconciliation, detailed
balances, filters and the Classic Cashier link. Returning to Simple resets hidden
role, assignment and grouping filters. Mode changes do not remount the cashier or
clear selections, pending-operation recovery, confirmations or receipts. Pending
requests and held tickets appear as a count on the Advanced entry point.

Regression coverage mounts the real Trade page and checks the default mode,
actions, Advanced access and filter reset. Existing detailed-page tests explicitly
open Advanced; production cashier certification checks Simple before exercising
the existing Advanced financial and reconciliation flows.
