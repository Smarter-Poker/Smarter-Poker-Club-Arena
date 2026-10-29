Satellite discovery now distinguishes an actual empty array from an unreadable response. The shared loader previously converted a null satellite list to no events and null membership to not registered. List failure now uses the existing retry state; membership failure keeps the existing unknown state and card lookup fallback. Both detail surfaces use this loader. No layout, purchase authority or event contract changes.

Two actual hook regressions fail before this correction. Validation includes explicit retry and a genuine empty membership answer.
