'use client';

/**
 * S2–S4 · New Project wizard (doc 11): Input (Paste JSON | Builder | Swagger)
 * → Configure (validators/types/methods/records) → Review (IPS tree) →
 * Generate. State persists across Back/Next; templates prefill via
 * sessionStorage (S9).
 */

import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  Button,
  Card,
  Checkbox,
  Field,
  Input,
  Select,
  SchemaTree,
  Textarea,
  type SchemaTreeEntity,
} from '@instantmockapi/ui';
import { useCreateProject } from '../../lib/hooks';
import { apiFetch } from '../../lib/api-client';
import type { GenerationConfig, ProjectDetail } from '../../lib/api-types';

const TEMPLATE_KEY = 'instantmockapi.template';

type InputTab = 'json' | 'builder' | 'swagger';

interface BuilderValidation {
  email?: boolean;
  url?: boolean;
  uuid?: boolean;
  unique?: boolean;
  min?: string;
  max?: string;
  length?: string;
  regex?: string;
  arrayMin?: string;
  arrayMax?: string;
  enum?: string[];
  message?: string;
}

interface BuilderField {
  id: string;
  name: string;
  type: string;
  required: boolean;
  default: string;
  validation: BuilderValidation;
  children: BuilderField[];
  showRules?: boolean;
}

interface BuilderEntity {
  id: string;
  name: string;
  fields: BuilderField[];
}

// The full IPS FieldType set (packages/ips/src/types.ts) — the builder can now
// express every type the generators understand, including nested groups.
const FIELD_TYPES = [
  'string',
  'number',
  'decimal',
  'integer',
  'boolean',
  'date',
  'email',
  'url',
  'uuid',
  'enum',
  'object',
  'array',
];

const NUMERIC_TYPES = ['number', 'decimal', 'integer'];
// Root entity fields are depth 1; every object/array descent adds one. Mirrors
// MAX_NESTING_DEPTH (packages/config default 10) so the builder soft-guards
// before the API rejects with DEPTH_LIMIT_EXCEEDED.
const MAX_DEPTH = 10;

let fieldSeq = 0;
function nextId(): string {
  fieldSeq += 1;
  return `n${fieldSeq}`;
}

function newField(name = '', type = 'string'): BuilderField {
  return {
    id: nextId(),
    name,
    type,
    required: true,
    default: '',
    validation: {},
    children: type === 'array' ? [newField('item', 'object')] : [],
  };
}

function newEntity(name = ''): BuilderEntity {
  return { id: nextId(), name, fields: [newField('name')] };
}

const SAMPLE_JSON = JSON.stringify(
  {
    customer: {
      name: 'Ada Lovelace',
      email: 'ada@example.com',
      age: 36,
      address: { city: 'London', zip: 'EC1A' },
    },
  },
  null,
  2,
);

const DEFAULT_CONFIG: GenerationConfig = {
  validators: ['zod'],
  types: ['typescript'],
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
  mockRecords: 25,
};

function toggle(list: string[], value: string): string[] {
  return list.includes(value) ? list.filter((v) => v !== value) : [...list, value];
}

function coerceDefault(field: BuilderField): unknown {
  const value = field.default;
  if (value === '' || value == null) {
    return null;
  }
  if (NUMERIC_TYPES.includes(field.type)) {
    const parsed = Number(value);
    return Number.isNaN(parsed) ? null : parsed;
  }
  if (field.type === 'boolean') {
    return value === 'true';
  }
  return value;
}

function num(value?: string): number | undefined {
  if (value === undefined || value === '' || Number.isNaN(Number(value))) {
    return undefined;
  }
  return Number(value);
}

/** Map the builder's form-shaped validation to the IPS ValidationRules the
 * generators consume (only include keys valid for the field's type). */
