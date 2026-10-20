# Keep the ticket-discovery fixture outside launch preparation

Engine release 39442726703 failed PrestartTicketDiscovery's positive top-up case. Its real-clock start was ten minutes ahead. At 14:52 UTC that is a 15:02 start, whose break-adjacent preparation opens before :53, so discovery correctly takes launch admission before the optional ticket top-up.

Reproduced locally with Date.now fixed to 14:52: one failure, nine passing cases. Fix the fixture to an ordinary 15:20 UTC, target 15:30, with Date.now restored after every test. No runtime launch, maintenance or admission rule changes. Existing assertions are retained.
