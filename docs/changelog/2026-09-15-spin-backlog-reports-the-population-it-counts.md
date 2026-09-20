# The Spin backlog reports the population it counts

The received SpinUnfilledBacklog alert said that 22 games were past their fill
deadline and that the expiry timer had failed. Its input counts partly filled
REGISTERING or ANNOUNCED Spins with no recorded start. The view exposes each
oldest live seat time, but filters neither that age nor the fill policy or booked
draws. Twenty minutes above the population threshold does not establish how long
each member has waited or whether cancellation is lawful.

The alert and metric help now describe that measured population and direct the
investigation to each game's age, policy, draw and hand evidence, and actual
expiry result. The numeric count, alert identity, labels, threshold and duration
are preserved. Booked and played games stay visible and require their existing
continuation or settlement authority.

This is a source correction to the alert's unsupported diagnosis. It does not
repair or settle an affected game. The September 13 snapshot retained the count,
not a contemporaneous list of 22 identities. Earlier and later entity lists are
separate evidence; matching their count cannot establish original membership.

Current authority inspected September 15: fn_spin_metrics full definition MD5
9a85c17823966c26901422a473dcb911 counts every v_spin_unfilled_waits row. The exact
source base is the locally retained deployed revision
365642c61a4e59eb96e6f4779c31f10c2ebd231c. Current database definitions and that
later engine revision do not prove the complete September 13 installation.

Validation status: source review only; protected checks, publication and live
readback remain pending. The required existing monitoring and Spin checks must
bind final source bytes through restored GitHub checks and provider publication.
A wording change, a disappearing alert, or a lower later count cannot close the original
incident. Exact original outcomes remain part of the active FIFO completion gate.
