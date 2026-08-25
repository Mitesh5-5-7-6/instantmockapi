'use client';

/**
 * Single API wizard (sample design, SINGLE API FLOW steps 1–3):
 *
 *   1 Create Single API    name, base path, description
 *   2 Define Endpoints     endpoint rows — or paste JSON / import a spec
 *   3 Configure & Generate validators, methods, features, seed volume
 *
 * "Base Path" is the project slug: a Single API advertises
 * `/p/{sng_id}/{basePath}/{endpoint}`, which is the pretty URL from Phase 3
 * rather than a new addressing concept.
 *
 * Paste-JSON and Swagger survive as alternative ways to define the same
 * endpoints. The design only draws the hand-authored path, but dropping the
 * importers would remove working capability for a screen that has room for a
 * tab strip.
 */

import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button, Card, Field, FlowScope, Input, Note, Stepper, Textarea } from '@instantmockapi/ui';
import { useCreateProject } from '../../../lib/hooks';
import { apiFetch } from '../../../lib/api-client';
import type { GenerationConfig } from '../../../lib/api-types';
import {
  basePathToSlug,
  endpointsToEntities,
  newEndpoint,
  validateEndpoints,
  type SingleEndpoint,
} from '../../../lib/single-api';
import { EndpointCard } from '../../../components/builder/endpoint-card';
import {
  ALL_FEATURES,
  GenerationConfigFields,
} from '../../../components/builder/generation-config';

const TEMPLATE_KEY = 'instantmockapi.template';

const STEPS = ['Create Single API', 'Define Endpoints', 'Configure & Generate'];

type InputTab = 'endpoints' | 'json' | 'swagger';

const SAMPLE_JSON = JSON.stringify(
  {
    current: {
      city: 'London',
      temperature: 18,
      condition: 'Cloudy',
      wind: 12,
      humidity: 68,
    },
  },
  null,
  2,
);

const DEFAULT_CONFIG: GenerationConfig = {
  validators: ['zod'],
  types: ['typescript'],
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
  mockRecords: 20,
  features: ALL_FEATURES,
};

