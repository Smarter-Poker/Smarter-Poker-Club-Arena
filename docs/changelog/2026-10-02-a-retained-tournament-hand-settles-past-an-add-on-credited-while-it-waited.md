# A Retained Tournament Hand Settles Past An Add-On Credited While It Waited (2026-10-02)

## What Happened

09a56a25 "Prime Time Free Buy (NLH)" (28 playing) dealt nothing on its three
9-handed tables from 01:49 UTC. Each table held a finished hand retained by a
dead engine generation, and every resume logged
`retained_hand_submission_readback_failed: HAND_SUBMISSION_HANDOFF_STATE_CHANGED`.

## Cause

On each table one player's 10,000-chip add-on was credited to the chair while
the hand waited. The resume door demanded every chair still hold exactly the
stack the hand was dealt from, so the add-on refused the handoff for ever.

## Fix

Migration 20261002060742 admits, on a tournament table only, a chair holding
exactly the dealt stack plus the event's addon_chips when its registration
bought the add-on. The settlement runs in delta mode, so the hand's result is
applied on top of the add-on and nothing is lost.
