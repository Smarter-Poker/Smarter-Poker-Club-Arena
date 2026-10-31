# Linux bootstrap fixture Caddy grammar

The isolated Linux qualification failed before bootstrap because its generated unrelated-site block put a directive on the opening-brace line. The replacement gateway block had the same malformed shape. Both now use Caddy's multiline block syntax while preserving the unrelated site and the production gateway path.

Each container now parses both exact generated configurations with the real Caddy binary before starting it, so invalid configuration fails directly instead of appearing as a readiness timeout. The original rendered configuration failed real Caddy adaptation; both corrected configurations pass. The four hosted Linux bootstrap scenarios remain required and are not certified by this local parser check. No production configuration or service was changed by this correction.
