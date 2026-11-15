/**
 * Build and create the Assets object for one delivered device.
 * Attribute IDs, types, allowed options and statuses are read from the schema, so each object type
 * (Laptops, Monitors, Mouse, Accessories, ...) is filled according to its own form.
 */
import { config } from '../config';
import * as assets from '../lib/assets';
import type { AttributeDef } from '../lib/assets';
import type { ItemState, OrderState } from '../types';
import { categoryOf } from './orders';

interface Employee {
  objectKey: string;
  /** attribute name (lower case) -> values of that attribute on the employee object */
  values: Map<string, { text: string; objectKey?: string; typeId?: string }[]>;
}

const logicalOf = (attributeName: string) =>
  Object.entries(config.assets.attributeNames).find(([, names]) => names.some((n) => n.toLowerCase() === attributeName.toLowerCase()))?.[0] || null;

/** The requester's own object in Assets (the type the "Owner" attribute points to), found by email, then by name. */
async function findEmployee(order: OrderState, ownerAttr: AttributeDef | undefined): Promise<Employee | null> {
  if (!ownerAttr || !assets.isReference(ownerAttr)) return null;
  const type = assets.referenceTypeId(ownerAttr);
  const email = order.requester.email;
  const emails = email ? [email, ...config.slack.emailDomains.map((d) => `${email.split('@')[0]}@${d}`)] : [];
  const queries = [
    ...(emails.length ? [`objectTypeId = ${type} AND "Email" IN (${[...new Set(emails)].map(assets.aqlValue).join(', ')})`] : []),
    ...(order.requester.name ? [`objectTypeId = ${type} AND label = ${assets.aqlValue(order.requester.name)}`] : []),
    ...(emails.length ? [`"Email" IN (${[...new Set(emails)].map(assets.aqlValue).join(', ')})`] : []),
  ];
  for (const q of queries) {
    const res = await assets.aql(q, 2).catch(() => null);
    const obj = res?.values[0];
    if (!res || !obj) continue;
    const values: Employee['values'] = new Map();
    for (const a of obj.attributes || []) {
      const name = res.attributeNames.get(String(a.objectTypeAttributeId));
      if (!name) continue;
      values.set(name.toLowerCase(), a.objectAttributeValues.map((v) => ({
        text: v.referencedObject?.label || v.displayValue || v.value || '',
        objectKey: v.referencedObject?.objectKey,
        typeId: v.referencedObject?.objectType?.id != null ? String(v.referencedObject.objectType.id) : undefined,
      })));
    }
    return { objectKey: obj.objectKey, values };
  }
  return null;
}

const employeeCache = new Map<string, Employee | null>();

export interface AssetPlan {
  objectType: string;
  typeId: string;
  attributes: { id: string; name: string; value: string }[];
  skipped: string[]; // optional attributes that could not be filled
}

