/**
 * Technical Notes, rendered for a human (Phase 4 §2–§6, §10).
 *
 * The second half of §9's chain: this reads `DocumentationModel` and derives
 * nothing. Every resolved fact — which endpoints need a token, what a relation's
 * cardinality is — was decided in the model, so the human document and the AI
 * document cannot disagree about the project they describe.
 *
 * ## Written for the three readers §2 names
 *
 * A developer joining the project, an AI assistant, and someone reviewing an
 * import. That rules out two tempting shapes: a wall of tables nobody reads
 * top-to-bottom, and prose that buries the facts. What is here is headed
 * sections with the facts in lists — skimmable by a person, parseable by a
 * machine, and diffable line by line when two versions are compared.
 *
 * ## Determinism (§8)
 *
 * No clock, no randomness, no iteration over unordered keys. The one mutable
 * thing a caller may pass — `runtime` — is rendered under its own heading that
 * says it describes the project's current state rather than its definition, so
 * a reader can tell which half moves on its own.
 */

import { QUERY_FEATURES } from '@instantmockapi/ips';
import type {
  DocumentationModel,
  NotesEndpoint,
  NotesEntity,
  NotesField,
  NotesRelation,
} from './notes-model.js';
import { stringifyDefault } from './notes-model.js';

/**
 * Free text, flattened to a single line.
 *
 * `validateIPS` constrains entity and field names but says nothing about a
 * description, so a description is an arbitrary string arriving inside a
 * markdown bullet. A raw newline in one would at best break the list and at
 * worst forge structure — `## Authentication` on its own line becomes a real
 * heading, and a reviewer reading an imported project (§14) cannot tell it from
 * one this renderer wrote.
 */
function oneLine(value: string): string {
  return value.replace(/\s*[\r\n]+\s*/g, ' ').trim();
}

/** A markdown document, assembled as lines so blank-line rules stay visible. */
class Lines {
  private readonly out: string[] = [];

  push(...lines: string[]): void {
    this.out.push(...lines);
  }

  /** A heading always followed by one blank line. */
  heading(level: number, text: string): void {
    this.out.push(`${'#'.repeat(level)} ${text}`, '');
  }

  /** Collapses runs of blank lines, so an empty section cannot leave a gap. */
  toString(): string {
    const collapsed: string[] = [];
    for (const line of this.out) {
      if (line === '' && collapsed[collapsed.length - 1] === '') {
        continue;
      }
      collapsed.push(line);
    }
    return `${collapsed.join('\n').trimEnd()}\n`;
  }
}

/** `true` → `Yes`, so a reader is not parsing booleans. */
const yesNo = (value: boolean): string => (value ? 'Yes' : 'No');

/**
 * A default value, rendered.
 *
 * Only called when `NotesField.hasDefault` is true, so `null` and `undefined`
 * cannot reach it — both mean *no default* in this codebase and the caller has
 * already dropped the attribute. The fallback stays for total safety.
 */
function renderDefault(value: unknown): string {
  if (value === undefined || value === null) {
    return '—';
  }
  return typeof value === 'string' ? `"${oneLine(value)}"` : stringifyDefault(value);
}

function renderFieldLine(field: NotesField, depth: number): string {
  const indent = '  '.repeat(depth);
  const parts = [
    `${field.type}`,
    field.required ? 'required' : 'optional',
    /*
     * `hasDefault`, not `default !== undefined`.
     *
     * The parsers write `null` for a field with no default, and `zod.ts` /
     * `yup.ts` emit `.default(...)` only for a value that is neither `null` nor
     * `undefined`. Rendering the raw value would print `default null` on almost
     * every field and claim behaviour the generated validators do not have.
     */
    ...(field.hasDefault ? [`default ${renderDefault(field.default)}`] : []),
    ...field.validation.rules,
    ...field.traits,
  ];
  const id = field.id === null ? '' : ` \`${field.id}\``;
  return `${indent}- **${field.name}**${id} — ${parts.join(' · ')}`;
}

function renderFields(lines: Lines, fields: readonly NotesField[], depth = 0): void {
  for (const field of fields) {
    lines.push(renderFieldLine(field, depth));
    if (field.children.length > 0) {
      renderFields(lines, field.children, depth + 1);
    }
  }
}

function renderEntity(lines: Lines, entity: NotesEntity): void {
  lines.heading(3, entity.name);

  const facts = [
    `- Stable id: \`${entity.id ?? '(none — predates stable ids)'}\``,
    `- Hosted path: \`/${entity.path}\``,
    // Resolved, per §5 — the whole point of the model doing this.
    `- Authentication: ${entity.requiresAuth ? 'Required' : 'Not required'}`,
    `- Identity: \`${entity.identity.field}\` (${entity.identity.style})`,
  ];
  if (entity.description !== null && entity.description !== '') {
    facts.unshift(`- ${oneLine(entity.description)}`);
  }
  lines.push(...facts, '');

  lines.heading(4, 'Fields');
  if (entity.fields.length === 0) {
    lines.push('_No fields._', '');
  } else {
    renderFields(lines, entity.fields);
    lines.push('');
  }

  if (entity.relations.length > 0) {
    lines.heading(4, 'Relationships');
    for (const relation of entity.relations) {
      lines.push(renderRelationLine(relation));
    }
    lines.push('');
  }
}

/** §4: understandable without opening the schema editor. */
function renderRelationLine(relation: NotesRelation): string {
  const id = relation.id === null ? '' : ` \`${relation.id}\``;
  return (
    `- **${relation.name}**${id} — ${relation.source}.${relation.localField} → ` +
    `${relation.target}.${relation.foreignField} · ${relation.cardinality} · ` +
    `on delete ${relation.onDelete}`
  );
}

