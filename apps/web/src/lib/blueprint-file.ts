/**
 * Reading a blueprint file, client-side (Phase 4 §14, §17).
 *
 * ## This is not a validator, and must not become one
 *
 * `readBlueprint` on the server is the validator: it gates the format version,
 * migrates, checks the envelope, normalizes and runs the canonical IPS rules,
 * and it reports §14's path-and-reason detail for every problem. §14 is
 * explicit that there must not be a second error system, and
 * `web-must-not-import-server` means this app could not share that code even if
 * it should.
 *
 * So what is here does exactly two things the server cannot:
 *
 * - **Says "this file is not a blueprint" without a round trip.** A user who
 *   picks the wrong file — a `package.json`, an OpenAPI spec, a screenshot —
 *   learns immediately instead of after an upload.
 * - **Summarises what is about to be created.** Importing makes a project; the
 *   person doing it should see the name, the kind and the size first. That is
 *   also the review step the wizard has and an import otherwise would not.
 *
 * Everything it reports is provisional. A file that passes here can still be
 * refused by the server, and when that happens the server's answer is the one
 * shown — never a guess made here.
 */

/** The handful of fields the preview reads. Everything else is the server's. */
export interface BlueprintPreview {
  name: string;
  /** `project` | `single` | `auth`, or whatever unknown value the file holds. */
  kind: string;
  description: string | null;
  /** The definition version it was taken from, per `metadata.sourceVersion`. */
  sourceVersion: number | null;
  entities: { name: string; fieldCount: number; relationCount: number }[];
  /** Resolved only as far as the mode — the server decides the rest. */
  authMode: string | null;
  blueprintVersion: number;
}

export type BlueprintReadResult =
  { ok: true; blueprint: unknown; preview: BlueprintPreview } | { ok: false; reason: string };

const isObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

/**
 * Parse and sniff a pasted or uploaded file.
 *
 * The checks are deliberately shallow — is it JSON, does it declare a
 * blueprint version, does it have the four top-level parts — because anything
 * deeper would be duplicating the server's rules and would eventually disagree
 * with them. A file that gets past this and is then refused is the expected
 * case, not a failure of this function.
 */
export function readBlueprintFile(text: string): BlueprintReadResult {
  if (text.trim() === '') {
    return { ok: false, reason: 'Paste a blueprint, or choose a .json file to import.' };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    return {
      ok: false,
      reason: 'That is not valid JSON. A blueprint is the .json file you exported.',
    };
  }

  if (!isObject(parsed)) {
    return { ok: false, reason: 'A blueprint is a JSON object. This file holds something else.' };
  }

  const blueprintVersion = parsed['blueprintVersion'];
  if (typeof blueprintVersion !== 'number') {
    return {
      ok: false,
      // Named, because the most likely wrong file is another JSON file from the
      // same project — an OpenAPI spec or a Postman collection.
      reason:
        'This JSON file is not a blueprint — it has no blueprintVersion. Export one from a project’s Docs tab.',
    };
  }

  const project = isObject(parsed['project']) ? parsed['project'] : {};
  const metadata = isObject(parsed['metadata']) ? parsed['metadata'] : {};
  const authentication = isObject(parsed['authentication']) ? parsed['authentication'] : null;
  const rawEntities = Array.isArray(parsed['entities']) ? parsed['entities'] : [];

  const name = typeof project['name'] === 'string' ? project['name'] : '';
  if (name.trim() === '') {
    return { ok: false, reason: 'This blueprint has no project name, so it cannot be imported.' };
  }

  return {
    ok: true,
    blueprint: parsed,
    preview: {
      name,
      kind: typeof project['kind'] === 'string' ? project['kind'] : 'project',
      description: typeof project['description'] === 'string' ? project['description'] : null,
      sourceVersion:
        typeof metadata['sourceVersion'] === 'number' ? metadata['sourceVersion'] : null,
      entities: rawEntities.filter(isObject).map((entity) => ({
        name: typeof entity['name'] === 'string' ? entity['name'] : '(unnamed)',
        fieldCount: Array.isArray(entity['fields']) ? entity['fields'].length : 0,
        relationCount: Array.isArray(entity['relations']) ? entity['relations'].length : 0,
      })),
      authMode:
        authentication !== null && typeof authentication['mode'] === 'string'
          ? authentication['mode']
          : null,
      blueprintVersion,
    },
  };
}

/**
 * How the preview describes the kind.
 *
 * The same three words the chooser at `/new` uses, so someone who picked a
 * kind there recognises what the file is bringing — the blueprint decides the
 * kind, not the person importing, and that is worth stating plainly.
 */
export function describeKind(kind: string): string {
  if (kind === 'auth') {
    return 'Auth API';
  }
  if (kind === 'single') {
    return 'Single API';
  }
  if (kind === 'project') {
    return 'Project API';
  }
  // Not silently normalised: an unrecognised kind means the file came from a
  // build this one does not match, and the server will say so.
  return kind;
}

/** `3 entities · 14 fields · 2 relationships`, or the empty-surface case. */
export function describeSurface(preview: BlueprintPreview): string {
  if (preview.entities.length === 0) {
    return preview.authMode === null ? 'No entities' : 'No entities — the surface is the Auth API';
  }
  const fields = preview.entities.reduce((total, entity) => total + entity.fieldCount, 0);
  const relations = preview.entities.reduce((total, entity) => total + entity.relationCount, 0);
  const parts = [
    `${preview.entities.length} ${preview.entities.length === 1 ? 'entity' : 'entities'}`,
    `${fields} ${fields === 1 ? 'field' : 'fields'}`,
  ];
  if (relations > 0) {
    parts.push(`${relations} ${relations === 1 ? 'relationship' : 'relationships'}`);
  }
  return parts.join(' · ');
}
