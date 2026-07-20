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

interface BuilderField {
  name: string;
  type: string;
  required: boolean;
}

interface BuilderEntity {
  name: string;
  fields: BuilderField[];
}

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
];

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

function builderToFields(entity: BuilderEntity) {
  return entity.fields
    .filter((field) => field.name)
    .map((field) => ({
      name: field.name,
      type: field.type,
      required: field.required,
      default: null,
      children: [],
      validation: {},
      meta: {},
    }));
}

export default function NewProjectPage() {
  const router = useRouter();
  const createProject = useCreateProject();
  const [step, setStep] = useState<1 | 2 | 3>(1);
  const [name, setName] = useState('');
  const [tab, setTab] = useState<InputTab>('json');
  const [rawJson, setRawJson] = useState(SAMPLE_JSON);
  const [swaggerRaw, setSwaggerRaw] = useState('');
  const [entities, setEntities] = useState<BuilderEntity[]>([
    { name: 'Customer', fields: [{ name: 'name', type: 'string', required: true }] },
  ]);
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
              .map((entity) => ({ name: entity.name, fields: builderToFields(entity) })),
            generationConfig: config,
          },
        };
    }
  }, [tab, rawJson, swaggerRaw, entities, config]);

  async function createAndReview() {
    setError(null);
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
              {entities.map((entity, entityIndex) => (
                <Card key={entityIndex} className="ui-stack">
                  <Field label="Entity name">
                    <Input
                      value={entity.name}
                      onChange={(event) => {
                        const next = [...entities];
                        next[entityIndex] = { ...entity, name: event.target.value };
                        setEntities(next);
                      }}
                    />
                  </Field>
                  {entity.fields.map((field, fieldIndex) => (
                    <div className="ui-row" key={fieldIndex}>
                      <Input
                        value={field.name}
                        placeholder="field name"
                        onChange={(event) => {
                          const next = [...entities];
                          const fields = [...entity.fields];
                          fields[fieldIndex] = { ...field, name: event.target.value };
                          next[entityIndex] = { ...entity, fields };
                          setEntities(next);
                        }}
                      />
                      <Select
                        value={field.type}
                        onChange={(event) => {
                          const next = [...entities];
                          const fields = [...entity.fields];
                          fields[fieldIndex] = { ...field, type: event.target.value };
                          next[entityIndex] = { ...entity, fields };
                          setEntities(next);
                        }}
                      >
                        {FIELD_TYPES.map((type) => (
                          <option key={type} value={type}>
                            {type}
                          </option>
                        ))}
                      </Select>
                      <Checkbox
                        checked={field.required}
                        label="required"
                        onChange={(checked) => {
                          const next = [...entities];
                          const fields = [...entity.fields];
                          fields[fieldIndex] = { ...field, required: checked };
                          next[entityIndex] = { ...entity, fields };
                          setEntities(next);
                        }}
                      />
                    </div>
                  ))}
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => {
                      const next = [...entities];
                      next[entityIndex] = {
                        ...entity,
                        fields: [...entity.fields, { name: '', type: 'string', required: true }],
                      };
                      setEntities(next);
                    }}
                  >
                    Add field
                  </Button>
                </Card>
              ))}
              <Button
                variant="secondary"
                onClick={() => setEntities([...entities, { name: '', fields: [] }])}
              >
                Add entity
              </Button>
              <p className="ui-meta">
                Nested objects/arrays and per-field validation rules can be added after parsing — or
                express them directly in the Paste JSON tab.
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
