# tests/global-css-does-not-leak-across-pages.law.test.ts

A plain .css file is global once imported, so two files defining the same class bare are one rule decided by chunk load order: `.action-btn` may never be defined bare, only PlayerAvatar.css may define `.player-avatar` bare, and the count of classes carrying a leakable property across files is a ratchet at 243.
