# Table artwork decode failures stay failures

Investigating Lucky's Android Chrome screenshot exposed a readiness defect: the table artwork loader resolved both successful and rejected image decoding as success. That stored a failed image URL in the session's decoded cache and prevented the existing shared load from attempting another URL.

Rejected decoding now follows the existing bounded image-load failure path. The session cache receives only successful decoding results; concurrent callers still share one request. Existing gameplay cover deadlines and saved-theme behavior are unchanged.

The regression fails against the previous implementation and passes after the correction. It verifies that a loaded image with nonzero dimensions and a rejected decode is not certified, the next successful candidate is returned and cached, and concurrent callers share that outcome. The exact rectangular corruption in Lucky's screenshot has not been reproduced; this correction is not proof that the reported incident is resolved. Physical Android verification remains outstanding.
