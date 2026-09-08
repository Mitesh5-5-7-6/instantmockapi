'use client';

/**
 * Auth API wizard — the third project kind (Phase 3 §4, §5).
 *
 *   1 Create Auth API   name, base path, description
 *   2 Endpoints         which of the five, and any extra sign-up fields
 *
 * Two steps rather than the other flows' three and five, because there is no
 * data model to design: an Auth API project has **no entities**, and its whole
 * surface is sign-up, sign-in, refresh, `/me` and logout. `validateIPS` waives
 * its at-least-one-entity rule for this kind, so nothing has to be invented to
 * satisfy a validator.
 *
 * ## Why this is a kind and not a checkbox
 *
 * Someone building a front end against a login screen does not need a product
 * catalogue to exercise it. Before this existed the only way to get the Auth API
 * was to create a project with at least one throwaway entity — which then
 * appeared in the generated OpenAPI, the Postman collection and the hosted
 * index, describing a resource nobody wanted.
 */

import { useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  Badge,
  Button,
  Card,
  Checkbox,
  Field,
  FieldError,
  FlowScope,
  FormError,
  Icon,
  Input,
  Note,
  Select,
  Stepper,
  Textarea,
} from '@instantmockapi/ui';
import { useCreateProject } from '../../../lib/hooks';
import { apiFetch } from '../../../lib/api-client';
import type { AuthUserField } from '../../../lib/api-types';
import { normalizeError } from '../../../lib/errors';
import { notifyFailure } from '../../../lib/toast';
import { useAction } from '../../../lib/use-action';
import { authProblems } from '../../../lib/auth-config';
import {
  AUTH_ENDPOINT_OPTIONS,
  AUTH_PROJECT_MOCK_RECORDS,
  REQUIRED_AUTH_ENDPOINTS,
  authProjectConfig,
  describeAuthProject,
} from '../../../lib/auth-onboarding';
import { basePathToSlug } from '../../../lib/single-api';

const STEPS = ['Create Auth API', 'Endpoints'];

