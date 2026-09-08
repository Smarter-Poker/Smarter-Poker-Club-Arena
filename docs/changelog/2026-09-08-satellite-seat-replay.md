# Satellite seat replay ordering: installed after explicit approval

Live baseline MD5: 05f0d7860aefe8b065ee9289e1f5d7c7. The existing function checks target admission before checking an existing seat. Closed/full/finalized targets can therefore return a refusal for a seat already awarded by this satellite, triggering cash fallback.

The candidate recognizes existing seat identity under the existing target lock before admission checks for new seats. Its existing duplicate-insert race handler is retained. Twelve of nineteen isolated actual-function replay cases fail on the installed version; all nineteen pass on the candidate. Same-satellite, other-satellite, historical unknown and direct-cash seats are distinguished. New entries still receive closed/full/finalized refusals.

Automatic approval review initially blocked installation. The user explicitly approved this exact correction. Migration 20260908020736 is now installed; its definition MD5 is ecb6fd235531d4790dff900e2e3b6caf. All nineteen installed-function cases passed and self-aborted. Anonymous and authenticated execution remain disabled. No historical wallet or award was manually modified. Atomic seat funding and complete satellite recovery remain separate open audit work.
