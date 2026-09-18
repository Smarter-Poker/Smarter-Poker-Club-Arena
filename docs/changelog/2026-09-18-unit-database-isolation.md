# Unit tests cannot inherit the production database

The server unit runner now sets an inert Supabase origin and an explicit test
key before setup and application imports. Previously an unmocked client import
fell back to the production project, and SDK requests reached it with a
placeholder key. An inherited valid key would have been more dangerous.

The regression intercepts transport while using all three real service clients.
It fails against the original configuration both without database environment
variables and with an inherited canary URL/key. Transport errors remain errors;
the change does not mock successful database behavior. Isolated PostgreSQL and
explicit live qualification retain their separate execution paths.

Production client configuration, game events, financial transactions and
credentials are unchanged. No reduction in billed Realtime messages is claimed
from eliminating these rejected HTTP requests.
