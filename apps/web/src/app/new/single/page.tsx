'use client';

/**
 * Single API wizard: Input (Paste JSON | Builder | Swagger) → Configure →
 * Review → Generate.
 *
 * One focused API rather than a related set — the Project flow at
 * `/new/project` is the one that models relationships. State persists across
 * Back/Next; templates prefill via sessionStorage.
 */

import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  Button,
  Card,
  Field,
  FlowScope,
  Input,
  SchemaTree,
  Stepper,
  Textarea,
  type SchemaTreeEntity,
} from '@instantmockapi/ui';
import { useCreateProject } from '../../../lib/hooks';
import { apiFetch } from '../../../lib/api-client';
import type { GenerationConfig, ProjectDetail } from '../../../lib/api-types';
import {
  builderFieldToIPS,
  hasEmptyEnum,
  newEntity,
  newField,
  type BuilderEntity,
} from '../../../lib/builder';
import { FieldRow } from '../../../components/builder/field-row';
import {
  ALL_FEATURES,
  GenerationConfigFields,
} from '../../../components/builder/generation-config';

const TEMPLATE_KEY = 'instantmockapi.template';

type InputTab = 'json' | 'builder' | 'swagger';

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
  features: ALL_FEATURES,
};

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
      const project = await createProject.mutateAsync({ name, kind: 'single', inputSource });
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
    <FlowScope flow="single">
      <div className="ui-row ui-row--between">
        <h1>New Single API</h1>
        <Stepper
          steps={['Input', 'Configure', 'Review']}
          current={step}
          onGoTo={(target) => setStep(target as 1 | 2 | 3)}
        />
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
          <GenerationConfigFields
            config={config}
            onChange={setConfig}
            // A single API has no relations to include.
            showRelations={false}
            recordLabel="Mock records per entity"
          />
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
    </FlowScope>
  );
}
