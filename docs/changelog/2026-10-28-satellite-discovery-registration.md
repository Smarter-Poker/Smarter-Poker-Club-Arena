# Satellites beside Details

Every tournament now exposes Satellites immediately after Details. Both satellite lists use normal lobby sections instead of the large painted card frame. Their registration actions use the same confirmed purchase hook as the tournament header, carrying the satellite's stored price and wallet scope, then refreshing the authoritative registration read. Existing fixed-format games retain their Take A Seat route.

The loader includes both current and legacy target pointers and does not filter out Sit & Go formats. Format assignment and settlement remain authoritative on the server. This client change does not introduce or activate a new tournament format.

Validation: focused registration payload and tab-order tests; existing satellite mapping and overview tests; TypeScript and design/copy gates. Production publication and actual affected-flow proof are recorded separately in the task checkpoint.
