# Jackpot Banner Close Controls

The BBJ and Mini BBJ close buttons now use their own CSS class. The celebration dismiss button previously shared that class and its later stylesheet made both banner X controls wide pills that covered the amounts. Celebration controls retain their existing styles.

Regression coverage checks both rendered banner controls against the actual celebration stylesheet. The combined styles reproduce the old 58px padded buttons; the correction restores transparent 24px controls. Both banners remain beneath the hamburger menu and dismiss independently.
