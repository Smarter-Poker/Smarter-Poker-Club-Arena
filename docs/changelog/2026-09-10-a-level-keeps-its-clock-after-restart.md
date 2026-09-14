# A level keeps its clock after restart

A manager that stopped just after publishing a blind level could leave the new level paired with the previous level's start time. Recovery then gave a fresh ten-minute level only one second before advancing again.

The tournament row now publishes the level and its start time together. The continuing manager subtracts time spent completing the transition from the same start time, so a slow broadcast and a replacement manager use the same deadline.

Two runtime cases call the actual manager transition and recovery methods with mocked persistence. Both table rows reach the same new blinds, and both continued and recovered managers retain 598 seconds after a two-second transition delay. Server TypeScript checking passed. This correction does not close the entire durable-clock audit or establish production adoption.
