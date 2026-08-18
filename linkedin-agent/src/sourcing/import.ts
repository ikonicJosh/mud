/**
 * Clay / Vibe Prospecting import.
 *
 * Those connectors live in Claude sessions, not in this process, so the handoff
 * is a file: Josh builds a list in a session, drops JSON into data/import/, and
 * this ingests it. That keeps the heaviest prospecting entirely off LinkedIn,
 * which is both better targeting and a much smaller footprint on the account.
 *
 * Expected shape (extra keys are ignored, so a raw Clay export usually works):
 *
 *   [
 *     {
 *       "linkedinUrl": "https://www.linkedin.com/in/jane-smith-hvac/",
 *       "fullName": "Jane Smith",
 *       "headline": "Owner at Smith Heating & Air",
 *       "company": "Smith Heating & Air",
 *       "companyDomain": "smithheating.com",
 *       "location": "Denver, CO",
 *       "industry": "HVAC",
 *       "fleetSize": 6,
 *       "employeeCount": 22
 *     }
 *   ]
 */

import fs from 'node:fs';
import path from 'node:path';
import { PATHS, ensureDirs } from '../config/config.js';
import { publicIdFromUrl } from '../browser/selectors.js';
import { upsertProspect } from '../memory/prospects.js';

export interface ImportRow {
  linkedinUrl?: string;
  linkedin_url?: string;
  profileUrl?: string;
  fullName?: string;
  full_name?: string;
  name?: string;
  headline?: string;
  title?: string;
  company?: string;
  companyDomain?: string;
  domain?: string;
  location?: string;
  industry?: string;
  fleetSize?: number;
  employeeCount?: number;
}

export interface ImportSummary {
  file: string;
  imported: number;
  skipped: number;
  reasons: string[];
}

/** Import every .json file sitting in data/import/. */
export function importAll(): ImportSummary[] {
  ensureDirs();
  if (!fs.existsSync(PATHS.imports)) return [];
  const files = fs
    .readdirSync(PATHS.imports)
    .filter((f) => f.endsWith('.json'))
    .map((f) => path.join(PATHS.imports, f));
  return files.map(importFile);
}

export function importFile(file: string): ImportSummary {
  const summary: ImportSummary = { file: path.basename(file), imported: 0, skipped: 0, reasons: [] };

  let rows: ImportRow[];
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as unknown;
    rows = Array.isArray(parsed) ? (parsed as ImportRow[]) : [parsed as ImportRow];
  } catch (err) {
    summary.skipped += 1;
    summary.reasons.push(`unreadable JSON: ${(err as Error).message}`);
    return summary;
  }

  for (const row of rows) {
    const url = row.linkedinUrl ?? row.linkedin_url ?? row.profileUrl;
    const publicId = url ? publicIdFromUrl(url) : null;
    if (!publicId) {
      summary.skipped += 1;
      summary.reasons.push(`row without a usable LinkedIn URL: ${JSON.stringify(row).slice(0, 120)}`);
      continue;
    }

    const fullName = row.fullName ?? row.full_name ?? row.name;
    if (!fullName) {
      summary.skipped += 1;
      summary.reasons.push(`${publicId}: no name`);
      continue;
    }

    upsertProspect({
      publicId,
      profileUrl: `https://www.linkedin.com/in/${publicId}/`,
      fullName,
      headline: row.headline ?? row.title ?? null,
      company: row.company ?? null,
      companyDomain: row.companyDomain ?? row.domain ?? null,
      location: row.location ?? null,
      industry: row.industry ?? null,
      fleetSize: row.fleetSize ?? null,
      employeeCount: row.employeeCount ?? null,
      source: 'clay_import',
    });
    summary.imported += 1;
  }

  return summary;
}

/** Move a processed file aside so re-running doesn't re-read it. */
export function archiveFile(file: string): void {
  const done = path.join(PATHS.imports, 'processed');
  fs.mkdirSync(done, { recursive: true });
  const base = path.basename(file);
  fs.renameSync(path.join(PATHS.imports, base), path.join(done, `${Date.now()}-${base}`));
}
