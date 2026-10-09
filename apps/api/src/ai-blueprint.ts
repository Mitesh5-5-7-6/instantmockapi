/**
 * Convert a natural-language prompt into a structured, validator-friendly
 * project blueprint that can feed the existing IPS creation pipeline.
 *
 * The platform treats AI output as untrusted input: the blueprint is kept
 * structured and then validated through the same deterministic rules as any
 * other project definition. This helper intentionally does not try to replace
 * the canonical project schema; it simply proposes a reasonable initial model.
 */

import { HTTP_METHODS, type ProjectKind } from '@instantmockapi/shared';
import type { Entity, Field, GenerationConfig, Relation } from '@instantmockapi/ips';

export interface AgentInput {
  prompt: string;
  kind?: ProjectKind;
  name?: string;
  description?: string;
}

export interface LLMProvider {
  generateStructured<T>(input: AgentInput): Promise<T>;
}

export interface AiBlueprintProject {
  kind: ProjectKind;
  name: string;
  description: string;
  entities: Entity[];
  generationConfig: GenerationConfig;
}

const DEFAULT_GENERATION_CONFIG: GenerationConfig = {
  validators: ['zod'],
  types: ['typescript'],
  methods: [...HTTP_METHODS],
  mockRecords: 25,
  features: {
    search: true,
    filter: true,
    sort: true,
    include: true,
  },
  unknownFields: 'reject',
};

