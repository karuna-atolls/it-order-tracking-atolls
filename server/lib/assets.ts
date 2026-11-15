/**
 * Jira Service Management Assets REST API (same Basic auth as Jira).
 * Workspace, schema, object types, attributes and statuses are discovered by name and cached,
 * so the config only needs names — never IDs.
 */
import { config } from '../config';
import { atlassianAuth } from './jira';
import { requestJson } from './http';

export interface AttributeDef {
  id: string;
  name: string;
  label?: boolean;
  /** 0 = default (see defaultType), 1 = object reference, 2 = user, 7 = status */
  type: number;
  defaultType?: { id: number; name: string };
  referenceObjectTypeId?: string | number;
  referenceObjectType?: { id: string | number; name?: string };
  minimumCardinality?: number;
  options?: string;
  editable?: boolean;
  system?: boolean;
}

export interface AssetObject {
  id: string;
  objectKey: string;
  label: string;
  objectType?: { id: string; name: string };
  attributes?: {
    objectTypeAttributeId: string;
    objectAttributeValues: { value?: string; displayValue?: string; referencedObject?: { id: string; objectKey: string; label: string; objectType?: { id: string } } }[];
  }[];
}

let workspace: string | null = null;
async function base(): Promise<string> {
  if (!workspace) {
    const r = await requestJson<{ values?: { workspaceId: string }[] }>(`${config.jira.baseUrl}/rest/servicedeskapi/assets/workspace`, {
      headers: { Authorization: atlassianAuth(), Accept: 'application/json' },
    }, 'Assets workspace lookup');
    workspace = r.values?.[0]?.workspaceId || null;
    if (!workspace) throw new Error('No Assets workspace found for this Jira site');
  }
  return `https://api.atlassian.com/jsm/assets/workspace/${workspace}/v1`;
}

async function assets<T = any>(path: string, init: RequestInit = {}): Promise<T> {
  return requestJson<T>(`${await base()}${path}`, {
    ...init,
    headers: { Authorization: atlassianAuth(), Accept: 'application/json', 'Content-Type': 'application/json' },
  }, `Assets ${init.method || 'GET'} ${path.split('?')[0]}`);
}

let schemaCache: { id: string; types: Map<string, { id: string; name: string }> } | null = null;
/** The configured schema and its object types, by lower-cased name. */
export async function schema() {
  if (!schemaCache) {
    const list = await assets<{ values: { id: string; name: string }[] }>('/objectschema/list?maxResults=100');
    const found = list.values.find((x) => x.name.toLowerCase() === config.assets.schemaName.toLowerCase());
    if (!found) throw new Error(`Assets schema "${config.assets.schemaName}" not found (available: ${list.values.map((x) => x.name).join(', ')})`);
    const types = await assets<{ id: string; name: string }[]>(`/objectschema/${found.id}/objecttypes/flat`);
    schemaCache = { id: String(found.id), types: new Map(types.map((t) => [t.name.toLowerCase(), { id: String(t.id), name: t.name }])) };
  }
  return schemaCache;
}

export async function objectTypeId(name: string): Promise<string | null> {
  return (await schema()).types.get(name.toLowerCase())?.id ?? null;
}

const attributeCache = new Map<string, AttributeDef[]>();
export async function attributesOf(typeId: string): Promise<AttributeDef[]> {
  if (!attributeCache.has(typeId)) {
    const list = await assets<AttributeDef[]>(`/objecttype/${typeId}/attributes`);
    attributeCache.set(typeId, list.map((a) => ({ ...a, id: String(a.id) })));
  }
  return attributeCache.get(typeId)!;
}

let statusCache: { id: string; name: string }[] | null = null;
export async function statuses(): Promise<{ id: string; name: string }[]> {
  if (!statusCache) {
    const list = await assets<{ id: string | number; name: string }[]>(`/config/statustype?objectSchemaId=${(await schema()).id}`);
    statusCache = list.map((x) => ({ id: String(x.id), name: x.name }));
  }
  return statusCache;
}

/** Escape a value for use inside "..." in AQL. */
export const aqlValue = (v: string) => `"${String(v).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;

export async function aql(query: string, maxResults = 5): Promise<{ values: AssetObject[]; attributeNames: Map<string, string> }> {
  const res = await assets<{ values?: AssetObject[]; objectTypeAttributes?: { id: string | number; name: string }[] }>(
    `/object/aql?maxResults=${maxResults}&includeAttributes=true`, { method: 'POST', body: JSON.stringify({ qlQuery: query }) });
  return {
    values: res.values || [],
    attributeNames: new Map((res.objectTypeAttributes || []).map((a) => [String(a.id), a.name])),
  };
}

export const getObject = (id: string | number) => assets<AssetObject>(`/object/${id}`);

export const createObject = (typeId: string, attributes: { id: string; value: string }[]) =>
  assets<AssetObject>('/object/create', {
    method: 'POST',
    body: JSON.stringify({
      objectTypeId: typeId,
      attributes: attributes.map((a) => ({ objectTypeAttributeId: a.id, objectAttributeValues: [{ value: a.value }] })),
    }),
  });

export const isReference = (a: AttributeDef) => a.type === 1 || a.referenceObjectTypeId != null || a.referenceObjectType != null;
export const referenceTypeId = (a: AttributeDef) => String(a.referenceObjectTypeId ?? a.referenceObjectType?.id ?? '');
export const isUser = (a: AttributeDef) => a.type === 2;
export const isStatus = (a: AttributeDef) => a.type === 7;
export const kindOf = (a: AttributeDef) =>
  isReference(a) ? 'reference' : isUser(a) ? 'user' : isStatus(a) ? 'status' : (a.defaultType?.name || 'Text').toLowerCase();
export const isRequired = (a: AttributeDef) => (a.minimumCardinality || 0) >= 1;
export const isWritable = (a: AttributeDef) => !a.system && a.editable !== false;
