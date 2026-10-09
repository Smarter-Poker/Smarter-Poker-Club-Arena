import fs from 'node:fs';
import { execSync } from 'node:child_process';

let exitCode = 0;
const error = (msg) => { console.error(`::error::${msg}`); exitCode = 1; };

console.log('Verifying no operational pages to the owner...');

const grepSenders = `git grep -lE 'sendNotification|twilio.*messages\\.create|firebase-admin.*messaging|expo-server-sdk' || true`;
const senders = execSync(grepSenders, { encoding: 'utf8' }).trim().split('\n').filter(Boolean);

let allowedSenders = [];
try {
  allowedSenders = fs.readFileSync('scripts/ci/approved-senders.txt', 'utf8').split('\n').map(s=>s.trim()).filter(Boolean);
} catch (e) {
  error('Missing scripts/ci/approved-senders.txt');
}

for (const file of senders) {
  if (!allowedSenders.includes(file) && !file.includes('.test.') && !file.includes('BUILD_PLAN') && !file.includes('.md')) {
    error(`Unauthorized sender found in ${file}. Add to scripts/ci/approved-senders.txt if legitimate.`);
  }
}

const grepTriggers = `git grep -lE 'fn_raise_notification|INSERT INTO public.notifications|INSERT INTO public.push_outbox|net.http_post' || true`;
const triggers = execSync(grepTriggers, { encoding: 'utf8' }).trim().split('\n').filter(Boolean);
for (const file of triggers) {
  if (file.includes('supabase/migrations') && !file.match(/20260916|20261009/)) {
     const contents = fs.readFileSync(file, 'utf8');
     if (contents.match(/AFTER INSERT ON (public\.operational_alert_events|public\.financial_alerts|public\.engine_alerts|public\.ca_drift_incidents|public\.operational_notification_destinations)/) && contents.match(/(fn_raise_notification|INSERT INTO (public\.)?(notifications|push_outbox))/)) {
         error(`Trigger turning alert into notification/push found in ${file}.`);
     }
  }
}

// Check if anyone adds a new ca_incident_recipients
const grepRecipients = `git grep -lE 'ca_incident_recipients' || true`;
const recipients = execSync(grepRecipients, { encoding: 'utf8' }).trim().split('\n').filter(Boolean);
for (const file of recipients) {
  if (file.includes('supabase/migrations') && !file.match(/20260916|20261009/)) {
     const contents = fs.readFileSync(file, 'utf8');
     if (contents.match(/INSERT INTO public.ca_incident_recipients/) || contents.match(/SELECT .* FROM .*ca_incident_recipients/)) {
         if (!file.includes('a_real_alert_reaches_the_owner')) {
             error(`Pages ca_incident_recipients in ${file}.`);
         }
     }
  }
}

process.exit(exitCode);