function buildValidation(field: BuilderField): Record<string, unknown> {
  const v = field.validation ?? {};
  const out: Record<string, unknown> = {};
  if (field.type === 'string') {
    if (v.email) out.email = true;
    if (v.url) out.url = true;
    if (v.uuid) out.uuid = true;
    if (num(v.length) !== undefined) out.length = num(v.length);
    if (v.regex) out.regex = v.regex;
  }
  if (field.type === 'string' || NUMERIC_TYPES.includes(field.type)) {
    if (num(v.min) !== undefined) out.min = num(v.min);
    if (num(v.max) !== undefined) out.max = num(v.max);
  }
  if (field.type === 'enum') {
    out.enum = (v.enum ?? []).map((s) => s.trim()).filter(Boolean);
  }
  if (field.type === 'array') {
    const arrayLength: Record<string, number> = {};
    if (num(v.arrayMin) !== undefined) arrayLength.min = num(v.arrayMin) as number;
    if (num(v.arrayMax) !== undefined) arrayLength.max = num(v.arrayMax) as number;
    if (Object.keys(arrayLength).length > 0) out.arrayLength = arrayLength;
  }
  if (v.message) out.message = v.message;
  return out;
}

/** Serialize a builder node to an IPS Field. object → all named children;
 * array → the single element definition at children[0]. */
function builderFieldToIPS(field: BuilderField): Record<string, unknown> {
  let children: Record<string, unknown>[] = [];
  if (field.type === 'object') {
    children = field.children.filter((child) => child.name).map(builderFieldToIPS);
  } else if (field.type === 'array' && field.children[0]) {
    children = [builderFieldToIPS(field.children[0])];
  }
  return {
    name: field.name,
    type: field.type,
    required: field.required,
    default: coerceDefault(field),
    children,
    validation: buildValidation(field),
    meta: field.validation?.unique ? { unique: true } : {},
  };
}

/** The API won't reject an enum with no values, but the generated z.enum([])
 * would be invalid — so guard client-side before generate. */
function hasEmptyEnum(fields: BuilderField[]): boolean {
  return fields.some((field) => {
    if (
      field.type === 'enum' &&
      (field.validation.enum ?? []).filter((value) => value.trim()).length === 0
    ) {
      return true;
    }
    return hasEmptyEnum(field.children);
  });
}

/** Layer-1 hint: suggest a string format from a plainly-named field. */
function suggestFor(field: BuilderField): { label: string; patch: BuilderValidation } | null {
  if (field.type !== 'string') {
    return null;
  }
  const name = field.name.toLowerCase();
  if (/email/.test(name) && !field.validation.email) {
    return { label: 'email', patch: { email: true } };
  }
  if (/(url|website|link)/.test(name) && !field.validation.url) {
    return { label: 'url', patch: { url: true } };
  }
  if (/(uuid|guid)/.test(name) && !field.validation.uuid) {
    return { label: 'uuid', patch: { uuid: true } };
  }
  return null;
}

function EnumEditor({
  values,
  onChange,
}: {
  values: string[];
  onChange: (next: string[]) => void;
}) {
  return (
    <div
      className="ui-row"
      style={{ flexWrap: 'wrap', gap: 'var(--space-2)', paddingLeft: 'var(--space-3)' }}
    >
      <span className="ui-meta">enum values:</span>
      {values.map((value, index) => (
        <Input
          key={index}
          value={value}
          placeholder="value"
          onChange={(event) =>
            onChange(
              values.map((existing, position) =>
                position === index ? event.target.value : existing,
              ),
            )
          }
          style={{ maxWidth: 120 }}
        />
      ))}
      <Button variant="ghost" size="sm" onClick={() => onChange([...values, ''])}>
        + value
      </Button>
      {values.length > 0 ? (
        <Button variant="ghost" size="sm" onClick={() => onChange(values.slice(0, -1))}>
          − remove
        </Button>
      ) : null}
    </div>
  );
}

/** Recursive field editor row. Renders its own controls, an optional rules
 * panel, and — for object/array types — a nested child editor. */
