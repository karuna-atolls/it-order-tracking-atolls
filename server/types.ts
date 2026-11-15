export const EMAIL_TYPES = ['order_confirmed', 'shipped', 'delayed', 'delivered', 'cancelled', 'payment_issue', 'other'] as const;
export type EmailType = (typeof EMAIL_TYPES)[number];

export const CATEGORIES = [
  'laptop', 'monitor', 'mobile_phone', 'tablet', 'mouse', 'keyboard', 'docking_station', 'headphone', 'accessory', 'other',
] as const;
export type Category = (typeof CATEGORIES)[number];

export type ItemStatus = 'Ordered' | 'Shipped' | 'Delayed' | 'Delivered' | 'Cancelled';
export type OrderStatus = 'Ordered' | 'Partially shipped' | 'Shipped' | 'Partially delivered' | 'Delivered' | 'Cancelled';

export interface Source {
  name: string;
  allowedSenders: string[];
  notifyUserOnCancel: boolean;
}

export interface EmailMessage {
  id: string;
  subject: string;
  from: string;
  fromAddress: string;
  receivedAt: string; // ISO
  body: string;
}

export interface Address {
  name: string | null;
  street: string | null;
  postalCode: string | null;
  city: string | null;
  country: string | null;
}

/** One product line as read from a supplier email. */
export interface ExtractedItem {
  name: string;
  manufacturer: string | null;
  articleNumber: string | null;
  manufacturerPartNumber: string | null;
  quantity: number;
  category: Category;
  newDeliveryDate: string | null; // delayed emails
  deliveryNote: string | null;    // e.g. "longer delivery time"
}

/** Everything Gemini reads from one supplier email. */
export interface ExtractedEmail {
  type: EmailType;
  jiraKey: string | null;
  orderNumber: string | null;
  orderDate: string | null;       // YYYY-MM-DD
  recipientName: string | null;
  deliveryAddress: Address | null;
  billingCompany: string | null;
  billingCountry: string | null;  // English name
  deliveryNumber: string | null;
  carrier: string | null;
  parcelNumber: string | null;
  trackingUrl: string | null;
  shippedDate: string | null;     // YYYY-MM-DD
  deliveredAt: string | null;     // ISO or YYYY-MM-DD HH:mm
  receivedBy: string | null;
  items: ExtractedItem[];         // only the items this email is about
}

export interface ItemState {
  id: string;
  name: string;
  manufacturer: string | null;
  articleNumber: string | null;
  partNumber: string | null;
  quantity: number;
  category: Category;
  status: ItemStatus;
  expected: string | null;
  carrier: string | null;
  parcelNumber: string | null;
  trackingUrl: string | null;
  shippedAt: string | null;
  deliveredAt: string | null;
  receivedBy: string | null;
  serials: string[];    // one per unit, entered by the requester
  assetKeys: string[];  // one per unit, once created in Assets
}

/** A message for the requester or an office channel, waiting for approval in review mode. */
export interface Draft {
  id: string;
  kind: 'update' | 'reminder' | 'office' | 'serials';
  target: 'user' | 'office';
  channel: string | null;          // office channel for target 'office'
  events: { key: string; line: string }[]; // 'update' drafts: the queued lines it carries
  receipt: boolean;                // carries the "please confirm / enter serial numbers" request
  text: string;
  blocks: unknown[];
  status: 'waiting' | 'sent' | 'skipped' | 'replaced';
  previewTs: string | null;        // the preview message in the master channel thread
  createdAt: string;
}

export interface OrderState {
  id: string;
  source: string;
  orderNumber: string | null;
  orderDate: string | null;
  jiraKey: string;
  summary: string;
  requester: { name: string | null; email: string | null; accountId: string | null; slackUserId: string | null };
  delivery: { type: 'office' | 'home'; office: string | null; address: string | null; country: string | null };
  billingCompany: string | null;
  billingCountry: string | null;
  items: ItemState[];
  status: OrderStatus;
  confirmationSeen: boolean;
  slack: { masterTs: string | null };
  /** Lines waiting to go to the requester in the next DM (only the latest line per item is kept). */
  pendingUserEvents: { key: string; line: string }[];
  deliveredAt: string | null;          // when the whole order became delivered
  deliveredNotifiedAt: string | null;  // when the requester was asked to confirm / enter serials
  lastReminderAt: string | null;
  escalatedAt: string | null;
  serialCandidates: { serial: string; device: string | null }[]; // read from Jira comments / photos
  receiptConfirmedAt: string | null;
  finalize: {
    requested: boolean;
    attempts: number;
    lastError: string | null;
    commented: boolean;
    closing: boolean;          // set just before this app closes the ticket
    ticketClosed: boolean;
    closedExternally: boolean; // a person closed the ticket in Jira
  };
  outbox: Draft[];
  problems: string[];
  open: boolean;
  closedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/** A supplier email that could not be tied to a Jira ticket yet. */
export interface PendingEmail {
  id: string;
  source: string;
  subject: string;
  receivedAt: string;
  reason: string;
  extracted: ExtractedEmail;
  jiraKey: string | null; // set from Slack with "Link ticket"
  ready: boolean;
  slackTs: string | null;
}

export interface JiraIssue {
  key: string;
  fields: Record<string, any>;
}
