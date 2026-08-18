/**
 * GoHighLevel API v2 (LeadConnector) client.
 *
 * Auth is a Private Integration Token generated in the sub-account — Settings →
 * Private Integrations. It needs contacts (read/write), opportunities
 * (read/write), and notes (write) scopes.
 *
 * Only the handful of endpoints this agent uses are wrapped. Endpoint shapes are
 * worth re-checking against GHL's docs before the first live run; their v2 API
 * has moved before.
 */

import { CONFIG } from '../config/config.js';

export class GhlNotConfiguredError extends Error {
  constructor() {
    super('GHL_API_KEY is not set — CRM sync is disabled. Generate a Private Integration Token in the sub-account.');
    this.name = 'GhlNotConfiguredError';
  }
}

export function ghlConfigured(): boolean {
  return Boolean(process.env.GHL_API_KEY);
}

async function call<T>(
  method: 'GET' | 'POST' | 'PUT',
  path: string,
  body?: unknown,
  query?: Record<string, string>,
): Promise<T> {
  const token = process.env.GHL_API_KEY;
  if (!token) throw new GhlNotConfiguredError();

  const url = new URL(path, CONFIG.ghl.apiBase);
  for (const [k, v] of Object.entries(query ?? {})) url.searchParams.set(k, v);

  const res = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Version: CONFIG.ghl.apiVersion,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`GHL ${method} ${path} failed: ${res.status} ${res.statusText} ${text.slice(0, 400)}`);
  }
  return (await res.json()) as T;
}

export interface GhlContact {
  id: string;
  firstName?: string;
  lastName?: string;
  email?: string;
  tags?: string[];
  companyName?: string;
}

/** Look a contact up by name — LinkedIn rarely gives us an email. */
export async function searchContacts(query: string): Promise<GhlContact[]> {
  const res = await call<{ contacts?: GhlContact[] }>('GET', '/contacts/', undefined, {
    locationId: CONFIG.ghl.locationId,
    query,
    limit: '20',
  });
  return res.contacts ?? [];
}

export interface UpsertContactInput {
  firstName: string;
  lastName: string;
  companyName?: string | null;
  city?: string | null;
  source: string;
  linkedinUrl: string;
  tags?: string[];
}

export async function upsertContact(input: UpsertContactInput): Promise<GhlContact> {
  const res = await call<{ contact: GhlContact }>('POST', '/contacts/upsert', {
    locationId: CONFIG.ghl.locationId,
    firstName: input.firstName,
    lastName: input.lastName,
    companyName: input.companyName ?? undefined,
    city: input.city ?? undefined,
    source: input.source,
    tags: [CONFIG.ghl.tag, ...(input.tags ?? [])],
    customFields: [{ key: 'linkedin_url', field_value: input.linkedinUrl }],
  });
  return res.contact;
}

export interface GhlPipeline {
  id: string;
  name: string;
  stages: Array<{ id: string; name: string }>;
}

export async function listPipelines(): Promise<GhlPipeline[]> {
  const res = await call<{ pipelines?: GhlPipeline[] }>(
    'GET',
    '/opportunities/pipelines',
    undefined,
    { locationId: CONFIG.ghl.locationId },
  );
  return res.pipelines ?? [];
}

export interface CreateOpportunityInput {
  pipelineId: string;
  stageId: string;
  contactId: string;
  name: string;
  monetaryValue?: number;
}

export async function createOpportunity(
  input: CreateOpportunityInput,
): Promise<{ id: string }> {
  const res = await call<{ opportunity: { id: string } }>('POST', '/opportunities/', {
    locationId: CONFIG.ghl.locationId,
    pipelineId: input.pipelineId,
    pipelineStageId: input.stageId,
    contactId: input.contactId,
    name: input.name,
    status: 'open',
    monetaryValue: input.monetaryValue,
  });
  return res.opportunity;
}

export async function addNote(contactId: string, body: string): Promise<void> {
  await call('POST', `/contacts/${contactId}/notes`, { body });
}

/**
 * Contacts already tagged as clients or sitting in a won stage. Feeds the
 * "never engage an existing client" guardrail — the agent asks GHL who's
 * off-limits rather than relying on Josh to remember to tell it.
 */
export async function knownClientNames(): Promise<Set<string>> {
  const names = new Set<string>();
  for (const tag of ['client', 'customer', 'active-client']) {
    try {
      const contacts = await searchContacts(tag);
      for (const c of contacts) {
        const full = `${c.firstName ?? ''} ${c.lastName ?? ''}`.trim().toLowerCase();
        if (full) names.add(full);
      }
    } catch {
      // A tag that doesn't exist in this sub-account is not an error.
    }
  }
  return names;
}