function FieldRow({
  field,
  depth,
  removable = true,
  onChange,
  onRemove,
}: {
  field: BuilderField;
  depth: number;
  removable?: boolean;
  onChange: (next: BuilderField) => void;
  onRemove: () => void;
}) {
  const isObject = field.type === 'object';
  const isArray = field.type === 'array';
  const isGroup = isObject || isArray;
  const suggestion = suggestFor(field);
  const element = field.children[0];

  const setValidation = (patch: Partial<BuilderValidation>): void =>
    onChange({ ...field, validation: { ...field.validation, ...patch } });

  const changeType = (type: string): void => {
    const next: BuilderField = { ...field, type };
    if (type === 'array' && field.children.length === 0) {
      next.children = [newField('item', 'object')];
    }
    onChange(next);
  };

  const replaceChild = (childId: string, replacement: BuilderField): void =>
    onChange({
      ...field,
      children: field.children.map((child) => (child.id === childId ? replacement : child)),
    });

  return (
    <div
      className="ui-stack"
      style={{
        gap: 'var(--space-2)',
        borderLeft: depth > 1 ? '2px solid var(--border)' : undefined,
        paddingLeft: depth > 1 ? 'var(--space-3)' : undefined,
      }}
    >
      <div className="ui-row" style={{ flexWrap: 'wrap', alignItems: 'center' }}>
        <Input
          value={field.name}
          placeholder="field name"
          onChange={(event) => onChange({ ...field, name: event.target.value })}
          style={{ maxWidth: 200 }}
        />
        <Select value={field.type} onChange={(event) => changeType(event.target.value)}>
          {FIELD_TYPES.map((type) => (
            <option key={type} value={type}>
              {type}
            </option>
          ))}
        </Select>
        <Checkbox
          checked={field.required}
          label="required"
          onChange={(checked) => onChange({ ...field, required: checked })}
        />
        {!isGroup ? (
          <Input
            value={field.default}
            placeholder="default"
            onChange={(event) => onChange({ ...field, default: event.target.value })}
            style={{ maxWidth: 140 }}
          />
        ) : null}
        <Button
          variant="ghost"
          size="sm"
          onClick={() => onChange({ ...field, showRules: !field.showRules })}
        >
          {field.showRules ? 'Hide rules' : 'Rules'}
        </Button>
        {suggestion ? (
          <Button variant="ghost" size="sm" onClick={() => setValidation(suggestion.patch)}>
            ⚡ {suggestion.label}?
          </Button>
        ) : null}
        <div style={{ flex: 1 }} />
        {removable ? (
          <Button variant="ghost" size="sm" onClick={onRemove} aria-label="Remove field">
            ✕
          </Button>
        ) : null}
      </div>

      {field.showRules ? (
        <div
          className="ui-row"
          style={{ flexWrap: 'wrap', gap: 'var(--space-2)', paddingLeft: 'var(--space-3)' }}
        >
          {field.type === 'string' ? (
            <>
              <Checkbox
                checked={!!field.validation.email}
                label="email"
                onChange={(c) => setValidation({ email: c })}
              />
              <Checkbox
                checked={!!field.validation.url}
                label="url"
                onChange={(c) => setValidation({ url: c })}
              />
              <Checkbox
                checked={!!field.validation.uuid}
                label="uuid"
                onChange={(c) => setValidation({ uuid: c })}
              />
              <Input
                type="number"
                placeholder="min len"
                value={field.validation.min ?? ''}
                onChange={(e) => setValidation({ min: e.target.value })}
                style={{ maxWidth: 100 }}
              />
              <Input
                type="number"
                placeholder="max len"
                value={field.validation.max ?? ''}
                onChange={(e) => setValidation({ max: e.target.value })}
                style={{ maxWidth: 100 }}
              />
              <Input
                type="number"
                placeholder="exact len"
                value={field.validation.length ?? ''}
                onChange={(e) => setValidation({ length: e.target.value })}
                style={{ maxWidth: 100 }}
              />
              <Input
                placeholder="regex"
                value={field.validation.regex ?? ''}
                onChange={(e) => setValidation({ regex: e.target.value })}
                style={{ maxWidth: 160 }}
              />
            </>
          ) : null}
          {NUMERIC_TYPES.includes(field.type) ? (
            <>
              <Input
                type="number"
                placeholder="min"
                value={field.validation.min ?? ''}
                onChange={(e) => setValidation({ min: e.target.value })}
                style={{ maxWidth: 100 }}
              />
              <Input
                type="number"
                placeholder="max"
                value={field.validation.max ?? ''}
                onChange={(e) => setValidation({ max: e.target.value })}
                style={{ maxWidth: 100 }}
              />
            </>
          ) : null}
          {isArray ? (
            <>
              <Input
                type="number"
                placeholder="min items"
                value={field.validation.arrayMin ?? ''}
                onChange={(e) => setValidation({ arrayMin: e.target.value })}
                style={{ maxWidth: 100 }}
              />
              <Input
                type="number"
                placeholder="max items"
                value={field.validation.arrayMax ?? ''}
                onChange={(e) => setValidation({ arrayMax: e.target.value })}
                style={{ maxWidth: 100 }}
              />
            </>
          ) : null}
          <Checkbox
            checked={!!field.validation.unique}
            label="unique"
            onChange={(c) => setValidation({ unique: c })}
          />
          <Input
            placeholder="custom error message"
            value={field.validation.message ?? ''}
            onChange={(e) => setValidation({ message: e.target.value })}
            style={{ maxWidth: 220 }}
          />
        </div>
      ) : null}

      {field.type === 'enum' ? (
        <EnumEditor
          values={field.validation.enum ?? []}
          onChange={(values) => setValidation({ enum: values })}
        />
      ) : null}

      {isObject ? (
        <div className="ui-stack" style={{ gap: 'var(--space-3)', paddingLeft: 'var(--space-3)' }}>
          {field.children.map((child) => (
            <FieldRow
              key={child.id}
              field={child}
              depth={depth + 1}
              onChange={(next) => replaceChild(child.id, next)}
              onRemove={() =>
                onChange({ ...field, children: field.children.filter((c) => c.id !== child.id) })
              }
            />
          ))}
          <div>
            <Button
              variant="secondary"
              size="sm"
              disabled={depth + 1 >= MAX_DEPTH}
              onClick={() => onChange({ ...field, children: [...field.children, newField()] })}
            >
              + field
            </Button>
          </div>
        </div>
      ) : null}

      {isArray ? (
        <div className="ui-stack" style={{ gap: 'var(--space-2)', paddingLeft: 'var(--space-3)' }}>
          <span className="ui-meta">array element</span>
          {element ? (
            <FieldRow
              field={element}
              depth={depth + 1}
              removable={false}
              onChange={(next) => replaceChild(element.id, next)}
              onRemove={() => undefined}
            />
          ) : (
            <div>
              <Button
                variant="secondary"
                size="sm"
                onClick={() => onChange({ ...field, children: [newField('item', 'object')] })}
              >
                + define element
              </Button>
            </div>
          )}
        </div>
      ) : null}
    </div>
  );
}