function renderEndpointLine(endpoint: NotesEndpoint): string {
  const bits = [
    endpoint.requiresAuth ? 'Authentication: Required' : 'Authentication: Not required',
    ...(endpoint.pathParams.length > 0 ? [`path: ${endpoint.pathParams.join(', ')}`] : []),
    ...(endpoint.queryParams.length > 0 ? [`query: ${endpoint.queryParams.join(', ')}`] : []),
    ...(endpoint.requestEntity === null ? [] : [`body: ${endpoint.requestEntity}`]),
  ];
  return `- \`${endpoint.method} ${endpoint.path}\` — ${endpoint.summary} · ${bits.join(' · ')}`;
}

/**
 * Render the human-readable Technical Notes.
 *
 * Contains no secret by construction: the model it reads has no field for one.
 * See `NotesAuth`.
 */
export function renderTechnicalNotes(model: DocumentationModel): string {
  const lines = new Lines();
  const { project, auth, runtime } = model;

  lines.heading(1, `${oneLine(project.name) || 'Untitled project'} — Technical Notes`);

  lines.heading(2, 'Project');
  lines.push(
    `- Name: ${oneLine(project.name) || '—'}`,
    ...(project.description === null || project.description === ''
      ? []
      : [`- Description: ${oneLine(project.description)}`]),
    `- Type: ${project.kind}`,
    `- Definition version: v${project.version}`,
    ...(project.publicId === null ? [] : [`- Public id: \`${project.publicId}\``]),
    ...(project.slug === null ? [] : [`- Base path: \`${project.slug}\``]),
    '',
  );

  /*
   * §8 versus §2, resolved by separation.
   *
   * §2 asks for generation status and published version; §8 requires the
   * document to be deterministic. These move without the definition changing,
   * so they go under a heading that says as much — and a determinism check can
   * compare everything else.
   */
  const runtimeLines = [
    ...(runtime.status === undefined ? [] : [`- Status: ${runtime.status}`]),
    ...(runtime.publishedVersion === undefined
      ? []
      : [
          `- Published version: ${
            runtime.publishedVersion === null ? 'nothing published yet' : `v${runtime.publishedVersion}`
          }`,
        ]),
    ...(runtime.pendingRegeneration === undefined
      ? []
      : [`- Pending regeneration: ${yesNo(runtime.pendingRegeneration)}`]),
    ...(runtime.hostedUrl === undefined || runtime.hostedUrl === null
      ? []
      : [`- Hosted URL: ${runtime.hostedUrl}`]),
    ...(runtime.source === undefined ? [] : [`- Describes: the ${runtime.source} definition`]),
    ...(runtime.generatedAt === undefined ? [] : [`- Generated at: ${runtime.generatedAt}`]),
  ];
  if (runtimeLines.length > 0) {
    lines.heading(2, 'Current state');
    lines.push(
      '_These facts move on their own. Every other section describes the definition, which does not._',
      '',
      ...runtimeLines,
      '',
    );
  }

  lines.heading(2, 'Authentication');
  if (!auth.enabled) {
    // §6: state it plainly. A misleading auth section is worse than none, and
    // an absent section reads as "not documented" rather than "not enabled".
    lines.push('Authentication: Disabled', '', 'Every endpoint is open — no token is required.', '');
  } else {
    lines.push(
      `- Mode: ${auth.mode}`,
      `- Access token lifetime: ${auth.accessTokenExpiresIn}`,
      `- Refresh token lifetime: ${auth.refreshTokenExpiresIn}`,
      `- Cookie authentication: ${yesNo(auth.cookieAuth)}`,
      `- Protected entities: ${
        auth.protectedEntities.length === 0 ? 'none' : auth.protectedEntities.join(', ')
      }`,
      '',
    );
    lines.heading(3, 'Endpoints');
    for (const endpoint of auth.endpoints) {
      lines.push(
        `- \`${endpoint.method} ${endpoint.path}\` — ${
          endpoint.requiresToken ? 'requires a token' : 'no token required'
        }`,
      );
    }
    lines.push('');
    if (auth.userFields.length > 0) {
      lines.heading(3, 'Sign-up fields');
      lines.push('Collected in addition to email and password.', '');
      for (const field of auth.userFields) {
        lines.push(`- **${field.name}** — ${field.type} · ${field.required ? 'required' : 'optional'}`);
      }
      lines.push('');
    }
  }

  lines.heading(2, 'Data model');
  if (model.entities.length === 0) {
    lines.push(
      project.kind === 'auth'
        ? '_This project has no entities — its surface is the Auth API above._'
        : '_No entities._',
      '',
    );
  } else {
    for (const entity of model.entities) {
      renderEntity(lines, entity);
    }
  }

  if (model.relations.length > 0) {
    lines.heading(2, 'Relationships');
    for (const relation of model.relations) {
      lines.push(renderRelationLine(relation));
    }
    lines.push('');
  }

  lines.heading(2, 'API');
  if (model.endpoints.length === 0) {
    lines.push('_No endpoints._', '');
  } else {
    for (const endpoint of model.endpoints) {
      lines.push(renderEndpointLine(endpoint));
    }
    lines.push('');
  }

  lines.heading(2, 'Generation');
  const enabledFeatures = QUERY_FEATURES.filter(
    (feature) => model.generation.features[feature],
  );
  lines.push(
    `- Methods: ${model.generation.methods.join(', ') || 'none'}`,
    `- Validators: ${model.generation.validators.join(', ') || 'none'}`,
    `- Types: ${model.generation.types.join(', ') || 'none'}`,
    `- Mock records per entity: ${model.generation.mockRecords}`,
    `- Query features: ${enabledFeatures.join(', ') || 'none enabled'}`,
    '',
  );

  return lines.toString();
}
