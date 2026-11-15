# IT Order Notifier

A web app for Google AI Studio (Build mode) that follows IT hardware orders from the supplier's emails to the asset record. The **Jira ticket** (e.g. `IS-73844`) is the shared reference; the person to notify is always the ticket's **reporter**.

## What it does
1. **Reads supplier emails** from your mailbox, but only from allow-listed senders (Bechtle: `vertrieb.rheinland@bechtle.com`). Read-only: nothing in the mailbox is changed.
2. **Gemini reads each email in any European language**: email type (order confirmed / shipped / delayed / delivered / cancelled / payment problem), ticket number, order number, devices, parcel number, carrier, tracking link, delivery address, billing company. Each item gets its own status, because one order arrives as several parcels.
3. **Jira:** reads the reporter (name, email) and "To which Office should the items be delivered?". A filled office means an office delivery, an empty one means a home delivery. Each update is added as a comment.
4. **Master channel `#it-hardware-orders`:** one message per order, always showing the current status of every item, plus one thread reply per email.
   - No ticket number in the email → message with **Link ticket**, and you are tagged.
   - Reporter not found in Slack → **Set user** button.
5. **Requester DM:** by default one summary a day (`notifications.userDmMode: 'digest'`), or one per parcel (`'perParcel'`).
6. **Office delivery:** the office channel (`#munich-it`, `#madrid-it`, ...) is told when a parcel arrives. For home deliveries, only the user is told.
7. **When everything is delivered:** the user is asked for the serial number of each laptop, Mac, monitor, phone or tablet, via a Slack form or as a ticket comment or photo. Gemini reads it from the comment or photo, and the user confirms it in Slack. Orders with no such devices just get a **Confirm receipt** button.
8. **Reminder every 2 days** until the user confirms. After 10 days you are tagged.
9. **Closing:** the app creates one object per device in **IT Employee Assets**, typed by device (Laptops, Monitors, Mouse, Docking Station (USB HUB), HeadPhone, Accessories...). It then closes the ticket and posts "closed successfully" in the master channel. If anything fails, you are tagged in Slack and on the ticket (internal comment), and the ticket stays open.
10. **Cancellation or payment problem:** the master channel only, with you tagged. The user is not told.

**Review mode (the default).** Nothing goes to requesters or office channels on its own. Every message they would get is posted as a preview in the order's thread in #it-hardware-orders, with **Send** and **Skip** buttons.
- **Who can press Send:** only you, or anyone listed in `config.admin.approvers`.
- **Jira comments:** order-update comments are internal in this mode, so Jira doesn't email the requester either.
- **Newer previews:** a newer update replaces an older preview that's still waiting, and carries all its lines.
- **Reminders:** they start only after you've sent the "everything delivered" message.
- **Going live:** once you trust the automation, press **Turn on automatic sending** on the dashboard. You can switch back at any time.

Code layout and customising: see `AGENTS.md`.

---

## Setup

### 1. AI Studio
Push this folder to a private GitHub repo. In AI Studio → **Build**, use **+ → Import from GitHub**. First prompt: *"Read AGENTS.md and README.md. Don't change anything yet; list what I still need to configure."*

### 2. Google: service account (Gmail + Firestore)
1. Use the Cloud project that AI Studio deploys to. Enable the **Gmail API** and **Firestore**, and create a Firestore database (Native mode, default database).
2. Create a service account and give it the **Cloud Datastore User** role. Then create a JSON key and paste the whole file into the secret `GOOGLE_SERVICE_ACCOUNT_JSON`.
3. Go to admin.google.com → Security → API controls → **Domain-wide delegation** → Add. Enter the service account's Client ID with this scope only: `https://www.googleapis.com/auth/gmail.readonly`.
4. Set `GMAIL_MAILBOX` to the **primary address** of the mailbox the Bechtle emails arrive in.

### 3. Slack app
1. Go to api.slack.com/apps → **Create New App → From a manifest** and paste `slack-app-manifest.yaml`. You'll set the interactivity URL after deploying (step 7).
2. Install the app. Put the **Bot token** (`xoxb-…`) into `SLACK_BOT_TOKEN` and the **Signing secret** (Basic Information) into `SLACK_SIGNING_SECRET`.
3. Invite the bot (`/invite @IT Orders`) to `#it-hardware-orders` and to every office channel: `london-it`, `warsaw-it`, `madrid-it`, `munich-it`, `berlin-it`, `amsterdam-it`, `paris-it`. Private channels can't be found until the bot is a member.