export default function NewProjectPage() {
  const router = useRouter();
  const createProject = useCreateProject();
  const [step, setStep] = useState<1 | 2 | 3>(1);
  const [name, setName] = useState('');
  const [tab, setTab] = useState<InputTab>('json');
  const [rawJson, setRawJson] = useState(SAMPLE_JSON);
  const [swaggerRaw, setSwaggerRaw] = useState('');
  const [entities, setEntities] = useState<BuilderEntity[]>(() => [newEntity('Customer')]);
  const updateEntity = (id: string, updater: (entity: BuilderEntity) => BuilderEntity): void =>
    setEntities((prev) => prev.map((entity) => (entity.id === id ? updater(entity) : entity)));
  const [config, setConfig] = useState<GenerationConfig>(DEFAULT_CONFIG);
  const [created, setCreated] = useState<ProjectDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // S9 templates prefill the wizard
  useEffect(() => {
    const raw = window.sessionStorage.getItem(TEMPLATE_KEY);
    if (!raw) {
      return;
    }
    window.sessionStorage.removeItem(TEMPLATE_KEY);
    try {
      const template = JSON.parse(raw) as { name: string; json: string };
      setName(template.name);
      setRawJson(template.json);
      setTab('json');
    } catch {
      // ignore malformed template payloads
    }
  }, []);

  const inputSource = useMemo(() => {
    switch (tab) {
      case 'json':
        return { type: 'json', raw: rawJson };
      case 'swagger':
        return { type: 'swagger', raw: swaggerRaw };
      case 'builder':
        return {
          type: 'builder',
          raw: {
            entities: entities
              .filter((entity) => entity.name)
              .map((entity) => ({
                name: entity.name,
                fields: entity.fields.filter((field) => field.name).map(builderFieldToIPS),
              })),
            generationConfig: config,
          },
        };
    }
  }, [tab, rawJson, swaggerRaw, entities, config]);

  async function createAndReview() {
    setError(null);
    if (tab === 'builder') {
      if (!entities.some((entity) => entity.name && entity.fields.some((field) => field.name))) {
        setError('Add at least one entity with a named field.');
        return;
      }
      if (entities.some((entity) => hasEmptyEnum(entity.fields))) {
        setError('Every enum field needs at least one value.');
        return;
      }
    }
    try {
      const project = await createProject.mutateAsync({ name, inputSource });
      setCreated(project);
      setStep(3);
    } catch (cause) {
      setError((cause as Error).message);
    }
  }

  async function generateNow() {
    if (!created) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      // Persist any config edits before generating (bumps the IPS version)
      await apiFetch(`/v1/projects/${created.id}`, {
        method: 'PATCH',
        body: { generationConfig: config },
      });
      const job = await apiFetch<{ jobId: string }>(`/v1/projects/${created.id}/generate`, {
        method: 'POST',
        body: {},
      });
      router.push(`/projects/${created.id}/progress/${job.jobId}`);
    } catch (cause) {
      setError((cause as Error).message);
      setBusy(false);
    }
  }

  return (
    <div className="ui-stack" style={{ gap: 'var(--space-6)' }}>
      <div className="ui-row ui-row--between">
        <h1>New Project</h1>
        <div className="ui-steps">
          {(['Input', 'Configure', 'Review'] as const).map((label, index) => (
            <span
              key={label}
              className={`ui-steps__step ${step === index + 1 ? 'ui-steps__step--active' : ''} ${
                step > index + 1 ? 'ui-steps__step--done' : ''
              }`}
            >
              {index + 1} · {label}
            </span>
          ))}
        </div>
      </div>

      {step === 1 ? (
        <Card className="ui-stack">
          <Field label="Project name">
            <Input
              value={name}
              placeholder="CRM Backend"
              onChange={(event) => setName(event.target.value)}
            />
          </Field>

          <div className="ui-tabs" role="tablist">
            {(
              [
                ['json', 'Paste JSON'],
                ['builder', 'Schema Builder'],
                ['swagger', 'Swagger / OpenAPI'],
              ] as const
            ).map(([value, label]) => (
              <button
                key={value}
                role="tab"
                aria-selected={tab === value}
                onClick={() => setTab(value)}
              >
                {label}
              </button>
            ))}
          </div>

          {tab === 'json' ? (
            <Field label="Sample JSON payload">
              <Textarea
                rows={12}
                value={rawJson}
                onChange={(event) => setRawJson(event.target.value)}
              />
            </Field>
          ) : null}

          {tab === 'swagger' ? (
            <Field label="OpenAPI / Swagger document (JSON or YAML)">
              <Textarea
                rows={12}
                value={swaggerRaw}
                placeholder="Paste your spec here"
                onChange={(event) => setSwaggerRaw(event.target.value)}
              />
            </Field>
          ) : null}

          {tab === 'builder' ? (
            <div className="ui-stack">
              {entities.map((entity) => (
                <Card key={entity.id} className="ui-stack">
                  <div className="ui-row ui-row--between">
                    <Field label="Entity name">
                      <Input
                        value={entity.name}
                        placeholder="Customer"
                        onChange={(event) =>
                          updateEntity(entity.id, (current) => ({
                            ...current,
                            name: event.target.value,
                          }))
                        }
                      />
                    </Field>
                    {entities.length > 1 ? (
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() =>
                          setEntities((prev) => prev.filter((item) => item.id !== entity.id))
                        }
                      >
                        Remove entity
                      </Button>
                    ) : null}
                  </div>
                  <div className="ui-stack" style={{ gap: 'var(--space-3)' }}>
                    {entity.fields.map((field) => (
                      <FieldRow
                        key={field.id}
                        field={field}
                        depth={1}
                        onChange={(next) =>
                          updateEntity(entity.id, (current) => ({
                            ...current,
                            fields: current.fields.map((item) =>
                              item.id === field.id ? next : item,
                            ),
                          }))
                        }
                        onRemove={() =>
                          updateEntity(entity.id, (current) => ({
                            ...current,
                            fields: current.fields.filter((item) => item.id !== field.id),
                          }))
                        }
                      />
                    ))}
                  </div>
                  <div>
                    <Button
                      variant="secondary"
                      size="sm"
                      onClick={() =>
                        updateEntity(entity.id, (current) => ({
                          ...current,
                          fields: [...current.fields, newField()],
                        }))
                      }
                    >
                      + Add field
                    </Button>
                  </div>
                </Card>
              ))}
              <Button
                variant="secondary"
                onClick={() => setEntities((prev) => [...prev, newEntity()])}
              >
                + Add entity
              </Button>
              <p className="ui-meta">
                Objects and arrays nest recursively; open “Rules” on any field for validation
                (min/max, regex, enum values, unique).
              </p>
            </div>
          ) : null}

          <div className="ui-row">
            <Button disabled={!name} onClick={() => setStep(2)}>
              Next
            </Button>
          </div>
        </Card>
      ) : null}

      {step === 2 ? (
        <Card className="ui-stack">
          <h2>Configure generation</h2>
          <Field label="Validation libraries">
            <div className="ui-row">
              {['zod', 'yup', 'jsonschema'].map((validator) => (
                <Checkbox
                  key={validator}
                  checked={config.validators.includes(validator)}
                  label={validator === 'jsonschema' ? 'JSON Schema (advanced)' : validator}
                  onChange={() =>
                    setConfig({ ...config, validators: toggle(config.validators, validator) })
                  }
                />
              ))}
            </div>
          </Field>
          <Field label="Types">
            <Checkbox
              checked={config.types.includes('typescript')}
              label="TypeScript interfaces"
              onChange={() => setConfig({ ...config, types: toggle(config.types, 'typescript') })}
            />
          </Field>
          <Field label="Hosted API methods">
            <div className="ui-row">
              {['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].map((method) => (
                <Checkbox
                  key={method}
                  checked={config.methods.includes(method)}
                  label={<span className="ui-mono">{method}</span>}
                  onChange={() => setConfig({ ...config, methods: toggle(config.methods, method) })}
                />
              ))}
            </div>
          </Field>
          <Field label="Mock records per entity">
            <Input
              type="number"
              min={1}
              max={1000}
              value={config.mockRecords}
              onChange={(event) =>
                setConfig({ ...config, mockRecords: Number(event.target.value) || 25 })
              }
              style={{ maxWidth: 160 }}
            />
          </Field>

          <div className="ui-row">
            <Button variant="secondary" onClick={() => setStep(1)}>
              Back
            </Button>
            <Button
              disabled={createProject.isPending || config.methods.length === 0}
              onClick={() => void createAndReview()}
            >
              {createProject.isPending ? 'Parsing…' : 'Parse & review'}
            </Button>
          </div>
          {error ? (
            <p className="ui-error" role="alert">
              {error}
            </p>
          ) : null}
        </Card>
      ) : null}

      {step === 3 && created ? (
        <Card className="ui-stack">
          <div className="ui-row ui-row--between">
            <h2>Review schema</h2>
            <span className="ui-meta ui-mono">v{created.currentVersion}</span>
          </div>
          <SchemaTree entities={(created.ips as { entities: SchemaTreeEntity[] }).entities ?? []} />
          <div className="ui-meta ui-mono">
            validators: {config.validators.join(', ') || 'none'} · types:{' '}
            {config.types.join(', ') || 'none'} · methods: {config.methods.join(',')} · records:{' '}
            {config.mockRecords}
          </div>
          <div className="ui-row">
            <Button variant="secondary" onClick={() => setStep(2)}>
              Back
            </Button>
            <Button disabled={busy} onClick={() => void generateNow()}>
              {busy ? 'Starting…' : 'Generate'}
            </Button>
          </div>
          {error ? (
            <p className="ui-error" role="alert">
              {error}
            </p>
          ) : null}
        </Card>
      ) : null}
    </div>
  );
}
