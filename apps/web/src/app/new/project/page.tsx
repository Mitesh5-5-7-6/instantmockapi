'use client';

/**
 * Project API wizard (sample design, PROJECT API FLOW steps 1–4):
 *
 *   1 Create Project      name, slug, description
 *   2 Design Data Model   entities, fields, relationships + ER diagram
 *   3 Configure APIs      which entities get generated
 *   4 Configure Generation validators, methods, query features, seed volume
 *
 * The project is created at the end of step 4 rather than at step 1: creating
 * early would leave a draft row behind every time someone opened the wizard and
 * changed their mind, and the input source is not known until the model is done.
 */

import { useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  Button,
  Card,
  Checkbox,
  Field,
  FlowScope,
  FormError,
  Input,
  Note,
  Select,
  Stepper,
  Textarea,
} from '@instantmockapi/ui';
import { useCreateProject } from '../../../lib/hooks';
import { apiFetch } from '../../../lib/api-client';
import type { GenerationConfig } from '../../../lib/api-types';
import {
  builderFieldToIPS,
  hasEmptyEnum,
  newEntity,
  type BuilderEntity,
  type BuilderField,
} from '../../../lib/builder';
import {
  builderRelationToIPS,
  pruneForGeneration,
  relationTargets,
  relationsPointingAt,
  validateRelations,
} from '../../../lib/relations';
import { EntityCard } from '../../../components/builder/entity-card';
import { PathIndexBuilder } from '../../../lib/error-paths';
import { normalizeError } from '../../../lib/errors';
import { notifyFailure } from '../../../lib/toast';
import { useAction } from '../../../lib/use-action';
import { ErDiagram, ErLegend } from '../../../components/er-diagram';
import {
  ALL_FEATURES,
  GenerationConfigFields,
} from '../../../components/builder/generation-config';

const STEPS = ['Create Project', 'Design Data Model', 'Configure APIs', 'Configure Generation'];

const DEFAULT_CONFIG: GenerationConfig = {
  validators: ['zod'],
  types: ['typescript'],
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
  mockRecords: 25,
  features: ALL_FEATURES,
};

/** Mirrors the API's slugify so the preview matches what gets stored. */
function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}