function toPascalCase(value: string): string {
  return value
    .replace(/[^a-zA-Z0-9]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join(' ')
    .replace(/\s+/g, '');
}

function makeField(
  name: string,
  type: Field['type'],
  required = true,
  overrides: Partial<Field> = {},
): Field {
  return {
    name,
    type,
    required,
    default: overrides.default ?? null,
    children: overrides.children ?? [],
    validation: overrides.validation ?? {},
    meta: overrides.meta ?? {},
  };
}

function makeRelation(
  name: string,
  kind: Relation['kind'],
  target: string,
  localField: string,
  foreignField: string,
  required = false,
): Relation {
  return {
    name,
    kind,
    target,
    localField,
    foreignField,
    required,
    onDelete: kind === 'belongsTo' ? 'restrict' : 'cascade',
  };
}

function inferProjectName(prompt: string): string {
  const lower = prompt.toLowerCase();

  if (/(hospital|clinic|medical)/i.test(lower)) return 'Hospital API';
  if (/(e-?commerce|shop|store|retail|checkout|orders?)/i.test(lower)) return 'E-commerce API';
  if (/(blog|post|article|news)/i.test(lower)) return 'Blog API';
  if (/(inventory|warehouse|catalog)/i.test(lower)) return 'Inventory API';

  const cleaned = prompt
    .replace(/^(create|generate|build|make|i need|please)\s+/i, '')
    .replace(/\bapi\b/gi, '')
    .replace(/[^a-zA-Z0-9\s]/g, ' ')
    .trim();

  const words = cleaned
    .split(/\s+/)
    .filter(
      (word) =>
        !['with', 'and', 'the', 'a', 'an', 'for', 'of', 'to', 'into'].includes(word.toLowerCase()),
    );

  if (words.length === 0) return 'Simple API';

  return `${toPascalCase(words.slice(0, 3).join(' '))} API`;
}

function inferEntityPlan(prompt: string): string[] {
  const lower = prompt.toLowerCase();

  if (/(hospital|clinic|medical)/i.test(lower)) {
    return ['Patient', 'Doctor', 'Department', 'Appointment'];
  }
  if (/(e-?commerce|shop|store|retail|checkout|orders?)/i.test(lower)) {
    return ['User', 'Product', 'Category', 'Order', 'Payment'];
  }
  if (/(blog|post|article|news)/i.test(lower)) {
    return ['User', 'Post', 'Comment', 'Tag'];
  }
  if (/(inventory|warehouse|catalog)/i.test(lower)) {
    return ['Product', 'Category', 'Supplier', 'InventoryItem'];
  }

  return ['User', 'Post', 'Comment', 'Tag'];
}

function entityFields(name: string): Field[] {
  const baseId = makeField('id', 'uuid', true, { meta: { identity: true } });

  const commonMap: Record<string, Field[]> = {
    Patient: [
      baseId,
      makeField('name', 'string', true),
      makeField('dateOfBirth', 'date', true),
      makeField('gender', 'string', false),
      makeField('phone', 'string', false),
      makeField('email', 'string', true, {
        validation: { email: true },
        meta: { searchable: true },
      }),
    ],
    Doctor: [
      baseId,
      makeField('name', 'string', true),
      makeField('specialization', 'string', true),
      makeField('departmentId', 'uuid', true),
      makeField('email', 'string', true, {
        validation: { email: true },
      }),
      makeField('phone', 'string', false),
    ],
    Department: [
      baseId,
      makeField('name', 'string', true),
      makeField('description', 'string', false),
    ],
    Appointment: [
      baseId,
      makeField('patientId', 'uuid', true),
      makeField('doctorId', 'uuid', true),
      makeField('appointmentDate', 'date', true),
      makeField('status', 'string', true, {
        validation: { enum: ['scheduled', 'confirmed', 'completed', 'cancelled'] },
      }),
      makeField('notes', 'string', false),
    ],
    User: [
      baseId,
      makeField('name', 'string', true),
      makeField('email', 'string', true, {
        validation: { email: true },
        meta: { searchable: true },
      }),
      makeField('createdAt', 'date', false),
    ],
    Post: [
      baseId,
      makeField('title', 'string', true),
      makeField('content', 'string', true),
      makeField('authorId', 'uuid', true),
      makeField('publishedAt', 'date', false),
    ],
    Comment: [
      baseId,
      makeField('postId', 'uuid', true),
      makeField('authorId', 'uuid', true),
      makeField('body', 'string', true),
      makeField('createdAt', 'date', false),
    ],
    Tag: [baseId, makeField('name', 'string', true)],
    Product: [
      baseId,
      makeField('name', 'string', true),
      makeField('description', 'string', false),
      makeField('price', 'decimal', true),
      makeField('categoryId', 'uuid', true),
    ],
    Category: [
      baseId,
      makeField('name', 'string', true),
      makeField('description', 'string', false),
    ],
    Order: [
      baseId,
      makeField('userId', 'uuid', true),
      makeField('total', 'decimal', true),
      makeField('status', 'string', true, {
        validation: { enum: ['pending', 'paid', 'shipped', 'cancelled'] },
      }),
      makeField('createdAt', 'date', false),
    ],
    Payment: [
      baseId,
      makeField('orderId', 'uuid', true),
      makeField('amount', 'decimal', true),
      makeField('method', 'string', true),
      makeField('status', 'string', true, {
        validation: { enum: ['pending', 'paid', 'failed'] },
      }),
    ],
    Supplier: [
      baseId,
      makeField('name', 'string', true),
      makeField('email', 'string', false, { validation: { email: true } }),
      makeField('phone', 'string', false),
    ],
    InventoryItem: [
      baseId,
      makeField('productId', 'uuid', true),
      makeField('quantity', 'integer', true),
      makeField('location', 'string', false),
    ],
  };

  return (
    commonMap[name] ?? [
      baseId,
      makeField('name', 'string', true),
      makeField('description', 'string', false),
    ]
  );
}

function entityRelations(entityName: string, targetNames: string[]): Relation[] {
  const relations: Relation[] = [];

  if (entityName === 'Patient') {
    relations.push(
      makeRelation('appointments', 'hasMany', 'Appointment', 'id', 'patientId', false),
    );
  }

  if (entityName === 'Doctor') {
    relations.push(makeRelation('appointments', 'hasMany', 'Appointment', 'id', 'doctorId', false));
    relations.push(
      makeRelation('department', 'belongsTo', 'Department', 'departmentId', 'id', true),
    );
  }

  if (entityName === 'Department') {
    relations.push(makeRelation('doctors', 'hasMany', 'Doctor', 'id', 'departmentId', false));
  }

  if (entityName === 'Appointment') {
    relations.push(makeRelation('patient', 'belongsTo', 'Patient', 'patientId', 'id', true));
    relations.push(makeRelation('doctor', 'belongsTo', 'Doctor', 'doctorId', 'id', true));
  }

  if (entityName === 'User') {
    relations.push(makeRelation('posts', 'hasMany', 'Post', 'id', 'authorId', false));
  }

  if (entityName === 'Post') {
    relations.push(makeRelation('author', 'belongsTo', 'User', 'authorId', 'id', true));
    relations.push(makeRelation('comments', 'hasMany', 'Comment', 'id', 'postId', false));
  }

  if (entityName === 'Comment') {
    relations.push(makeRelation('post', 'belongsTo', 'Post', 'postId', 'id', true));
  }

  if (entityName === 'Product') {
    relations.push(makeRelation('category', 'belongsTo', 'Category', 'categoryId', 'id', true));
  }

  if (entityName === 'Category') {
    relations.push(makeRelation('products', 'hasMany', 'Product', 'id', 'categoryId', false));
  }

  if (entityName === 'Order') {
    relations.push(makeRelation('user', 'belongsTo', 'User', 'userId', 'id', true));
  }

  if (entityName === 'Payment') {
    relations.push(makeRelation('order', 'belongsTo', 'Order', 'orderId', 'id', true));
  }

  if (entityName === 'Supplier') {
    relations.push(
      makeRelation('inventoryItems', 'hasMany', 'InventoryItem', 'id', 'supplierId', false),
    );
  }

  if (entityName === 'InventoryItem') {
    relations.push(makeRelation('supplier', 'belongsTo', 'Supplier', 'supplierId', 'id', false));
  }

  return relations.filter((relation) => targetNames.includes(relation.target));
}

export function generateAiBlueprint(prompt: string): AiBlueprintProject {
  const cleanedPrompt = prompt.trim();
  const projectName = inferProjectName(cleanedPrompt || 'Create a simple API.');
  const entityNames = inferEntityPlan(cleanedPrompt || 'Create a simple API.');

  const entities: Entity[] = entityNames.map((entityName) => ({
    name: entityName,
    fields: entityFields(entityName),
    relations: entityRelations(entityName, entityNames),
    description: `${entityName} data model`,
  }));

  return {
    kind: 'project',
    name: projectName,
    description: cleanedPrompt || 'Generated API blueprint',
    entities,
    generationConfig: {
      ...DEFAULT_GENERATION_CONFIG,
      methods: ['GET', 'POST', 'PATCH', 'DELETE'],
      mockRecords: 20,
    },
  };
}

function extractJsonObject(rawText: string): unknown {
  const trimmed = rawText.trim();
  const withoutFence = trimmed
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();
  const startIndex = withoutFence.indexOf('{');
  const endIndex = withoutFence.lastIndexOf('}');

  if (startIndex !== -1 && endIndex !== -1 && endIndex > startIndex) {
    return JSON.parse(withoutFence.slice(startIndex, endIndex + 1));
  }

  return JSON.parse(withoutFence);
}

function normalizeEntity(entity: unknown): Entity | null {
  if (!entity || typeof entity !== 'object') return null;
  const candidate = entity as Partial<Entity> & {
    fields?: unknown[];
    relations?: unknown[];
    description?: string;
  };

  const normalizedFields: Field[] = [];

  if (Array.isArray(candidate.fields)) {
    for (const field of candidate.fields) {
      if (!field || typeof field !== 'object') continue;
      const value = field as Partial<Field>;
      normalizedFields.push({
        name: typeof value.name === 'string' ? value.name : 'field',
        type: (value.type as Field['type']) ?? 'string',
        required: value.required ?? true,
        default: value.default ?? null,
        children: Array.isArray(value.children) ? value.children : [],
        validation: value.validation ?? {},
        meta: value.meta ?? {},
      });
    }
  }

  if (normalizedFields.length === 0 && typeof candidate.name === 'string') {
    normalizedFields.push(makeField('name', 'string', true));
  }

  return {
    name: typeof candidate.name === 'string' ? candidate.name : 'GeneratedEntity',
    fields: normalizedFields,
    relations: Array.isArray(candidate.relations) ? (candidate.relations as Relation[]) : [],
    description: candidate.description ?? 'Generated entity',
  } satisfies Entity;
}

function normalizeGeneratedProject(raw: unknown, fallback: AiBlueprintProject): AiBlueprintProject {
  if (!raw || typeof raw !== 'object') {
    return fallback;
  }

  const candidate = raw as Partial<AiBlueprintProject> & {
    entities?: unknown[];
    generationConfig?: Partial<GenerationConfig>;
    kind?: string;
  };

  const normalizedEntities = Array.isArray(candidate.entities)
    ? candidate.entities.map(normalizeEntity).filter((entity): entity is Entity => entity !== null)
    : fallback.entities;

  const normalizedGenerationConfig: GenerationConfig = {
    ...DEFAULT_GENERATION_CONFIG,
    ...candidate.generationConfig,
    methods: Array.isArray(candidate.generationConfig?.methods)
      ? (candidate.generationConfig.methods as GenerationConfig['methods'])
      : DEFAULT_GENERATION_CONFIG.methods,
    mockRecords:
      typeof candidate.generationConfig?.mockRecords === 'number'
        ? candidate.generationConfig.mockRecords
        : DEFAULT_GENERATION_CONFIG.mockRecords,
  };

  return {
    kind:
      candidate.kind === 'single' || candidate.kind === 'auth' || candidate.kind === 'project'
        ? candidate.kind
        : 'project',
    name:
      typeof candidate.name === 'string' && candidate.name.trim().length > 0
        ? candidate.name
        : fallback.name,
    description:
      typeof candidate.description === 'string' && candidate.description.trim().length > 0
        ? candidate.description
        : fallback.description,
    entities: normalizedEntities.length > 0 ? normalizedEntities : fallback.entities,
    generationConfig: normalizedGenerationConfig,
  };
}

class GeminiProvider implements LLMProvider {
  async generateStructured<T>(input: AgentInput): Promise<T> {
    const key = process.env['GEMINI_API_KEY'] ?? process.env['GOOGLE_API_KEY'];
    if (!key) {
      throw new Error('GEMINI_API_KEY or GOOGLE_API_KEY is not configured');
    }

    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${encodeURIComponent(key)}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [
            {
              parts: [
                {
                  text: `You are generating a structured project blueprint for an API builder. Return only valid JSON, with no markdown fences. The object should match this shape: { "kind":"project", "name":"Project Name", "description":"...", "entities":[{ "name":"EntityName", "fields":[{ "name":"id","type":"uuid","required":true,"default":null,"children":[],"validation":{},"meta":{"identity":true} }], "relations":[] }], "generationConfig":{"validators":["zod"],"types":["typescript"],"methods":["GET","POST","PATCH","DELETE"],"mockRecords":20,"features":{"search":true,"filter":true,"sort":true,"include":true},"unknownFields":"reject"} }\n\nUser request: ${input.prompt}`,
                },
              ],
            },
          ],
          generationConfig: {
            responseMimeType: 'application/json',
          },
        }),
      },
    );

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Gemini request failed: ${response.status} ${text}`);
    }

    const payload = (await response.json()) as {
      candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
    };

    const text = payload.candidates?.[0]?.content?.parts?.[0]?.text ?? '{}';
    return extractJsonObject(text) as T;
  }
}

export async function structuredAiProjectFromPrompt(prompt: string): Promise<AiBlueprintProject> {
  const cleanedPrompt = prompt.trim();
  const fallback = generateAiBlueprint(cleanedPrompt || 'Create a simple API.');

  const key = process.env['GEMINI_API_KEY'] ?? process.env['GOOGLE_API_KEY'];
  if (!key) {
    return fallback;
  }

  try {
    const provider = new GeminiProvider();
    const raw = await provider.generateStructured<unknown>({
      prompt: cleanedPrompt || 'Create a simple API.',
    });
    return normalizeGeneratedProject(raw, fallback);
  } catch {
    return fallback;
  }
}
