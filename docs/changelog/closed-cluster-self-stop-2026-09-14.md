# Let a closed cluster table finish its own dealing loop

An empty, closed cluster table could call and await stop from its own dealing loop. Stop waits for that exact loop before releasing ownership, creating a circular wait until an outer step budget reported a failure.

The close check now starts the same cached stop operation and returns after its synchronous terminal fence. The dealing loop can then finish, while stop continues to retain ownership through the loop, accepted writers and snapshot cleanup. A failed teardown is reported and its original rejected promise remains available to the owner.

A regression uses the real engine stop path to prove that the close check returns without allowing a successor to claim the table before the loop and snapshot finish. The old source fails that case. This is a separate source-level defect; it is not proof of the cause or recovery of the current occupied-table settlement holds.