export default function NewAuthApiPage() {
  const router = useRouter();
  const create = useAction(useCreateProject());

  const [step, setStep] = useState(1);
  const [name, setName] = useState('');
  const [basePath, setBasePath] = useState('');
  const [basePathTouched, setBasePathTouched] = useState(false);
  const [description, setDescription] = useState('');

  const [signup, setSignup] = useState(true);
  const [refreshToken, setRefreshToken] = useState(true);
  const [cookieAuth, setCookieAuth] = useState(false);
  const [userFields, setUserFields] = useState<AuthUserField[]>([]);

  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const slug = basePathTouched ? basePathToSlug(basePath) : basePathToSlug(name);

  const config = useMemo(
    () => authProjectConfig({ signup, refreshToken, cookieAuth, userFields }),
    [signup, refreshToken, cookieAuth, userFields],
  );

  // The same validation the Auth tab applies, so the wizard cannot create a
  // project the tab immediately reports as broken.
  const problems = useMemo(() => authProblems({ entities: [], authentication: config }), [config]);

  const updateField = (index: number, patch: Partial<AuthUserField>): void =>
    setUserFields((current) =>
      current.map((field, position) => (position === index ? { ...field, ...patch } : field)),
    );

  const problemFor = (field: string): string | undefined =>
    problems.find((problem) => problem.field === field)?.message;

  function goToStep(target: number): void {
    setError(null);
    if (target > 1 && !name.trim()) {
      setError('Give the API a name.');
      return;
    }
    setStep(target);
  }

  async function generate(): Promise<void> {
    setBusy(true);
    setError(null);

    const project = await create.run({
      name: name.trim(),
      kind: 'auth',
      ...(slug ? { slug } : {}),
      ...(description.trim() ? { description: description.trim() } : {}),
      inputSource: {
        type: 'builder',
        // No entities, which is the whole point of the kind. The generation
        // config still matters — the methods list is what the hosted runtime
        // routes, and an empty one would produce a project that serves nothing
        // even for a future entity.
        raw: {
          entities: [],
          generationConfig: {
            validators: [],
            types: ['typescript'],
            methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
            /*
             * `AUTH_PROJECT_MOCK_RECORDS`, not 0.
             *
             * Nothing is seeded either way — there are no entities — so 0 read
             * as the honest value. It is not: `validateGenerationConfig`
             * requires 1..maxMockRecords on the **generate** path while
             * `validateIPS` accepts any non-negative integer on the **create**
             * path, so 0 created the project and then failed generation with
             * "must be an integer between 1 and 1000".
             *
             * The value also stops being inert the moment somebody adds an
             * entity to this project, which is supported — so it is the
             * ordinary default rather than the smallest number that passes.
             */
            mockRecords: AUTH_PROJECT_MOCK_RECORDS,
            features: { search: false, filter: false, sort: false, include: false },
          },
          authentication: config,
        },
      },
    });

    if (project === null) {
      setBusy(false);
      return;
    }

    try {
      const job = await apiFetch<{ jobId: string }>(`/v1/projects/${project.id}/generate`, {
        method: 'POST',
        body: {},
      });
      router.push(`/projects/${project.id}/progress/${job.jobId}`);
    } catch (cause) {
      notifyFailure({
        ...normalizeError(cause),
        title: 'Auth API created, but generation did not start',
      });
      setBusy(false);
    }
  }

  return (
    <FlowScope flow="single">
      <div className="ui-row ui-row--between">
        <h1>New Auth API</h1>
        <Stepper steps={STEPS} current={step} onGoTo={goToStep} />
      </div>

      {step === 1 ? (
        <Card className="ui-stack">
          <h2>Create Auth API</h2>
          <Note>
            This project is the login flow on its own — sign-up, sign-in, refresh, and the signed-in
            user. There is no data model to design. If you need protected data too, create a Project
            API and turn authentication on there instead.
          </Note>
          <Field label="Name">
            <Input
              value={name}
              placeholder="Store Accounts"
              onChange={(event) => setName(event.target.value)}
            />
          </Field>
          <Field label="Base path" hint={`/p/{aut_id}/${slug || 'base-path'}/signIn`}>
            <Input
              value={basePathTouched ? basePath : slug}
              placeholder="accounts"
              onChange={(event) => {
                setBasePathTouched(true);
                setBasePath(event.target.value);
              }}
            />
          </Field>
          <Field label="Description">
            <Textarea
              value={description}
              rows={3}
              onChange={(event) => setDescription(event.target.value)}
            />
          </Field>
          <div className="ui-row">
            <Button onClick={() => goToStep(2)}>Next</Button>
          </div>
          {error ? <FormError title={error} /> : null}
        </Card>
      ) : null}

      {step === 2 ? (
        <div className="ui-stack">
          <Card className="ui-stack">
            <div className="ui-stack ui-stack--tight">
              <h2>Which endpoints do you need?</h2>
              <p className="ui-meta">
                Three are always generated. The other two are yours to choose.
              </p>
            </div>

            {/* Stated rather than offered: a checkbox for sign-in would be a
                checkbox for an invalid project — nothing could obtain a token
                without it, so every request would 401 forever. */}
            <div className="ui-stack" style={{ gap: 'var(--space-2)' }}>
              {REQUIRED_AUTH_ENDPOINTS.map((endpoint) => (
                <div key={endpoint.route} className="ui-row" style={{ gap: 'var(--space-2)' }}>
                  <span className="ui-mono">{endpoint.route}</span>
                  <Badge variant="neutral">Always</Badge>
                  <span className="ui-meta">{endpoint.note}</span>
                </div>
              ))}
            </div>

            <div className="ui-stack" style={{ gap: 'var(--space-3)' }}>
              {AUTH_ENDPOINT_OPTIONS.map((option) => (
                <div key={option.key} className="ui-stack" style={{ gap: 'var(--space-1)' }}>
                  <Checkbox
                    checked={option.key === 'signup' ? signup : refreshToken}
                    label={`${option.route} — ${option.label}`}
                    onChange={(checked) =>
                      option.key === 'signup' ? setSignup(checked) : setRefreshToken(checked)
                    }
                  />
                  <span className="ui-meta" style={{ paddingLeft: 'var(--space-6)' }}>
                    {option.description}
                  </span>
                </div>
              ))}

              <div className="ui-stack" style={{ gap: 'var(--space-1)' }}>
                <Checkbox
                  checked={cookieAuth}
                  label="Use HttpOnly cookies instead of returning tokens"
                  onChange={setCookieAuth}
                />
                <span className="ui-meta" style={{ paddingLeft: 'var(--space-6)' }}>
                  Browser code cannot read the token, which is safer — but you will not see it in
                  the sign-in response. Leave this off if you are testing with curl or Postman.
                </span>
              </div>
            </div>
          </Card>

          <Card className="ui-stack">
            <div className="ui-stack ui-stack--tight">
              <h2>Any extra fields on sign-up?</h2>
              <p className="ui-meta">
                Email and password are always collected. Add anything else your app needs — a
                display name, a phone number — and it is stored with the account and returned by{' '}
                <span className="ui-mono">GET /me</span>.
              </p>
            </div>

            {userFields.map((field, index) => (
              <div
                key={index}
                className="ui-row"
                style={{ gap: 'var(--space-2)', flexWrap: 'wrap' }}
              >
                <div className="ui-stack" style={{ gap: 'var(--space-1)' }}>
                  <Input
                    value={field.name}
                    placeholder="displayName"
                    onChange={(event) => updateField(index, { name: event.target.value })}
                  />
                  {problemFor(`userFields.${index}.name`) !== undefined ? (
                    <FieldError>{problemFor(`userFields.${index}.name`)}</FieldError>
                  ) : null}
                </div>
                <Select
                  value={field.type}
                  onChange={(event) =>
                    updateField(index, {
                      type: event.target.value as AuthUserField['type'],
                    })
                  }
                >
                  <option value="string">Text</option>
                  <option value="number">Number</option>
                  <option value="boolean">Yes / no</option>
                </Select>
                <Checkbox
                  checked={field.required}
                  label="Required"
                  onChange={(checked) => updateField(index, { required: checked })}
                />
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() =>
                    setUserFields((current) => current.filter((_, position) => position !== index))
                  }
                >
                  <Icon name="trash" size={14} label={`Remove ${field.name || 'field'}`} />
                </Button>
              </div>
            ))}

            <div className="ui-row">
              <Button
                variant="secondary"
                size="sm"
                onClick={() =>
                  setUserFields((current) => [
                    ...current,
                    { name: '', type: 'string', required: false },
                  ])
                }
              >
                <Icon name="plus" size={14} /> Add a field
              </Button>
            </div>
          </Card>

          <Card className="ui-row ui-row--between">
            <span className="ui-meta ui-mono">{describeAuthProject(config)}</span>
            <span className="ui-row">
              <Button variant="secondary" onClick={() => setStep(1)}>
                Back
              </Button>
              <Button
                disabled={busy || create.isPending || problems.length > 0}
                onClick={() => void generate()}
              >
                {busy ? 'Starting…' : 'Generate'}
              </Button>
            </span>
          </Card>

          {problems.length > 0 ? (
            <FormError title="Fix the highlighted fields before generating." />
          ) : null}
          {error ? <FormError title={error} /> : null}
        </div>
      ) : null}
    </FlowScope>
  );
}
