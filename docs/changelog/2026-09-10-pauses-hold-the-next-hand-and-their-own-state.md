# Pauses Hold The Next Hand And Their Own State

A pause arriving during the rest or time-bank read could still start the prepared hand. The engine now rechecks maintenance, deal, operator, synchronized-break and move/closeout owners at those boundaries, using the existing local unstarted-controller cleanup. Ordinary hand-for-hand re-arm still allows its next shared hand.

Operator resume no longer clears the separate maintenance lock or announces running while another pause remains. Other resume paths preserve the operator-held state. Fifteen regression cases failed before correction; 39 affected cases and server types pass. No database migration or financial write is added.
