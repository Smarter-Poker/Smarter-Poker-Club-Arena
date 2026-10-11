# Tournament tabs scroll from the center

Inner tournament lists used scroll containment even when their rows fit entirely. Wheel or touch gestures over the list stopped there, while the shared panel scrolled normally from its side gutters.

The tournament shell now lets inner lists pass vertical scrolling to the panel. The panel still contains scrolling at the lobby boundary, preserving in-game modal isolation. Nested list scrolling and horizontal behavior remain available.

Regression coverage extends the existing scrolling law and the existing CSS Beat browser suite. The browser case checks all seven tab structures at 375px and 1518px, center/side upward and downward gestures, and a stationary footer.

Client-only change using the current static publisher; no engine or database change.