export default function NewSingleApiPage() {
  const router = useRouter();
  const createProject = useCreateProject();

  const [step, setStep] = useState(1);
  const [name, setName] = useState('');
  const [basePath, setBasePath] = useState('');
  const [basePathTouched, setBasePathTouched] = useState(false);
  const [description, setDescription] = useState('');
  const [tab, setTab] = useState<InputTab>('endpoints');
  const [endpoints, setEndpoints] = useState<SingleEndpoint[]>(() => [newEndpoint('current')]);
  const [rawJson, setRawJson] = useState(SAMPLE_JSON);
  const [swaggerRaw, setSwaggerRaw] = useState('');
  const [config, setConfig] = useState<GenerationConfig>(DEFAULT_CONFIG);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Follows the name until edited by hand, after which the author owns it.
  const slug = basePathTouched ? basePathToSlug(basePath) : basePathToSlug(name);
  const endpointIssues = useMemo(() => validateEndpoints(endpoints), [endpoints]);

  // Templates prefill the paste-JSON path.
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
    if (tab === 'json') {
      return { type: 'json', raw: rawJson };
    }
    if (tab === 'swagger') {
      return { type: 'swagger', raw: swaggerRaw };
    }
    return {
      type: 'builder',
      raw: { entities: endpointsToEntities(endpoints), generationConfig: config },
    };
  }, [tab, rawJson, swaggerRaw, endpoints, config]);

  function endpointProblem(): string | null {
    if (tab !== 'endpoints') {
      return null;
    }
    const named = endpoints.filter((endpoint) => endpoint.name.trim());
    if (named.length === 0) {
      return 'Add at least one named endpoint.';
    }
    if (!named.some((endpoint) => endpoint.fields.some((field) => field.name.trim()))) {
      return 'Every endpoint needs at least one named field.';
    }
    if (endpointIssues.length > 0) {
      return 'Fix the highlighted endpoints before continuing.';
    }
    return null;
  }

  function goToStep(target: number): void {
    setError(null);
    if (target > 1 && !name.trim()) {
      setError('Give the API a name.');
      return;
    }
    if (target > 2) {
      const problem = endpointProblem();
      if (problem) {
        setError(problem);
        return;
      }
    }
    setStep(target);
  }

  async function generate(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      const project = await createProject.mutateAsync({
        name: name.trim(),
        kind: 'single',
        ...(slug ? { slug } : {}),
        ...(description.trim() ? { description: description.trim() } : {}),
        inputSource,
      });
      // The JSON and Swagger paths let their parser derive the config, so the
      // toggles chosen on step 3 are pinned here. The endpoints path already
      // carried this config through create, but PATCHing it again is harmless
      // and keeps one code path for all three inputs.
      if (tab !== 'endpoints') {
        await apiFetch(`/v1/projects/${project.id}`, {
          method: 'PATCH',
          body: { generationConfig: config },
        });
      }
      const job = await apiFetch<{ jobId: string }>(`/v1/projects/${project.id}/generate`, {
        method: 'POST',
        body: {},
      });
      router.push(`/projects/${project.id}/progress/${job.jobId}`);
    } catch (cause) {
      setError((cause as Error).message);
      setBusy(false);
    }
  }

  const updateEndpoint = (id: string, next: SingleEndpoint): void =>
    setEndpoints((prev) => prev.map((endpoint) => (endpoint.id === id ? next : endpoint)));

  return (
    <FlowScope flow="single">
      <div className="ui-row ui-row--between">
        <h1>New Single API</h1>
        <Stepper steps={STEPS} current={step} onGoTo={goToStep} />
      </div>

      {step === 1 ? (
        <Card className="ui-stack">
          <h2>Create Single API</h2>
          <Field label="API name">
            <Input
              value={name}
              placeholder="Weather API"
              onChange={(event) => setName(event.target.value)}
            />
          </Field>
          <Field label="Base path (optional)">
            <Input
              value={basePathTouched ? basePath : slug}
              placeholder="/weather"
              onChange={(event) => {
                setBasePathTouched(true);
                setBasePath(event.target.value);
              }}
            />
          </Field>
          <p className="ui-meta ui-mono">
            /p/{'{publicId}'}/{slug || '{slug}'}/{'{endpoint}'}
          </p>
          <Note>
            The base path is one URL segment. It is cosmetic — the hosted URL resolves on the public
            id, so changing it later never breaks a link already in use.
          </Note>
          <Field label="Description">
            <Textarea
              rows={3}
              value={description}
              placeholder="Get current weather information by city"
              onChange={(event) => setDescription(event.target.value)}
            />
          </Field>
          <div className="ui-row">
            <Button disabled={!name.trim()} onClick={() => goToStep(2)}>
              Next
            </Button>
          </div>
        </Card>
      ) : null}

      {step === 2 ? (
        <div className="ui-stack" style={{ gap: 'var(--space-4)' }}>
          <Card className="ui-stack">
            <h2>Define Endpoints</h2>
            <div className="ui-tabs" role="tablist">
              {(
                [
                  ['endpoints', 'Endpoints'],
                  ['json', 'Paste JSON'],
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
                  rows={14}
                  value={rawJson}
                  onChange={(event) => setRawJson(event.target.value)}
                />
              </Field>
            ) : null}

            {tab === 'swagger' ? (
              <Field label="OpenAPI / Swagger document (JSON or YAML)">
                <Textarea
                  rows={14}
                  value={swaggerRaw}
                  placeholder="Paste your spec here"
                  onChange={(event) => setSwaggerRaw(event.target.value)}
                />
              </Field>
            ) : null}

            {tab === 'endpoints' ? (
              <p className="ui-meta">
                Each endpoint becomes its own resource with a full CRUD surface at its own path.
              </p>
            ) : null}
          </Card>

          {tab === 'endpoints'
            ? endpoints.map((endpoint) => (
                <EndpointCard
                  key={endpoint.id}
                  endpoint={endpoint}
                  basePath={slug}
                  issues={endpointIssues.filter((issue) => issue.endpointId === endpoint.id)}
                  removable={endpoints.length > 1}
                  onChange={(next) => updateEndpoint(endpoint.id, next)}
                  onRemove={() =>
                    setEndpoints((prev) => prev.filter((item) => item.id !== endpoint.id))
                  }
                />
              ))
            : null}

          <div className="ui-row">
            {tab === 'endpoints' ? (
              <Button
                variant="secondary"
                onClick={() => setEndpoints((prev) => [...prev, newEndpoint()])}
              >
                + Add Endpoint
              </Button>
            ) : null}
            <div style={{ flex: 1 }} />
            <Button variant="secondary" onClick={() => setStep(1)}>
              Back
            </Button>
            <Button onClick={() => goToStep(3)}>Next</Button>
          </div>
          {error ? (
            <p className="ui-error" role="alert">
              {error}
            </p>
          ) : null}
        </div>
      ) : null}

      {step === 3 ? (
        <Card className="ui-stack">
          <h2>Configure &amp; Generate</h2>
          <GenerationConfigFields
            config={config}
            onChange={setConfig}
            // A single API declares no relations, so there is nothing to include.
            showRelations={false}
            recordLabel="Mock records per endpoint"
          />
          {/* Stated rather than offered as a choice: the runtime serves JSON
              only, and a permanently-disabled XML checkbox would advertise a
              format that does not exist. */}
          <Note>Responses are JSON. XML is not available.</Note>
          <div className="ui-row">
            <Button variant="secondary" onClick={() => setStep(2)}>
              Back
            </Button>
            <Button
              disabled={busy || createProject.isPending || config.methods.length === 0}
              onClick={() => void generate()}
            >
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

      {error && step === 1 ? (
        <p className="ui-error" role="alert">
          {error}
        </p>
      ) : null}
    </FlowScope>
  );
}
