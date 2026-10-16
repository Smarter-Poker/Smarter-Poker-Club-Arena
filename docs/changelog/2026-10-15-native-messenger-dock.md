# Native Messenger chat windows on desktop and mobile

Owner request: reproduce Facebook desktop Messenger's bottom-right live chat pattern in Smarter.Poker, including phone browsers. The requested Messenger visual reference governs this feature; existing Arena artwork and table controls are unchanged.

A lazy root component adds native React chat windows, minimized avatar bubbles, unread launcher, multi-window capacity, and a one-window mobile layout with visualViewport keyboard clearance. No new iframe or bridge is introduced. Opening the full inbox while live tables exist uses the maintained OPEN_HUB_TAB path.

The same portable sources are maintained in World Hub's src/components/messenger/dock and vendored here byte-for-byte, with small app-specific authentication/navigation adapters. The UI uses the existing authenticated Messenger APIs. Realtime IDs pass server workspace resolution before opening a window; message content is fetched through the existing protected reader. Existing durable-send and account-continuity algorithms are copied exactly and parity checked. Account changes clear the dock and invalidate outstanding reads. Incoming activity never focuses the composer; explicit minimization remains respected.

World Hub migration messenger_messages_realtime_dock enables the existing RLS-protected social_messages publication. It changes no grants, policies, financial records or engine contract. Both clients use the serving engine unchanged; client publication has no maintenance-hour dependency.

Verification and delivery identities are recorded in the owning task checkpoint. No claim of exact current Facebook pixel parity is made without a signed-in Facebook reference. Calls and full conversation management remain available through Open In Messenger; this change does not replace their maintained full-page implementations.

## Owner Follow-Up: Incoming Preview, No Permanent Launcher

A new message shows a white bottom-right preview with an X. Clicking the preview opens its conversation; dismissing it changes neither persisted messages nor the read watermark. Idle pages have no Messenger launcher. The live listener remains mounted, and the blue chat controls are available only while a conversation is active. Account changes clear notices, queued projections stay bounded, and explicit opening survives a simultaneous incoming event. Short mobile layouts reserve separate space for previews and the existing notification stack. The established send and continuity helpers remain unchanged. Deliver this correction through its own protected follow-up PR after the original merged delivery.