export default function NewProjectPage() {
  const router = useRouter();
  /**
   * Server field errors from the last attempt, keyed by builder node id.
   *
   * This is the payload of the whole change for this screen: the API answers a
   * failed generate with `entities[1].fields[1].name`, and this is where that
   * becomes a message under the right input instead of "IPS validation failed"
   * under the button.
   */
  const [fieldErrors, setFieldErrors] = useState<ReadonlyMap<string, string[]>>(new Map());
  const create = useAction(useCreateProject(), {
    fields: () => pathIndex,
    onFieldErrors: setFieldErrors,
  });

  const [step, setStep] = useState(1);
  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [slugTouched, setSlugTouched] = useState(false);
  const [description, setDescription] = useState('');
  const [entities, setEntities] = useState<BuilderEntity[]>(() => [newEntity('Student')]);
  const [config, setConfig] = useState<GenerationConfig>(DEFAULT_CONFIG);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // The slug follows the name until it is edited by hand, after which it is the
  // author's — silently rewriting a deliberate slug on the next keystroke of the
  // name would be worse than leaving it stale.
  const effectiveSlug = slugTouched ? slug : slugify(name);

  const targets = useMemo(() => relationTargets(entities), [entities]);
  const relationIssues = useMemo(() => validateRelations(entities), [entities]);

  const updateEntity = (id: string, next: BuilderEntity): void =>
    setEntities((prev) => prev.map((entity) => (entity.id === id ? next : entity)));

  const included = entities.filter((entity) => entity.generate && entity.name.trim());

  function modelProblem(): string | null {
    if (included.length === 0) {
      return 'Add at least one named entity.';
    }
    if (!included.some((entity) => entity.fields.some((field) => field.name.trim()))) {
      return 'Every entity needs at least one named field.';
    }
    const names = included.map((entity) => entity.name.trim());
    const duplicate = names.find((entry, index) => names.indexOf(entry) !== index);
    if (duplicate) {
      return `Two entities are both called '${duplicate}'.`;
    }
    if (entities.some((entity) => hasEmptyEnum(entity.fields))) {
      return 'Every enum field needs at least one value.';
    }
    if (relationIssues.length > 0) {
      return 'Fix the highlighted relationships before continuing.';
    }
    return null;
  }

  function goToStep(target: number): void {
    setError(null);
    if (target > 1 && !name.trim()) {
      setError('Give the project a name.');
      return;
    }
    if (target > 2) {
      const problem = modelProblem();
      if (problem) {
        setError(problem);
        return;
      }
    }
    setStep(target);
  }

  /**
   * Build the builder payload. Pruning is what keeps an excluded entity from
   * failing the whole create: the IPS validator rejects a relation whose target
   * is not declared, so relations into excluded entities go with them.
   */
  const { inputSource, pathIndex } = useMemo(() => {
    const pruned = pruneForGeneration(entities);
    const paths = new PathIndexBuilder();

    const raw = pruned.map((entity, entityPosition) =>
      paths.at('entities', entityPosition, () => {
        paths.claim(entity.id);
        const named = entity.fields.filter((field) => field.name.trim());
        return {
          name: entity.name.trim(),
          identity: { field: 'id', style: entity.identityStyle },
          // Positions claimed while the array is built. Pruning and the
          // name filter both shift indices, so nothing about the finished
          // payload reveals which form row a given index came from.
          fields: named.map((field, offset) =>
            paths.at('fields', offset, () => {
              paths.claim(field.id);
              claimChildPaths(paths, field);
              return builderFieldToIPS(field);
            }),
          ),
          relations: entity.relations.map((relation, offset) =>
            paths.at('relations', offset, () => {
              paths.claim(relation.id);
              return builderRelationToIPS(relation);
            }),
          ),
        };
      }),
    );

    return {
      inputSource: { type: 'builder', raw: { entities: raw, generationConfig: config } },
      pathIndex: paths.build(),
    };
  }, [entities, config]);

  async function generate(): Promise<void> {
    setBusy(true);
    setError(null);
    const project = await create.run({
      name: name.trim(),
      kind: 'project',
      ...(effectiveSlug ? { slug: effectiveSlug } : {}),
      ...(description.trim() ? { description: description.trim() } : {}),
      inputSource,
    });
    if (project === null) {
      // Already routed: inline messages on the offending fields, one toast
      // summarising. Step 2 is where the entity cards are.
      setBusy(false);
      if (fieldErrors.size > 0) {
        setStep(2);
      }
      return;
    }
    try {
      // No config PATCH here, unlike the Single flow: the builder payload already
      // carried this exact config — features block included — through create. A
      // PATCH would bump the project to v2 before its first generation ever ran,
      // leaving a v1 that produced nothing.
      const job = await apiFetch<{ jobId: string }>(`/v1/projects/${project.id}/generate`, {
        method: 'POST',
        body: {},
      });
      router.push(`/projects/${project.id}/progress/${job.jobId}`);
    } catch (cause) {
      // The project exists but generation would not start. A toast rather than
      // an inline block: the project was created, so this is not a form error
      // the user can fix by editing a field.
      notifyFailure({
        ...normalizeError(cause),
        title: 'Project created, but generation did not start',
      });
      setBusy(false);
    }
  }

  return (
    <FlowScope flow="project">
      <div className="ui-row ui-row--between">
        <h1>New Project</h1>
        <Stepper steps={STEPS} current={step} onGoTo={goToStep} />
      </div>

      {step === 1 ? (
        <Card className="ui-stack">
          <h2>Create Project</h2>
          <Field label="Project name">
            <Input
              value={name}
              placeholder="Student ERP"
              onChange={(event) => setName(event.target.value)}
            />
          </Field>
          <Field label="Project slug">
            <Input
              value={effectiveSlug}
              placeholder="student-erp"
              onChange={(event) => {
                setSlugTouched(true);
                setSlug(event.target.value);
              }}
            />
          </Field>
          <p className="ui-meta ui-mono">
            /p/{'{publicId}'}/{effectiveSlug || '{slug}'}/{'{entity}'}
          </p>
          <Note>
            The slug is cosmetic — the hosted URL resolves on the public id, so renaming it later
            never breaks a link anyone has already copied.
          </Note>
          <Field label="Description">
            <Textarea
              rows={3}
              value={description}
              placeholder="Complete Student ERP with relationships"
              onChange={(event) => setDescription(event.target.value)}
            />
          </Field>
          <Field label="Database">
            {/* One option today. Shown, disabled, because the design promises the
                choice — and hiding it would suggest the engine is unspecified. */}
            <Select value="mongodb" disabled onChange={() => undefined}>
              <option value="mongodb">MongoDB (Default)</option>
            </Select>
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
            <div className="ui-row ui-row--between">
              <h2>Entities &amp; Relationships</h2>
              <span className="ui-meta">
                {included.length} {included.length === 1 ? 'entity' : 'entities'}
              </span>
            </div>
            <p className="ui-meta">
              An entity is a resource in your API, such as a customer or product. Add fields to
              describe its data, then connect entities to make related records navigable.
            </p>
            <ErDiagram entities={entities} />
            <ErLegend />
          </Card>

          {entities.map((entity) => (
            <EntityCard
              key={entity.id}
              entity={entity}
              targets={targets}
              issues={relationIssues.filter((issue) => issue.entityId === entity.id)}
              removable={entities.length > 1}
              onChange={(next) => updateEntity(entity.id, next)}
              onRemove={() =>
                setEntities((prev) => prev.filter((candidate) => candidate.id !== entity.id))
              }
            />
          ))}

          <div className="ui-row">
            <Button variant="primary" onClick={() => setEntities((prev) => [...prev, newEntity()])}>
              + Add Entity
            </Button>
            <div style={{ flex: 1 }} />
            <Button variant="secondary" onClick={() => setStep(1)}>
              Back
            </Button>
            <Button onClick={() => goToStep(3)}>Next</Button>
          </div>
        </div>
      ) : null}

      {step === 3 ? (
        <Card className="ui-stack">
          <h2>Configure APIs</h2>
          <p className="ui-meta">
            Every checked entity gets a full CRUD surface. Unchecking one leaves it out of this
            project entirely.
          </p>
          <div className="ui-stack" style={{ gap: 'var(--space-3)' }}>
            {entities
              .filter((entity) => entity.name.trim())
              .map((entity) => {
                const dependents = entity.generate
                  ? relationsPointingAt(entities, entity.name.trim())
                  : [];
                return (
                  <div key={entity.id} className="ui-stack" style={{ gap: 'var(--space-1)' }}>
                    <Checkbox
                      checked={entity.generate}
                      label={entity.name}
                      onChange={(checked) =>
                        updateEntity(entity.id, { ...entity, generate: checked })
                      }
                    />
                    {/* Said before the box is cleared, not discovered afterwards:
                        excluding an entity silently drops the relations into it. */}
                    {dependents.length > 0 ? (
                      <span className="ui-meta" style={{ paddingLeft: 'var(--space-6)' }}>
                        {dependents.length} relationship{dependents.length === 1 ? '' : 's'} point
                        {dependents.length === 1 ? 's' : ''} here (
                        {dependents.map((entry) => `${entry.entity}.${entry.relation}`).join(', ')})
                        — excluding it removes {dependents.length === 1 ? 'that' : 'those'} too.
                      </span>
                    ) : null}
                  </div>
                );
              })}
          </div>
          <div className="ui-row">
            <Button variant="secondary" onClick={() => setStep(2)}>
              Back
            </Button>
            <Button disabled={included.length === 0} onClick={() => goToStep(4)}>
              Next
            </Button>
          </div>
          {error ? <FormError title={error} /> : null}
        </Card>
      ) : null}

      {step === 4 ? (
        <Card className="ui-stack">
          <h2>Configure Generation</h2>
          <GenerationConfigFields config={config} onChange={setConfig} />
          <div className="ui-meta ui-mono">
            {included.length} entities ·{' '}
            {included.reduce((total, entity) => total + entity.relations.length, 0)} relationships ·{' '}
            {config.methods.length} methods
          </div>
          <div className="ui-row">
            <Button variant="secondary" onClick={() => setStep(3)}>
              Back
            </Button>
            <Button
              disabled={busy || create.isPending || config.methods.length === 0}
              onClick={() => void generate()}
            >
              {busy ? 'Starting…' : 'Generate'}
            </Button>
          </div>
          {error ? <FormError title={error} /> : null}
        </Card>
      ) : null}

      {error && step < 3 ? <FormError title={error} /> : null}
    </FlowScope>
  );
}

/**
 * Claim positions for a field's nested children, recursively.
 *
 * `builderFieldToIPS` emits `children` for object and array fields, so a server
 * path can be several levels deep — `entities[0].fields[2].children[0].name`.
 * Without this those resolve only as far as their parent.
 */
function claimChildPaths(paths: PathIndexBuilder, field: BuilderField): void {
  const named = field.children.filter((child) => child.name.trim());
  named.forEach((child, offset) => {
    paths.at('children', offset, () => {
      paths.claim(child.id);
      claimChildPaths(paths, child);
    });
  });
}
