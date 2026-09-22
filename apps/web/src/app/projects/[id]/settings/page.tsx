'use client';

/**
 * The Settings tab.
 *
 * Every field here is backed by `PATCH /v1/projects/:id`, which has accepted
 * `name`, `slug`, `description` and `generationConfig` all along — the web app
 * simply had nowhere to send them. `description` in particular was stored,
 * serialized and rendered nowhere until the workspace header started showing it.
 *
 * ## Three kinds of setting, deliberately separated
 *
 * **Addressing** — name, slug, description — is cosmetic. Changing it never bumps
 * the version and never invalidates a URL anyone has copied, because hosted
 * resolution matches on `publicId` alone.
 *
 * **Publishing** — `autoPublish` — changes who decides when a version goes live,
 * and nothing about what the API does. It is the one setting here that is not
 * part of the definition at all: it lives on the Project rather than in
 * `generationConfig`, so it is never diffed and never bumps a version. Its own
 * card and its own Save for that reason — folding it into Generation would
 * suggest it applies to the version being configured, when it applies to the
 * next generation onward.
 *
 * **Generation** — methods, query features, unknown-field policy — changes what
 * the *next* generation produces. Saving it does not reshape the API that is
 * already hosted, so the form says so rather than letting someone believe a
 * toggle took effect immediately.
 */