### 4. Jira
- Use a dedicated API user and token for `JIRA_EMAIL` / `JIRA_API_TOKEN`. It needs to browse, comment on and transition tickets in `IS`, and create objects in the IT Employee Assets schema.
- `jira.baseUrl` is already set to `https://atolls.atlassian.net`.
- Set `jira.fields.deliveryOffice` to the ID of the field behind "To which Office should the items be delivered?". It looks like `customfield_12345`. To find it, while signed in to Jira, open
  `https://atolls.atlassian.net/rest/api/2/issue/IS-XXXXX?expand=names` for a ticket where an **office** was chosen. Search the page (Ctrl+F) for "Office", and you'll see a pair like `"customfield_12345": "Delivery Office"`. Then search for that `customfield_…` to check that its value is the office (e.g. "Munich"). Ignore the reporter's own Office in the "(ALL) Atolls Employee" panel; that's a different field.
  Once the app is deployed, the dashboard's **Setup check → Find Jira field ID** searches by name too.
- Check that `jira.closeStatuses` contains the status your workflow closes to (default: Resolved / Done / Closed).

### 5. Assets
Nothing to look up: the app finds the schema, object types, attributes and statuses by name. On the dashboard, open **Setup check → How Assets objects will be filled**. It shows, for every object type, which attribute gets which value. Then check two things:
- `assets.statusOnCreate` must be a status that exists in the schema (default `In Use`).
- No line may say `MANDATORY BUT NOT MAPPED`. If one does, add that attribute's name to `assets.attributeNames`.

How values are filled:
- **Owner:** the employee object found by the reporter's email.
- **Office, Legal Entity, Department, Country:** copied from that employee object. If that fails, the delivery office and billing company are used.
- **Other fields:** serial number, manufacturer, model, status, purchase date (the order date), and notes (order and ticket number).
- **Mandatory text fields with no mapping,** such as "Growrk Title": filled with the device model.

### 6. Other secrets
`ADMIN_PASSWORD` (dashboard), `CRON_SECRET` and `JIRA_WEBHOOK_TOKEN`. Generate long random strings with `openssl rand -hex 24`.

### 7. Deploy, then wire up
1. AI Studio → **Publish → Cloud Run**. Check that all 10 secrets are on the Cloud Run service.
2. In the Slack app → **Interactivity**, set the request URL to `https://YOUR-APP-URL/api/slack/interactions`.
3. In Jira → Settings → System → **WebHooks** → Create:
   - URL: `https://YOUR-APP-URL/api/webhooks/jira?token=<JIRA_WEBHOOK_TOKEN>`
   - JQL: `project = IS`
   - Events: **Issue updated** and **Comment created**
4. Create the three Cloud Scheduler jobs:
```bash
APP=https://YOUR-APP-URL; S=<CRON_SECRET>; L=europe-west1; TZ=Europe/Paris
gcloud scheduler jobs create http it-orders-poll --location=$L --schedule="*/10 * * * *" --time-zone=$TZ \
  --uri="$APP/api/cron/poll" --http-method=POST --headers="x-cron-secret=$S"
gcloud scheduler jobs create http it-orders-digest --location=$L --schedule="0 16 * * 1-5" --time-zone=$TZ \
  --uri="$APP/api/cron/digest" --http-method=POST --headers="x-cron-secret=$S"
gcloud scheduler jobs create http it-orders-reminders --location=$L --schedule="30 9 * * 1-5" --time-zone=$TZ \
  --uri="$APP/api/cron/reminders" --http-method=POST --headers="x-cron-secret=$S"
```
   - The digest runs at 16:00 on weekdays. To get more than one summary a day, add more times to its schedule.
   - The reminders job checks daily and sends a reminder once 2 days have passed.

### 8. Test
1. **Test an email:** paste a real Bechtle email to see what is read and which ticket, reporter and delivery type are found. Nothing is written.
2. **Real run:** raise a test ticket yourself (so you are the reporter) and put its key in a Bechtle order reference. Then use **Check emails now** and **Send user updates now** to step through without waiting for the schedule.

## Good to know
- **Without `GOOGLE_SERVICE_ACCOUNT_JSON`:** the app keeps state in memory. That's fine for trying the preview, but it's lost on every restart.
- **Ticket closed by hand:** reminders stop, and assets are created for every device that already has a serial number. You're tagged about any that don't.
- **Reporter not found in Slack:** the app also tries the same name at `atolls.com` and `joingsg.com` (`slack.emailDomains`). If that fails, use **Set user** in the master channel.
- **Failed emails:** an email that fails 3 times is reported in the master channel with you tagged.
- **Adding Amazon / Apple Business later:** add an entry to `config.sources` with their sender addresses, then test their emails with **Test an email**. If their wording differs, adjust the instructions in `server/lib/gemini.ts`.
#   i t - o r d e r - t r a c k i n g - a t o l l s  
 #   i t - o r d e r - t r a c k i n g - a t o l l s  
 