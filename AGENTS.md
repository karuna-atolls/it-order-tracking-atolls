# Guide for the coding agent (Google AI Studio)

This app tracks IT hardware orders from supplier emails to Jira Assets. Read README.md for the behaviour, and this file before changing code.

## Flow
1. `POST /api/cron/poll` (Cloud Scheduler) → `jobs/processEmails.ts` `pollEmails()`: reads Gmail (read-only, only allow-listed senders), extracts with Gemini (`lib/gemini.ts`), finds or creates the order, then `applyAndNotify()`: Jira comment, master-channel message + thread, office channel, queued requester update.
2. Emails without a usable ticket number are parked (`pending` collection) and posted with a "Link ticket" button.
3. `POST /api/cron/digest` → `jobs/reminders.ts` `sendDigests()`: one DM per requester with the queued updates; once everything is delivered, the DM asks for serial numbers or receipt.
4. `POST /api/cron/reminders` → `sendReminders()`: reminder every `reminders.everyDays`; admin tagged after `escalateAfterDays`.
5. `POST /api/slack/interactions` → `jobs/slackInteractions.ts`: Link ticket, Set user, Enter serial numbers, Confirm receipt. Slack needs an answer within 3 s: do slow work in `after`.
6. `POST /api/webhooks/jira` → `jobs/jiraWebhook.ts`: serial numbers from requester comments or photos (confirmed by the user in Slack); a ticket closed by hand finishes the order.
7. `jobs/finalize.ts`: create Assets objects (`jobs/createAssets.ts`), comment, close the ticket, report in the master channel. Each step is recorded in `order.finalize`, so retries never repeat work.

## Where to change things
| Change | File |
|---|---|
| Jira site/project/fields, suppliers and allowed senders, office → Slack channel, DM mode, reminder timing, carriers, Assets schema/categories/attribute names | `server/config.ts` |
| Any text sent to Slack or Jira, Slack forms | `server/messages.ts` |
| How emails and serial-number photos are read (prompts + schemas) | `server/lib/gemini.ts` |
| How an email changes the order (pure logic, no I/O) | `server/jobs/orders.ts` |
| How each Assets attribute is filled | `server/jobs/createAssets.ts` |
| Secrets | `server/env.ts` (`SECRET_NAMES`) |
| Dashboard | `src/components/*.tsx` |

## Review mode
`server/settings.ts` holds the dashboard switch `autoSend` (default `config.notifications.autoSendDefault = false`).
Every message to a requester or office channel goes through `sendOrDraft()` / `flushUser()` / `officeNotice()` in `jobs/notify.ts`. In review mode these create a `Draft` in `order.outbox` and a preview with Send / Skip buttons in the master thread. **Never post to a requester or office channel any other way.**

## Rules
- All external calls stay server-side; the browser only calls `/api/*`.
- Never widen Gmail beyond read-only, and never read emails from senders outside `config.sources[].allowedSenders`. The exact check on the sender address in `pollEmails()` must stay.
- The requester is the Jira reporter. Never notify the requester about cancellations or payment problems unless `notifyUserOnCancel` is true.
- Never close a ticket while asset records are missing, unless a person already closed it (`finalize.closedExternally`).
- Serial numbers read by Gemini are suggestions; only values the user submits in the Slack form are stored as serials.
- Order state lives in `server/store.ts` (Firestore via REST, or memory). Load, change and save an order inside `withLock(order.id, ...)`.
- Keep idempotency: the email ledger (`meta/emails`), `pendingUserEvents`, and the `finalize` flags.
- `/api/cron/*` stays behind `requireCronOrAdmin`, `/api/webhooks/jira` behind `requireWebhookToken`, and `/api/slack/interactions` behind the Slack signature check.
- Run `npm run typecheck` and `npm run build` after changes.

## Example requests
- "Add Apple Business: sender noreply@email.apple.com" → `config.sources`; notifyUserOnCancel stays false.
- "Send the user a DM for every parcel" → `config.notifications.userDmMode = 'perParcel'`.
- "Remind every 3 days" → `config.reminders.everyDays`.
- "Also ask serials for docking stations" → `config.assets.categories.docking_station.needsSerial = true`.
- "Write the Slack messages in French" → `server/messages.ts`.
