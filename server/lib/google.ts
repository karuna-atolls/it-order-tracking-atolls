/** Google access tokens from the service account key (optionally acting as a Workspace user). */
import { JWT } from 'google-auth-library';
import { env } from '../env';

const clients = new Map<string, JWT>();

export function serviceAccount(): { client_email: string; private_key: string; project_id: string } {
  return JSON.parse(env('GOOGLE_SERVICE_ACCOUNT_JSON'));
}

export async function googleToken(scope: string, subject?: string): Promise<string> {
  const cacheKey = `${scope}|${subject || ''}`;
  let client = clients.get(cacheKey);
  if (!client) {
    const sa = serviceAccount();
    client = new JWT({ email: sa.client_email, key: sa.private_key, scopes: [scope], subject });
    clients.set(cacheKey, client);
  }
  const { token } = await client.getAccessToken();
  if (!token) throw new Error('Google did not return an access token');
  return token;
}
