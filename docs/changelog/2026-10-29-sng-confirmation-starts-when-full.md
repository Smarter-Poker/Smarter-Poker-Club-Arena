# Sit & Go Satellite Confirmations Start When Full

Fixed-field six and nine handed satellite signup cards now show When Full instead of their internal scheduling timestamp. Satellite cards, target details and shared lobby registration paths pass the recorded two-seat contract to the existing confirmation. Scheduled tournaments retain their exact clock and unregister note; cancellation and purchase handling are unchanged.

The regression fails against the previous dialog and passes after the correction. Focused registration and satellite tests cover six/nine seat recognition, malformed and scheduled records, exact scheduled text and cancellation without a purchase. This client correction changes no engine, database, prices or settlement behavior.
