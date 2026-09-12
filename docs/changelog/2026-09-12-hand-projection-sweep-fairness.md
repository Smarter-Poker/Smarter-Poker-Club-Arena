# Hand projection backlog progress

A blocked prefix could repeatedly consume the worker's 1,000-row budget before later healthy tables received a turn. Keep a finite sweep boundary, cursor and blocked-table set across passes, then return to older deferred work with the existing retry delay.

The worker retains the cooperative deadline and physical promise ownership from PR4402. A partial page advances only through the contiguous prefix whose table chains have settled, preserving unstarted work even when another lane finishes later rows. Started chains retain their existing per-table ordering and financial receipt rules.

Validate complete page and frontier responses before advancing: verified empty arrays establish absence; malformed responses and unsupported integer precision retain an error and retry. The supported ordering range remains positive safe integers, including canonical decimal wire strings. This does not claim hard cancellation of a hung transport request.

Validation: independent source/composition reviews 0070 ADD01/ADD02; 73 worker tests and the full server typecheck pass in the integration checkout using existing server dependencies. The partial-page regression also rejects a deliberately unsafe full-page cursor mutant. Protected CI, publication and funded outbox/conservation evidence remain separate release gates.
