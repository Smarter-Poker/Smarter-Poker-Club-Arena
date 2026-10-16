# Native Messenger chat windows on desktop and mobile

Owner request: reproduce Facebook desktop Messenger's bottom-right live chat pattern in Smarter.Poker, including phone browsers. The requested Messenger visual reference governs this feature; existing Arena artwork and table controls are unchanged.

A lazy root component adds native React chat windows, minimized avatar bubbles, unread launcher, multi-window capacity, and a one-window mobile layout with visualViewport keyboard clearance. No new iframe or bridge is introduced. Opening the full inbox while live tables exist uses the maintained OPEN_HUB_TAB path.

The same portable sources are maintained in World Hub's src/components/messenger/dock and vendored here byte-for-byte, with small app-specific authentication/navigation adapters. The UI uses the existing authenticated Messenger APIs. Realtime IDs pass server workspace resolution before opening a window; message content is fetched through the existing protected reader. Existing durable-send and account-continuity algorithms are copied exactly and parity checked. Account changes clear the dock and invalidate outstanding reads. Incoming activity never focuses the composer; explicit minimization remains respected.

World Hub migration messenger_messages_realtime_dock enables the existing RLS-protected social_messages publication. It changes no grants, policies, financial records or engine contract. Both clients use the serving engine unchanged; client publication has no maintenance-hour dependency.

Verification and delivery identities are recorded in the owning task checkpoint. No claim of exact current Facebook pixel parity is made without a signed-in Facebook reference. Calls and full conversation management remain available through Open In Messenger; this change does not replace their maintained full-page implementations.
