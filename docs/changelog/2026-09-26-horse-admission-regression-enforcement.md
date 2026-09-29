# Horse admission checks follow every maintained input

The oldest production-alert investigation reproduced the horse seating endpoint
resetting a closed chair in an already running tournament. Its source correction
and connected PostgreSQL regression are being delivered together.

The CI classifier previously did not recognize the new horse module, race driver,
paid-entry fixture or provider directories when edited alone. The wrapper change
would run them on this first delivery, but later input-only edits could miss the
required accounting job. Extend the existing Spin classification and its real
Git modification/deletion/rename tests to those exact inputs. Keep unrelated
paths outside the selection. No replacement workflow or scheduler is introduced.

Validation and publication are pending. Native source tests, protected delivery,
database installation and live proof are separate requirements. Historical
recovery and incident closure remain open.
