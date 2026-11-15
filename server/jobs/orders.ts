/** Pure order logic: how a supplier email changes the stored order. No network calls here. */
import { config } from '../config';
import type { ExtractedEmail, ExtractedItem, ItemState, OrderState, OrderStatus } from '../types';

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

export const itemId = (x: { articleNumber: string | null; name: string }) =>
  (x.articleNumber || x.name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'item';

function newItem(x: ExtractedItem): ItemState {
  return {
    id: itemId(x), name: x.name, manufacturer: x.manufacturer, articleNumber: x.articleNumber,
    partNumber: x.manufacturerPartNumber, quantity: x.quantity, category: x.category, status: 'Ordered',
    expected: null, carrier: null, parcelNumber: null, trackingUrl: null, shippedAt: null,
    deliveredAt: null, receivedBy: null, serials: [], assetKeys: [],
  };
}

export function deriveStatus(items: ItemState[]): OrderStatus {
  const active = items.filter((i) => i.status !== 'Cancelled');
  if (!active.length) return items.length ? 'Cancelled' : 'Ordered';
  const delivered = active.filter((i) => i.status === 'Delivered').length;
  const moving = active.filter((i) => i.status === 'Shipped' || i.status === 'Delivered').length;
  if (delivered === active.length) return 'Delivered';
  if (delivered > 0) return 'Partially delivered';
  if (moving === active.length) return 'Shipped';
  if (moving > 0) return 'Partially shipped';
  return 'Ordered';
}

/** Tracking link from the email, or built from carrier + parcel number. */
export function trackingLink(e: Pick<ExtractedEmail, 'trackingUrl' | 'carrier' | 'parcelNumber'>): string | null {
  if (e.trackingUrl && /^https?:\/\//.test(e.trackingUrl)) return e.trackingUrl;
  const template = e.carrier && Object.entries(config.carriers).find(([name]) => e.carrier!.toUpperCase().includes(name))?.[1];
  return template && e.parcelNumber ? template.replace('{n}', encodeURIComponent(e.parcelNumber)) : null;
}

export interface Change {
  touched: ItemState[];
  becameDelivered: boolean;
}

/** Apply one supplier email to the order. Statuses only move forward. */
export function applyEmail(order: OrderState, e: ExtractedEmail, receivedAt: string): Change {
  const touched: ItemState[] = [];
  for (const x of e.items) {
    let item = order.items.find((i) => i.id === itemId(x)) || order.items.find((i) => norm(i.name) === norm(x.name));
    if (!item) {
      item = newItem(x);
      order.items.push(item);
    } else {
      item.manufacturer ||= x.manufacturer;
      item.partNumber ||= x.manufacturerPartNumber;
      item.articleNumber ||= x.articleNumber;
    }
    switch (e.type) {
      case 'shipped':
        if (item.status !== 'Delivered') item.status = 'Shipped';
        item.carrier = e.carrier || item.carrier;
        item.parcelNumber = e.parcelNumber || item.parcelNumber;
        item.trackingUrl = trackingLink(e) || item.trackingUrl;
        item.shippedAt = e.shippedDate || receivedAt.slice(0, 10);
        break;
      case 'delayed':
        if (item.status === 'Ordered' || item.status === 'Delayed') item.status = 'Delayed';
        item.expected = x.newDeliveryDate || x.deliveryNote || item.expected;
        break;
      case 'delivered':
        item.status = 'Delivered';
        item.deliveredAt = e.deliveredAt || receivedAt;
        item.receivedBy = e.receivedBy || item.receivedBy;
        break;
      case 'cancelled':
        if (item.status !== 'Delivered') item.status = 'Cancelled';
        break;
      default:
        break;
    }
    touched.push(item);
  }
  if (e.type === 'cancelled' && !e.items.length) {
    for (const i of order.items) if (i.status !== 'Delivered') { i.status = 'Cancelled'; touched.push(i); }
  }
  if (e.type === 'order_confirmed') order.confirmationSeen = true;

  order.orderNumber ||= e.orderNumber;
  order.orderDate ||= e.orderDate;
  order.billingCompany ||= e.billingCompany;
  order.billingCountry ||= e.billingCountry;
  if (e.deliveryAddress) {
    const a = e.deliveryAddress;
    order.delivery.address ||= [a.name, a.street, [a.postalCode, a.city].filter(Boolean).join(' '), a.country].filter(Boolean).join(', ') || null;
    order.delivery.country ||= a.country;
  }

  const before = order.status;
  order.status = deriveStatus(order.items);
  const becameDelivered = before !== 'Delivered' && order.status === 'Delivered';
  if (becameDelivered) order.deliveredAt = receivedAt;
  return { touched, becameDelivered };
}

export const categoryOf = (item: ItemState) => config.assets.categories[item.category] || config.assets.categories.accessory;

export interface SerialUnit { itemId: string; unit: number; label: string }

/** One entry per physical device whose serial number the requester must provide. */
export function serialUnits(order: OrderState): SerialUnit[] {
  const units: SerialUnit[] = [];
  for (const item of order.items) {
    if (item.status !== 'Delivered' || !categoryOf(item).needsSerial) continue;
    for (let u = 0; u < item.quantity; u++) {
      units.push({ itemId: item.id, unit: u, label: item.quantity > 1 ? `${item.name} (${u + 1} of ${item.quantity})` : item.name });
    }
  }
  return units;
}

export const missingSerials = (order: OrderState) =>
  serialUnits(order).filter((u) => !order.items.find((i) => i.id === u.itemId)?.serials[u.unit]);

export const deliveredCount = (order: OrderState) => {
  const active = order.items.filter((i) => i.status !== 'Cancelled');
  return { delivered: active.filter((i) => i.status === 'Delivered').length, total: active.length };
};
