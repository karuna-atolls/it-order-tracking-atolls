import { GoogleGenAI, Type } from '@google/genai';
import { config } from '../config';
import { env } from '../env';
import { CATEGORIES, EMAIL_TYPES, type Category, type EmailMessage, type EmailType, type ExtractedEmail } from '../types';

let ai: GoogleGenAI | null = null;
const client = () => (ai ??= new GoogleGenAI({ apiKey: env('GEMINI_API_KEY') }));

const str = { type: Type.STRING, nullable: true };

const emailSchema = {
  type: Type.OBJECT,
  properties: {
    type: { type: Type.STRING, enum: [...EMAIL_TYPES] },
    jira_key: str,
    order_number: str,
    order_date: str,
    recipient_name: str,
    delivery_address: {
      type: Type.OBJECT, nullable: true,
      properties: { name: str, street: str, postal_code: str, city: str, country: str },
    },
    billing_company: str,
    billing_country: str,
    delivery_number: str,
    carrier: str,
    parcel_number: str,
    tracking_url: str,
    shipped_date: str,
    delivered_at: str,
    received_by: str,
    items: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          name: { type: Type.STRING },
          manufacturer: str,
          article_number: str,
          manufacturer_part_number: str,
          quantity: { type: Type.INTEGER },
          category: { type: Type.STRING, enum: [...CATEGORIES] },
          new_delivery_date: str,
          delivery_note: str,
        },
        required: ['name', 'quantity', 'category'],
      },
    },
  },
  required: ['type', 'items'],
};

/** The extraction instructions — tune these if a supplier's emails are misread. */
export const emailInstructions = (supplier: string) => `You read order emails from ${supplier}, a supplier of IT hardware.
The email can be in any European language (German, French, Spanish, Dutch, Italian, Polish, English, ...).
Return only JSON that matches the schema. Use null when something is not in the email. Never guess.

type — pick exactly one:
- order_confirmed: the order was received / confirmed (e.g. "Bestelleingangsbestätigung", "Auftragsbestätigung", "confirmation de commande")
- shipped: goods are on their way, a parcel was dispatched (e.g. "Die Ware ist unterwegs", "Versandbestätigung", "expédié", "enviado")
- delayed: a delivery date changed or an item is on backorder (e.g. "Lieferterminupdate", "Lieferterminänderung", "retard")
- delivered: goods were delivered (e.g. "Ihre Ware wurde zugestellt", "livré", "entregado")
- cancelled: the order or items were cancelled
- payment_issue: payment was declined or failed
- other: anything else (invoice, newsletter, return, ...)

Fields:
- jira_key: our ticket number, format ${config.jira.projectKey}-<digits> (e.g. ${config.jira.projectKey}-73844). It is in the customer reference
  ("Ihre Referenz", "Your reference", "Votre référence", "Su referencia", "Uw referentie") and often in the subject.
- recipient_name: the person's name written after the ticket number in the reference, if any.
- order_number: the supplier's order number ("Bestellnummer"). order_date: YYYY-MM-DD.
- delivery_address: the delivery address ("Lieferadresse"), not the billing address. country in English.
- billing_company: company in the billing address ("Rechnungsadresse"). billing_country in English.
- delivery_number: the supplier's delivery / shipment number if shown (e.g. 969-41968474).
- carrier: UPS, GLS, DHL, DPD, ... parcel_number: the parcel / tracking number ("Paketnummer").
- tracking_url: the carrier tracking link for this parcel if the email has one (links are shown in [square brackets]).
- shipped_date: YYYY-MM-DD. delivered_at: date and time of delivery as YYYY-MM-DD HH:mm. received_by: who took the parcel.
- items: ONLY the products this email is about (for shipped / delayed / delivered: the products in that parcel or update;
  for order_confirmed: every product ordered). For each one:
  name = product name as written (without marketing text); manufacturer = brand (Dell, Apple, Hama, CHERRY, ...);
  article_number = the supplier's article number ("Artikel-Nr."); manufacturer_part_number ("Hersteller-Nr.");
  quantity ("Menge"); new_delivery_date (YYYY-MM-DD) or delivery_note (e.g. "longer delivery time") for delayed items;
  category — one of: laptop (notebooks, MacBooks), monitor, mobile_phone, tablet, mouse, keyboard,
  docking_station (docks and USB hubs), headphone (headsets, earbuds), accessory (stands, bags, chargers, webcams, adapters
  and other physical accessories), other (services, warranties, software, shipping costs).`;

