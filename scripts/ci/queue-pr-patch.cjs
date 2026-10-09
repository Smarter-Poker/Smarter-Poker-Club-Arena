const fs = require('fs');
const file = '.github/scripts/queue-pr.sh';
let content = fs.readFileSync(file, 'utf8');

const patch = `
PATCH_FILE=$(mktemp)
gh pr diff "$PR" --repo "$REPO" > "$PATCH_FILE"

if grep -q "^+++ b/src/lib/push/push-gate.js" "$PATCH_FILE" || \\
   grep -q "^+++ b/scripts/ci/approved-senders.txt" "$PATCH_FILE" || \\
   grep -q "^+++ b/scripts/ci/law-test-no-operational-pushes.mjs" "$PATCH_FILE" || \\
   grep -q "^+++ b/src/lib/push/web-push.js" "$PATCH_FILE" || \\
   grep -q "^+++ b/src/lib/push/fcm.js" "$PATCH_FILE" || \\
   grep -q "^+++ b/pages/api/sms/send-otp.js" "$PATCH_FILE" || \\
   grep -q "^+++ b/src/lib/mfaSmsCode.js" "$PATCH_FILE" || \\
   grep -q "^+++ b/vendor/commander-shared/src/lib/commander/twilio.js" "$PATCH_FILE" || \\
   grep -qE "^\\+.*(fn_raise_notification|INSERT INTO public\\.notifications|INSERT INTO public\\.push_outbox|net\\.http_post|sendNotification|twilio.*messages\\.create|firebase-admin.*messaging|expo-server-sdk|INSERT INTO public\\.ca_incident_recipients)" "$PATCH_FILE"; then
   
   echo "Routing/alerting change detected. Holding for manual review."
   gh pr comment "$PR" --repo "$REPO" --body "⚠️ Auto-merge has been skipped. This PR modifies routing guards, senders, or introduces new alert-to-notification/push code. Manual owner review is required."
   rm "$PATCH_FILE"
   exit 0
fi
rm "$PATCH_FILE"

`;

content = content.replace('echo "Queueing #$PR for protected squash auto-merge."', patch + 'echo "Queueing #$PR for protected squash auto-merge."');
fs.writeFileSync(file, content);
