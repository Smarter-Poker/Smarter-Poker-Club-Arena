# Qualify Private History Admission And Join Separately

The unchanged 15-second history check began after its HTTP read, while maintained client admission allows 20 seconds for transport/auth before the original SDK join. A controlled 18-second admission plus one-second join demonstrates the former false failure. Production's recent failed joins lack on-wire timing, so this does not establish their cause.

Observe before navigation. From disclosure opening, require an outgoing private history join within 20 seconds, then its topic/ref-correlated acknowledgment within the unchanged 15 seconds, at most 35 seconds overall. Retries never reset that join deadline. Fixed phase/timing diagnostics contain no topic, reference, frame payload or credentials. Clean up listeners and pending timers. Export, authorization, private history broadcast and notice assertions remain unchanged.
