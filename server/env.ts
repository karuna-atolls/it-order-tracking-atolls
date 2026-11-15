/**
 * Secrets, read from environment variables.
 * In AI Studio: Settings -> Secrets. On Cloud Run: service environment variables / Secret Manager.
 */
export const SECRET_NAMES = [
  'GEMINI_API_KEY',               // set automatically by AI Studio
  'JIRA_EMAIL',                   // Jira API user email
  'JIRA_API_TOKEN',               // Jira API token (also used for Assets)
  'SLACK_BOT_TOKEN',              // xoxb-...
  'SLACK_SIGNING_SECRET',         // verifies button clicks and forms coming from Slack
  'GOOGLE_SERVICE_ACCOUNT_JSON',  // service account key JSON (Gmail read access + Firestore)
  'GMAIL_MAILBOX',                // mailbox that receives the supplier emails (its primary address)
  'ADMIN_PASSWORD',               // password for the dashboard
  'CRON_SECRET',                  // shared secret for Cloud Scheduler calls
  'JIRA_WEBHOOK_TOKEN',           // token in the Jira webhook URL
] as const;
export type SecretName = (typeof SECRET_NAMES)[number];

export function env(name: SecretName): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing secret ${name} — add it in Settings -> Secrets`);
  return v;
}

export const hasEnv = (name: SecretName) => !!process.env[name];
