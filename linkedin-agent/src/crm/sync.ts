/**
 * LinkedIn -> GoHighLevel sync.
 *
 * One-way by design in v1. LinkedIn prospects become GHL contacts so Josh has a
 * single pipeline, and conversations land as notes so the context travels with
 * the contact. The one thing that flows the other way is the client list, which
 * feeds the "never engage an existing client" guardrail.
 */

import { CONFIG } from '../config/config.js';
import type { Prospect } from '../types.js';
import { exclude, listByState, setGhlIds, findById } from '../memory/prospects.js';
import { messagesFor } from '../memory/threads.js';
import {
  addNote,
  createOpportunity,
  ghlConfigured,
  knownClientNames,
  listPipelines,
  upsertContact,
} from './ghl.js';

export interface SyncSummary {
  contactsSynced: number;
  opportunitiesCreated: number;
  notesAdded: number;
  excluded: number;
  errors: string[];
  skipped: boolean;
}

const EMPTY: SyncSummary = {
  contactsSynced: 0,
  opportunitiesCreated: 0,
  notesAdded: 0,
  excluded: 0,
  errors: [],
  skipped: true,
};

function splitName(fullName: string): { firstName: string; lastName: string } {
  const parts = fullName.trim().split(/\s+/);
  if (parts.length === 1) return { firstName: parts[0]!, lastName: '' };
  return { firstName: parts[0]!, lastName: parts.slice(1).join(' ') };
}

/** Push one prospect into GHL as a contact. */
export async function syncProspect(p: Prospect): Promise<string | null> {
  const { firstName, lastName } = splitName(p.fullName);
  const contact = await upsertContact({
    firstName,
    lastName,
    companyName: p.company,
    city: p.location,
    source: `LinkedIn (${p.source})`,
    linkedinUrl: p.profileUrl,
  });
  setGhlIds(p.id, contact.id, null);
  return contact.id;
}

/**
 * Create an opportunity when a prospect starts actually talking to us. Earlier
 * than that and the pipeline fills with noise; later and Josh loses the thread.
 */
export async function createOpportunityFor(p: Prospect): Promise<string | null> {
  if (!p.ghlContactId) return null;
  if (p.ghlOpportunityId) return p.ghlOpportunityId;

  const pipelines = await listPipelines();
  const pipeline = pipelines[0];
  if (!pipeline) throw new Error('no GHL pipelines found for this location');

  const stage =
    pipeline.stages.find((s) => s.name.toLowerCase() === CONFIG.ghl.entryStageName.toLowerCase()) ??
    pipeline.stages[0];
  if (!stage) throw new Error(`pipeline ${pipeline.name} has no stages`);

  const opp = await createOpportunity({
    pipelineId: pipeline.id,
    stageId: stage.id,
    contactId: p.ghlContactId,
    name: `${p.fullName}${p.company ? ` — ${p.company}` : ''} (LinkedIn)`,
  });
  setGhlIds(p.id, null, opp.id);
  return opp.id;
}

/** Write a conversation into GHL as a note so the history travels with the contact. */
export async function syncThreadNote(prospectId: number, threadDbId: number): Promise<boolean> {
  const p = findById(prospectId);
  if (!p?.ghlContactId) return false;

  const messages = messagesFor(threadDbId, 20);
  if (messages.length === 0) return false;

  const body = [
    `LinkedIn conversation (synced ${new Date().toISOString().slice(0, 10)})`,
    `Profile: ${p.profileUrl}`,
    '',
    ...messages.map((m) => `${m.sender === 'us' ? 'Josh' : p.fullName}: ${m.body}`),
  ].join('\n');

  await addNote(p.ghlContactId, body);
  return true;
}

/**
 * Full sync pass. Safe to call when GHL isn't configured — it reports skipped
 * rather than throwing, so phases 0-5 run fine without a token.
 */
export async function runSync(): Promise<SyncSummary> {
  if (!ghlConfigured()) return { ...EMPTY };

  const summary: SyncSummary = {
    contactsSynced: 0,
    opportunitiesCreated: 0,
    notesAdded: 0,
    excluded: 0,
    errors: [],
    skipped: false,
  };

  // Pull the client list first so the guardrail is current before anything else.
  try {
    const clients = await knownClientNames();
    for (const state of ['sourced', 'scored', 'engaged', 'connected', 'conversing'] as const) {
      for (const p of listByState(state, 500)) {
        if (clients.has(p.fullName.trim().toLowerCase())) {
          exclude(p.id, 'existing GHL client or active deal — Josh handles personally');
          summary.excluded += 1;
        }
      }
    }
  } catch (err) {
    summary.errors.push(`client list: ${(err as Error).message}`);
  }

  // Anyone we're actually engaging belongs in the CRM.
  for (const state of ['engaged', 'connect_sent', 'connected', 'conversing', 'hot'] as const) {
    for (const p of listByState(state, 200)) {
      if (p.state === 'excluded') continue;
      try {
        if (!p.ghlContactId) {
          await syncProspect(p);
          summary.contactsSynced += 1;
        }
        if ((p.state === 'conversing' || p.state === 'hot') && !p.ghlOpportunityId) {
          const fresh = findById(p.id);
          if (fresh) {
            await createOpportunityFor(fresh);
            summary.opportunitiesCreated += 1;
          }
        }
      } catch (err) {
        summary.errors.push(`${p.publicId}: ${(err as Error).message}`);
      }
    }
  }

  return summary;
}
