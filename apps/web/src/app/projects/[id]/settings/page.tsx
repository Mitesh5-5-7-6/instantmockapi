'use client';

/**
 * The Settings tab.
 *
 * Every field here is backed by `PATCH /v1/projects/:id`, which has accepted
 * `name`, `slug`, `description` and `generationConfig` all along — the web app
 * simply had nowhere to send them. `description` in particular was stored,
 * serialized and rendered nowhere until the workspace header started showing it.
 *
 * ## Two kinds of setting, deliberately separated
 *
 * **Addressing** — name, slug, description — is cosmetic. Changing it never bumps
 * the version and never invalidates a URL anyone has copied, because hosted
 * resolution matches on `publicId` alone.
 *
 * **Generation** — methods, query features — changes what the *next* generation
 * produces. Saving it does not reshape the API that is already hosted, so the
 * form says so rather than letting someone believe a toggle took effect
 * immediately.
 */

import { useEffect, useId, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { Button, Card, Checkbox, Field, Input, Modal, Note, Textarea } from '@instantmockapi/ui';
import { ApiError } from '../../../../lib/api-client';
import { useDeleteProject, useProject, useUpdateProject } from '../../../../lib/hooks';
import type { QueryFeatures } from '../../../../lib/api-types';

/** Mirrors the API's own allow-list; anything else is rejected server-side. */
const METHOD_OPTIONS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const;

const FEATURE_OPTIONS: { key: keyof QueryFeatures; label: string; hint: string }[] = [
  { key: 'search', label: 'Search', hint: '?search=term across text fields' },
  { key: 'filter', label: 'Filter', hint: '?field=value, with operators like gte and like' },
  { key: 'sort', label: 'Sort', hint: '?sort=-createdAt' },
  { key: 'include', label: 'Include', hint: '?include=relation to expand related records' },
];

const NO_FEATURES: QueryFeatures = { search: false, filter: false, sort: false, include: false };

export default function SettingsPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const project = useProject(id);
  const update = useUpdateProject(id);
  const remove = useDeleteProject();

  const nameId = useId();
  const slugId = useId();
  const descriptionId = useId();

  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [description, setDescription] = useState('');
  const [methods, setMethods] = useState<string[]>([]);
  const [features, setFeatures] = useState<QueryFeatures>(NO_FEATURES);
  const [loaded, setLoaded] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const detail = project.data;

  // Seeded once, then left alone. Re-syncing on every refetch — and this page
  // refetches after its own save — would discard whatever the user is part-way
  // through typing in another field.
  useEffect(() => {
    if (detail && !loaded) {
      setName(detail.name);
      setSlug(detail.slug ?? '');
      setDescription(detail.description ?? '');
      setMethods(detail.generationConfig.methods);
      // Absent on every project generated before the query layer, which means
      // all off rather than undefined.
      setFeatures(detail.generationConfig.features ?? NO_FEATURES);
      setLoaded(true);
    }
  }, [detail, loaded]);

  if (!detail) {
    return <div className="ui-skeleton" style={{ minHeight: 320 }} />;
  }

  const error = update.error instanceof ApiError ? update.error : null;

  const addressingChanged =
    name !== detail.name ||
    slug !== (detail.slug ?? '') ||
    description !== (detail.description ?? '');

  const generationChanged =
    methods.join(',') !== detail.generationConfig.methods.join(',') ||
    FEATURE_OPTIONS.some(
      (option) =>
        features[option.key] !== (detail.generationConfig.features ?? NO_FEATURES)[option.key],
    );

  const saveAddressing = (): void => {
    update.mutate({
      name,
      // Sent as an empty string rather than omitted when cleared — the API
      // distinguishes "not provided" from "set to empty", and omitting it would
      // silently keep the old value.
      description,
      ...(slug !== '' ? { slug } : {}),
    });
  };

  const saveGeneration = (): void => {
    update.mutate({
      // A full replacement, not a patch: the API validates the whole block, so
      // sending only `methods` would switch every feature off.
      generationConfig: { ...detail.generationConfig, methods, features },
    });
  };

  return (
    <div className="ui-stack">
      <Card className="ui-stack">
        <div>
          <h2>Project details</h2>
          <p className="ui-meta">
            Naming and addressing only. Changing these never bumps the version, and never breaks a
            hosted URL someone has already copied.
          </p>
        </div>

        <Field label="Name" htmlFor={nameId}>
          <Input
            id={nameId}
            value={name}
            maxLength={120}
            onChange={(event) => setName(event.target.value)}
            disabled={update.isPending}
          />
        </Field>

        <Field
          label="Description"
          htmlFor={descriptionId}
          hint="Shown under the project title. Optional."
        >
          <Textarea
            id={descriptionId}
            value={description}
            maxLength={500}
            rows={3}
            onChange={(event) => setDescription(event.target.value)}
            disabled={update.isPending}
          />
        </Field>

        <Field
          label="URL slug"
          htmlFor={slugId}
          hint="Lower-case words separated by hyphens. Cosmetic — the hosted URL resolves on its id, so renaming this cannot break an existing link."
        >
          <Input
            id={slugId}
            value={slug}
            maxLength={60}
            placeholder="e-commerce-api"
            onChange={(event) => setSlug(event.target.value)}
            disabled={update.isPending}
          />
        </Field>

        <div className="ui-row" style={{ gap: 'var(--space-2)' }}>
          <Button disabled={!addressingChanged || update.isPending} onClick={saveAddressing}>
            {update.isPending ? 'Saving…' : 'Save details'}
          </Button>
          {addressingChanged ? <span className="ui-meta">Unsaved changes</span> : null}
        </div>
      </Card>

      <Card className="ui-stack">
        <div>
          <h2>Generation</h2>
          <p className="ui-meta">
            What the next generation produces. Saving these does not change the API that is
            currently hosted.
          </p>
        </div>

        <Field label="HTTP methods" hint="Each enabled method becomes real endpoints per entity.">
          <div className="settings-toggles">
            {METHOD_OPTIONS.map((method) => (
              <Checkbox
                key={method}
                checked={methods.includes(method)}
                disabled={update.isPending}
                onChange={(checked) =>
                  setMethods((current) =>
                    checked
                      ? // Kept in the canonical order rather than click order, so
                        // the saved value is stable and the header reads the same
                        // however the boxes were ticked.
                        METHOD_OPTIONS.filter(
                          (entry) => entry === method || current.includes(entry),
                        )
                      : current.filter((entry) => entry !== method),
                  )
                }
                label={<span className="ui-mono">{method}</span>}
              />
            ))}
          </div>
        </Field>

        <Field
          label="Query capabilities"
          hint="Turning one on only widens what the hosted API accepts — a request sending no query parameters returns identical output either way."
        >
          <div className="ui-stack ui-stack--tight">
            {FEATURE_OPTIONS.map((option) => (
              <Checkbox
                key={option.key}
                checked={features[option.key]}
                disabled={update.isPending}
                onChange={(checked) =>
                  setFeatures((current) => ({ ...current, [option.key]: checked }))
                }
                label={
                  <span>
                    {option.label} <span className="ui-meta ui-mono">{option.hint}</span>
                  </span>
                }
              />
            ))}
          </div>
        </Field>

        {methods.length === 0 ? (
          <Note variant="warning">
            With no methods enabled this project generates no endpoints and cannot be hosted.
          </Note>
        ) : null}

        <div className="ui-row" style={{ gap: 'var(--space-2)' }}>
          <Button disabled={!generationChanged || update.isPending} onClick={saveGeneration}>
            {update.isPending ? 'Saving…' : 'Save generation settings'}
          </Button>
          {generationChanged ? (
            <span className="ui-meta">Regenerate to apply these to the hosted API</span>
          ) : null}
        </div>
      </Card>

      {error ? (
        <Note variant="warning">
          <strong>{error.message}</strong>
          {error.details?.length ? (
            <ul style={{ margin: 'var(--space-2) 0 0', paddingLeft: 'var(--space-4)' }}>
              {error.details.map((issue) => (
                <li key={`${issue.path}:${issue.issue}`}>
                  <span className="ui-mono">{issue.path}</span> — {issue.issue}
                </li>
              ))}
            </ul>
          ) : null}
        </Note>
      ) : null}

      {update.isSuccess && !addressingChanged && !generationChanged ? (
        <Note variant="info">Saved.</Note>
      ) : null}

      <Card className="ui-stack settings-danger">
        <div>
          <h2>Delete project</h2>
          <p className="ui-meta">
            Removes the project, its generated files, its mock data and its request history. The
            hosted URL stops resolving immediately. This cannot be undone.
          </p>
        </div>
        <div className="ui-row">
          <Button variant="danger" onClick={() => setConfirmDelete(true)}>
            Delete this project
          </Button>
        </div>
      </Card>

      <Modal
        open={confirmDelete}
        onClose={() => setConfirmDelete(false)}
        title={`Delete ${detail.name}?`}
      >
        <div className="ui-stack">
          <p className="ui-meta">
            Everything generated for this project goes with it, and the hosted URL stops working
            straight away.
          </p>
          <div className="ui-row" style={{ gap: 'var(--space-2)' }}>
            <Button variant="secondary" onClick={() => setConfirmDelete(false)}>
              Keep it
            </Button>
            <Button
              variant="danger"
              disabled={remove.isPending}
              onClick={() => remove.mutate(id, { onSuccess: () => router.replace('/projects') })}
            >
              {remove.isPending ? 'Deleting…' : 'Delete permanently'}
            </Button>
          </div>
        </div>
      </Modal>
    </div>
  );
}
