# server/src/lightning/aLightningHandIsAHandInTheStats.law.test.ts

A settled Lightning hand carries the physical hand's private stats facts (one row per participant dealt in, horse or human, plus head-to-head transfers), keyed by the Lightning hand id at the host table and its club, built once per settlement; without a club or a working builder it settles exactly as before. Feeds ca_hand_facts and ca_hand_transfers, so the collusion scan, player stats and VPIP floor see Lightning hands.
