# Cashout requests accept exact cents

The cashout form and service previously rejected valid fractional-chip requests such as 0.29 and 1.25 even though the existing atomic cashout RPC accepts exact hundredths. Both now validate positive exact-cent amounts up to the existing single-request limit, while preserving the original amount and operation ID. The form checks the original decimal spelling before conversion so hidden sub-cent digits cannot be silently rounded away.

Max retains a valid cent balance. Percentage buttons select at the cent using the existing round-down policy and display the selected amount. Two columns keep the full preset amounts visible on narrow screens. Existing balance checks, settlement admission, synchronous submission ownership, escrow RPC and same-intent retry handling remain unchanged.

Independent reviews 0077 and its responsive addendum accept the bounded implementation, test-discovery and responsive corrections. All 119 affected service, escrow, helper and mounted-form tests pass under the repository test configuration; independent review also checked exponent and hidden-precision boundaries. Local full type checking remains limited by the Mac's missing native dependencies, so protected CI must supply the complete compile and build result. No SQL changes or live funded cashout are claimed by this source change.
