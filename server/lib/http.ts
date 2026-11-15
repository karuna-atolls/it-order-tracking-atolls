export class HttpError extends Error {
  constructor(public status: number, public body: string, where: string) {
    super(`${where} failed: HTTP ${status} ${body.slice(0, 500)}`);
  }
}

/** fetch + JSON parse + readable errors. */
export async function requestJson<T = any>(url: string, init: RequestInit, where: string): Promise<T> {
  const res = await fetch(url, init);
  const text = await res.text();
  if (!res.ok) throw new HttpError(res.status, text, where);
  return (text ? JSON.parse(text) : null) as T;
}
