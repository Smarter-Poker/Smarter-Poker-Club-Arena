# Member role controls follow current viewer authority

The member record refreshed the viewer role but retained grantable role buttons calculated for the previous authority. Role controls now wait for the first verified viewer role and reload server options when it changes. Existing server authorization remains authoritative.

A mounted-record regression fails before and passes after the fix. Initial hydration still requests role options once, and the existing explicit retry test remains valid. Focused component tests:16 passed; TypeScript passed. Production delivery is pending protected integration and client publication.