import { useEffect, useId, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import {
  Button,
  Card,
  Checkbox,
  Field,
  Input,
  Modal,
  Note,
  Select,
  Textarea,
} from '@instantmockapi/ui';
import { ApiError } from '../../../../lib/api-client';
import {
  useDeleteProject,
  useDuplicateProject,
  useProject,
  useUpdateProject,
} from '../../../../lib/hooks';
import type { QueryFeatures, UnknownFieldPolicy } from '../../../../lib/api-types';

/** Mirrors the API's own allow-list; anything else is rejected server-side. */
const METHOD_OPTIONS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const;

const FEATURE_OPTIONS: { key: keyof QueryFeatures; label: string; hint: string }[] = [
  { key: 'search', label: 'Search', hint: '?search=term across text fields' },
  { key: 'filter', label: 'Filter', hint: '?field=value, with operators like gte and like' },
  { key: 'sort', label: 'Sort', hint: '?sort=-createdAt' },
  { key: 'include', label: 'Include', hint: '?include=relation to expand related records' },
];

const NO_FEATURES: QueryFeatures = { search: false, filter: false, sort: false, include: false };

/**
 * What a write does with a field the schema never declared.
 *
 * Lenient first, and `allow` is what an absent setting means — so a project
 * created before this existed shows the behaviour it actually has rather than a
 * blank control.
 */
const UNKNOWN_FIELD_OPTIONS: { value: UnknownFieldPolicy; label: string }[] = [
  { value: 'allow', label: 'Keep it — stored and returned' },
  { value: 'strip', label: 'Drop it — request succeeds, field discarded' },
  { value: 'reject', label: 'Reject the request — 422 naming the field' },
];

export default function SettingsPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const project = useProject(id);
  const update = useUpdateProject(id);
  const remove = useDeleteProject();
  const duplicate = useDuplicateProject(id);
  const [duplicateName, setDuplicateName] = useState('');

  const nameId = useId();
  const slugId = useId();
  const descriptionId = useId();
  const duplicateNameId = useId();

  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [description, setDescription] = useState('');
  const [methods, setMethods] = useState<string[]>([]);
  const [features, setFeatures] = useState<QueryFeatures>(NO_FEATURES);
  const [unknownFields, setUnknownFields] = useState<UnknownFieldPolicy>('allow');
  // On, matching the project-level default. Overwritten from the loaded project
  // below; this is only what the control shows for the instant before that.
  const [autoPublish, setAutoPublish] = useState(true);
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
      // Absent means `allow` here, not off — the API resolves it the same way.
      setUnknownFields(detail.generationConfig.unknownFields ?? 'allow');
      setAutoPublish(detail.autoPublish);
      setLoaded(true);
    }
  }, [detail, loaded]);

  if (!detail) {
    return <div className="ui-skeleton" style={{ minHeight: 320 }} />;
  }

  const error = update.error instanceof ApiError ? update.error : null;
  const duplicateError = duplicate.error instanceof ApiError ? duplicate.error : null;

  const addressingChanged =
    name !== detail.name ||
    slug !== (detail.slug ?? '') ||
    description !== (detail.description ?? '');

  const generationChanged =
    methods.join(',') !== detail.generationConfig.methods.join(',') ||
    FEATURE_OPTIONS.some(
      (option) =>
        features[option.key] !== (detail.generationConfig.features ?? NO_FEATURES)[option.key],
    ) ||
    unknownFields !== (detail.generationConfig.unknownFields ?? 'allow');

  const publishingChanged = autoPublish !== detail.autoPublish;

  /*
   * Sent on its own, never folded into either Save button above.
   *
   * It is neither addressing nor generation: it changes when this project asks
   * to be published, and nothing about what it serves. Attaching it to the
   * generation save would also imply it takes effect on the version being
   * configured, which it does not — it applies from the next generation on.
   */
  const savePublishing = (): void => {
    update.mutate({ autoPublish });
  };

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
      generationConfig: { ...detail.generationConfig, methods, features, unknownFields },
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
          <h2>Publishing</h2>
          <p className="ui-meta">
            Who decides when a new version goes live. This changes nothing about what the API
            returns.
          </p>
        </div>

        <Field
          label="When a version finishes generating"
          hint="A version that fails to generate is never published either way — this decides whether you are asked, not whether the version can serve."
        >
          <Checkbox
            checked={autoPublish}
            disabled={update.isPending}
            onChange={setAutoPublish}
            label={
              <span>
                Publish it automatically{' '}
                <span className="ui-meta">
                  default — no Publish button to press on the Versions tab
                </span>
              </span>
            }
          />
        </Field>

        {autoPublish ? (
          <Note>
            A change that breaks your callers reaches them as soon as it generates, with no review
            step. Switch this off if anyone other than you calls this API and you want to choose the
            moment.
          </Note>
        ) : (
          <Note variant="warning">
            Every version after the first will stop at READY and wait for you to press Publish on
            the Versions tab. Until you do, callers keep getting the version that is live now.
          </Note>
        )}

        <div className="ui-row" style={{ gap: 'var(--space-2)' }}>
          <Button disabled={!publishingChanged || update.isPending} onClick={savePublishing}>
            {update.isPending ? 'Saving…' : 'Save publishing'}
          </Button>
          {publishingChanged ? (
            <span className="ui-meta">
              Applies from the next generation — a version already waiting still needs Publish
            </span>
          ) : null}
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

        <Field
          label="Undeclared fields on write"
          hint="Applies to POST, PUT and PATCH bodies and to nested objects. The downloaded Zod, Yup, JSON Schema and OpenAPI all state whichever rule you pick."
        >
          <Select
            value={unknownFields}
            disabled={update.isPending}
            onChange={(event) => setUnknownFields(event.target.value as UnknownFieldPolicy)}
            style={{ maxWidth: 400 }}
          >
            {UNKNOWN_FIELD_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </Select>
        </Field>

        {/* The two directions that hurt, named rather than generically warned
            about — switching to `reject` is the only setting on this page that
            can 422 a request that worked, and `strip` is the only one that can
            make data quietly stop coming back. */}
        {unknownFields !== (detail.generationConfig.unknownFields ?? 'allow') &&
        unknownFields !== 'allow' ? (
          <Note variant="warning">
            {unknownFields === 'reject'
              ? 'Callers currently sending an extra field will start getting 422 once this is generated and published.'
              : 'Extra fields already stored on existing records keep being returned; new writes will drop them.'}
          </Note>
        ) : null}

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

      {/*
       * Duplicate sits with the project's own lifecycle, not in the Docs tab.
       *
       * It runs through the blueprint pathway (§19) and the Docs tab is where
       * blueprints are exported, so grouping them there was tempting. But Docs
       * holds *documents about* the project, and this makes a new project —
       * which is the same category of action as Delete, and §18 asks these to
       * live in one predictable place rather than being scattered.
       */}
      <Card className="ui-stack">
        <div>
          <h2>Duplicate project</h2>
          <p className="ui-meta">
            Creates a new project with the same entities, relationships, authentication settings and
            generation options. Nothing else comes across: the copy gets its own hosted URL, its own
            credentials, and none of this project&rsquo;s users, sessions or mock records. It starts
            as a draft, so nothing is generated until you say so.
          </p>
        </div>
        <Field label="Name for the copy" htmlFor={duplicateNameId}>
          <Input
            id={duplicateNameId}
            value={duplicateName}
            placeholder={`${detail.name} (copy)`}
            maxLength={120}
            onChange={(event) => setDuplicateName(event.target.value)}
          />
        </Field>
        <div className="ui-row">
          <Button
            variant="secondary"
            disabled={duplicate.isPending}
            onClick={() => {
              void duplicate
                .mutateAsync(duplicateName.trim() === '' ? {} : { name: duplicateName.trim() })
                .then((copy) => {
                  router.push(`/projects/${copy.id}`);
                })
                .catch(() => {
                  // Swallowed on purpose: nothing was created, so there is
                  // nowhere to navigate. The Note below reports why.
                });
            }}
          >
            {duplicate.isPending ? 'Duplicating…' : 'Duplicate this project'}
          </Button>
        </div>

        {/*
         * Duplicating can genuinely fail, and silently failing here would be
         * the worst outcome: the user waits for a page that never arrives.
         *
         * Two real cases. The plan limit — a duplicate is a create, so an
         * account at its ceiling is refused. And a definition that no longer
         * validates: the blueprint pathway re-checks the canonical rules, so a
         * project whose stored schema has drifted is refused with the field
         * named, which is exactly what the owner needs to fix the original.
         */}
        {duplicateError ? (
          <Note variant="warning">
            <strong>{duplicateError.message}</strong>
            {duplicateError.details?.length ? (
              <ul style={{ margin: 'var(--space-2) 0 0', paddingLeft: 'var(--space-4)' }}>
                {duplicateError.details.map((issue) => (
                  <li key={`${issue.path}:${issue.issue}`}>
                    <span className="ui-mono">{issue.path}</span> — {issue.issue}
                  </li>
                ))}
              </ul>
            ) : null}
          </Note>
        ) : null}
      </Card>

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
