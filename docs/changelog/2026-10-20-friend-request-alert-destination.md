# Friend Request Alert Destination

The footer announcement for an incoming pending friendship request now opens
Friends with the Requests tab selected when clicked. Receiving the event does
not navigate automatically. Explicit navigation respects the existing unsaved
draft guard, and accepted friendship inserts remain silent.

Rendered FriendsPage and router tests cover the click destination, no automatic
navigation, draft refusal and accepted-event behavior. Service reads and channel
transport are isolated; no production friendship is created for verification.