const keyRe = () => new RegExp(`\\b${config.jira.projectKey}-\\d+\\b`);

/** Find our ticket key: Gemini's answer first, then a search over subject + body. */
export function findJiraKey(modelKey: unknown, email: Pick<EmailMessage, 'subject' | 'body'>): string | null {
  const m = String(modelKey || '').toUpperCase().match(keyRe()) || `${email.subject}\n${email.body}`.match(keyRe());
  return m ? m[0] : null;
}

const s = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);

export async function extractEmail(email: EmailMessage, supplier: string): Promise<ExtractedEmail> {
  const res = await client().models.generateContent({
    model: config.gemini.model,
    contents: `${emailInstructions(supplier)}\n\nSubject: ${email.subject}\nFrom: ${email.from}\n\n${email.body}`,
    config: { temperature: 0, responseMimeType: 'application/json', responseSchema: emailSchema },
  });
  let x: any;
  try {
    x = JSON.parse(res.text || '');
  } catch {
    throw new Error('Gemini returned no usable JSON');
  }
  const a = x.delivery_address;
  return {
    type: (EMAIL_TYPES as readonly string[]).includes(x.type) ? (x.type as EmailType) : 'other',
    jiraKey: findJiraKey(x.jira_key, email),
    orderNumber: s(x.order_number),
    orderDate: s(x.order_date),
    recipientName: s(x.recipient_name),
    deliveryAddress: a ? { name: s(a.name), street: s(a.street), postalCode: s(a.postal_code), city: s(a.city), country: s(a.country) } : null,
    billingCompany: s(x.billing_company),
    billingCountry: s(x.billing_country),
    deliveryNumber: s(x.delivery_number),
    carrier: s(x.carrier),
    parcelNumber: s(x.parcel_number),
    trackingUrl: s(x.tracking_url),
    shippedDate: s(x.shipped_date),
    deliveredAt: s(x.delivered_at),
    receivedBy: s(x.received_by),
    items: (Array.isArray(x.items) ? x.items : []).filter((i: any) => s(i?.name)).map((i: any) => ({
      name: s(i.name)!,
      manufacturer: s(i.manufacturer),
      articleNumber: s(i.article_number),
      manufacturerPartNumber: s(i.manufacturer_part_number),
      quantity: Math.max(1, Number(i.quantity) || 1),
      category: (CATEGORIES as readonly string[]).includes(i.category) ? (i.category as Category) : 'accessory',
      newDeliveryDate: s(i.new_delivery_date),
      deliveryNote: s(i.delivery_note),
    })),
  };
}

const serialSchema = {
  type: Type.OBJECT,
  properties: {
    serials: {
      type: Type.ARRAY,
      items: { type: Type.OBJECT, properties: { serial: { type: Type.STRING }, device: str }, required: ['serial'] },
    },
  },
  required: ['serials'],
};

/** Read device serial numbers from a ticket comment and/or photos of a device label. */
export async function readSerials(text: string, images: { mimeType: string; data: string }[], devices: string[]): Promise<{ serial: string; device: string | null }[]> {
  const prompt = `A user was asked for the serial number of these devices: ${devices.join('; ')}.
Below is their ticket comment and/or photos of the device label or box.
Return the serial numbers you can clearly read (labels such as "S/N", "Serial No.", "Seriennummer", "Service Tag", "IMEI").
Do not return model numbers, part numbers, EAN/barcodes, MAC addresses or order numbers. Do not guess unreadable characters.
"device" = which of the listed devices the serial belongs to, if that is clear, otherwise null.
Return {"serials": []} when there is none.${text ? `\n\nComment:\n${text.slice(0, 4000)}` : ''}`;
  const res = await client().models.generateContent({
    model: config.gemini.model,
    contents: [{ role: 'user', parts: [{ text: prompt }, ...images.map((i) => ({ inlineData: i }))] }],
    config: { temperature: 0, responseMimeType: 'application/json', responseSchema: serialSchema },
  });
  try {
    const x = JSON.parse(res.text || '');
    return (x.serials || [])
      .map((r: any) => ({ serial: String(r.serial || '').trim().toUpperCase(), device: s(r.device) }))
      .filter((r: { serial: string }) => /^[A-Z0-9-]{5,30}$/.test(r.serial));
  } catch {
    return [];
  }
}