/** Work out every attribute value for one device. Throws when a mandatory attribute cannot be filled. */
export async function planAsset(order: OrderState, item: ItemState, serial: string | null): Promise<AssetPlan> {
  const objectType = categoryOf(item).objectType;
  if (!objectType) throw new Error(`No object type is configured for category "${item.category}"`);
  const typeId = await assets.objectTypeId(objectType);
  if (!typeId) throw new Error(`Object type "${objectType}" was not found in schema "${config.assets.schemaName}"`);
  const defs = (await assets.attributesOf(typeId)).filter(assets.isWritable);

  const ownerAttr = defs.find((a) => logicalOf(a.name) === 'owner');
  if (!employeeCache.has(order.id)) employeeCache.set(order.id, await findEmployee(order, ownerAttr));
  const employee = employeeCache.get(order.id) || null;
  const fromEmployee = (...names: string[]) => names.flatMap((n) => employee?.values.get(n) || []);

  const manufacturer = item.manufacturer || item.name.split(' ')[0];
  /** Candidate values per logical field, best first. */
  const candidates: Record<string, string[]> = {
    serial: serial ? [serial] : [],
    manufacturer: [manufacturer],
    model: [item.name],
    status: [config.assets.statusOnCreate],
    office: [...fromEmployee('office').map((v) => v.text), order.delivery.office || ''],
    legalEntity: [...fromEmployee('sub company', 'legal entity', 'company').map((v) => v.text), order.billingCompany || ''],
    country: [...fromEmployee('country').map((v) => v.text), order.billingCountry || '', order.delivery.country || ''],
    department: fromEmployee('department', 'departments').map((v) => v.text),
    purchaseDate: [order.orderDate || ''],
    notes: [`${order.source} order ${order.orderNumber || ''} · ticket ${order.jiraKey}`],
    owner: [order.requester.name || ''],
  };

  async function resolve(a: AttributeDef, logical: string | null): Promise<string | null> {
    if (!logical && !assets.isRequired(a)) return null; // unmapped optional attributes stay empty
    const wanted = (logical ? candidates[logical] || [] : []).filter(Boolean);
    const kind = assets.kindOf(a);
    if (kind === 'reference') {
      if (logical === 'owner') return employee?.objectKey || null;
      const refType = assets.referenceTypeId(a);
      // Best: the very object the employee record already points to (same Office / Legal Entity / Department object).
      const same = [...(employee?.values.values() || [])].flat().find((v) => v.objectKey && v.typeId === refType && (!wanted.length || wanted.some((w) => w.toLowerCase() === v.text.toLowerCase())));
      if (same?.objectKey) return same.objectKey;
      for (const w of wanted) {
        const found = (await assets.aql(`objectTypeId = ${refType} AND label = ${assets.aqlValue(w)}`, 1).catch(() => null))?.values[0];
        if (found) return found.objectKey;
      }
      return null;
    }
    if (kind === 'user') return logical === 'owner' ? order.requester.accountId : null;
    if (kind === 'status') {
      const all = await assets.statuses();
      const s = all.find((x) => wanted.some((w) => w.toLowerCase() === x.name.toLowerCase()));
      if (!s && assets.isRequired(a)) throw new Error(`Status "${config.assets.statusOnCreate}" does not exist in Assets (available: ${all.map((x) => x.name).join(', ')})`);
      return s?.id || null;
    }
    if (kind === 'select') {
      const options = (a.options || '').split(',').map((o) => o.trim()).filter(Boolean);
      return options.find((o) => wanted.some((w) => w.toLowerCase() === o.toLowerCase())) || null;
    }
    if (kind === 'date' || kind === 'datetime') return wanted.find((w) => /^\d{4}-\d{2}-\d{2}/.test(w))?.slice(0, 10) || null;
    return wanted[0] || null;
  }

  const plan: AssetPlan = { objectType, typeId, attributes: [], skipped: [] };
  for (const a of defs) {
    const logical = logicalOf(a.name);
    let value = await resolve(a, logical);
    // Mandatory or naming attribute we have no value for: use the device model (covers "Growrk Title" etc.).
    if (!value && (assets.isRequired(a) || a.label) && ['text', 'textarea'].includes(assets.kindOf(a)) && logical !== 'serial') value = item.name;
    if (value) plan.attributes.push({ id: a.id, name: a.name, value });
    else if (assets.isRequired(a)) throw new Error(`Cannot fill the mandatory attribute "${a.name}" of ${objectType}`);
    else if (logical) plan.skipped.push(a.name);
  }
  return plan;
}

export async function createAsset(order: OrderState, item: ItemState, serial: string | null): Promise<string> {
  const plan = await planAsset(order, item, serial);
  const obj = await assets.createObject(plan.typeId, plan.attributes);
  return obj.objectKey;
}

export const forgetEmployee = (orderId: string) => employeeCache.delete(orderId);

/** Setup helper: shows, per object type, how each attribute would be filled. */
export async function assetsCheck() {
  const out: Record<string, unknown> = { schema: config.assets.schemaName, statuses: (await assets.statuses()).map((s) => s.name) };
  const statusOk = (out.statuses as string[]).some((s) => s.toLowerCase() === config.assets.statusOnCreate.toLowerCase());
  out.statusOnCreate = `${config.assets.statusOnCreate} ${statusOk ? '(found)' : '(NOT FOUND — change config.assets.statusOnCreate)'}`;
  const types: Record<string, unknown> = {};
  for (const [category, c] of Object.entries(config.assets.categories)) {
    if (!c.objectType) continue;
    const typeId = await assets.objectTypeId(c.objectType);
    if (!typeId) { types[c.objectType] = 'NOT FOUND in the schema'; continue; }
    const defs = (await assets.attributesOf(typeId)).filter(assets.isWritable);
    types[c.objectType] = {
      category,
      asksForSerial: c.needsSerial,
      attributes: defs.map((a) => {
        const logical = logicalOf(a.name);
        const fill = logical ? `filled with ${logical}` : assets.isRequired(a) && ['text', 'textarea'].includes(assets.kindOf(a)) ? 'filled with the device model' : assets.isRequired(a) ? 'MANDATORY BUT NOT MAPPED' : 'left empty';
        return `${a.name}${assets.isRequired(a) ? ' *' : ''} [${assets.kindOf(a)}] — ${fill}`;
      }),
    };
  }
  out.objectTypes = types;
  return out;
}
