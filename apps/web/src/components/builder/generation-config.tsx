'use client';

/**
 * The Configure Generation step: validators, types, hosted methods, query
 * features, and seed volume.
 *
 * Shared by both creation flows — the Single API flow configures the same
 * generation, so duplicating this panel would mean two places to keep in step
 * with the API's config shape.
 */

import { Checkbox, Field, Input, Note } from '@instantmockapi/ui';
import type { GenerationConfig, QueryFeatures } from '../../lib/api-types';

const VALIDATORS = [
  { value: 'zod', label: 'zod' },
  { value: 'yup', label: 'yup' },
  { value: 'jsonschema', label: 'JSON Schema (advanced)' },
];

const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'];

const FEATURES: { key: keyof QueryFeatures; label: string; hint: string }[] = [
  { key: 'search', label: 'Search', hint: '?search= across text fields' },
  { key: 'filter', label: 'Filter', hint: '?field=value, ?field_gte=…' },
  { key: 'sort', label: 'Sort', hint: '?sort=name,-createdAt' },
  { key: 'include', label: 'Include Relations', hint: '?include=classroom' },
];

/** Every feature on — what a new project starts from, matching the API default. */
export const ALL_FEATURES: QueryFeatures = {
  search: true,
  filter: true,
  sort: true,
  include: true,
};

function toggle(list: string[], value: string): string[] {
  return list.includes(value) ? list.filter((entry) => entry !== value) : [...list, value];
}

export function GenerationConfigFields({
  config,
  onChange,
  /** Relations only exist in the Project flow; the toggle is hidden without them. */
  showRelations = true,
  recordLabel = 'Mock records per entity',
}: {
  config: GenerationConfig;
  onChange: (next: GenerationConfig) => void;
  showRelations?: boolean;
  recordLabel?: string;
}) {
  const features = config.features ?? ALL_FEATURES;
  const setFeature = (key: keyof QueryFeatures, value: boolean): void =>
    onChange({ ...config, features: { ...features, [key]: value } });

  return (
    <>
      <Field label="Validation libraries">
        <div className="ui-row">
          {VALIDATORS.map((validator) => (
            <Checkbox
              key={validator.value}
              checked={config.validators.includes(validator.value)}
              label={validator.label}
              onChange={() =>
                onChange({ ...config, validators: toggle(config.validators, validator.value) })
              }
            />
          ))}
        </div>
      </Field>

      <Field label="Types">
        <Checkbox
          checked={config.types.includes('typescript')}
          label="TypeScript interfaces"
          onChange={() => onChange({ ...config, types: toggle(config.types, 'typescript') })}
        />
      </Field>

      <Field label="Hosted API methods">
        <div className="ui-row">
          {METHODS.map((method) => (
            <Checkbox
              key={method}
              checked={config.methods.includes(method)}
              label={<span className="ui-mono">{method}</span>}
              onChange={() => onChange({ ...config, methods: toggle(config.methods, method) })}
            />
          ))}
        </div>
      </Field>

      <Field label="Features">
        <div className="ui-row" style={{ flexWrap: 'wrap', gap: 'var(--space-4)' }}>
          {FEATURES.filter((feature) => showRelations || feature.key !== 'include').map(
            (feature) => (
              <Checkbox
                key={feature.key}
                checked={features[feature.key]}
                label={
                  <span>
                    {feature.label} <span className="ui-meta ui-mono">{feature.hint}</span>
                  </span>
                }
                onChange={(checked) => setFeature(feature.key, checked)}
              />
            ),
          )}
          {/* Shown as a capability the API has, but not as a choice: pagination
              bounds the response size rather than adding a feature, so there is
              no "off" for it to be switched to. */}
          <Checkbox
            checked
            disabled
            label={
              <span>
                Pagination <span className="ui-meta ui-mono">always on</span>
              </span>
            }
            onChange={() => undefined}
          />
        </div>
      </Field>

      <Note>
        Features only widen what the hosted API accepts — a request that sends no query parameters
        returns the same response either way. You can change them later; each change generates a new
        version.
      </Note>

      <Field label={recordLabel}>
        <Input
          type="number"
          min={1}
          max={1000}
          value={config.mockRecords}
          onChange={(event) =>
            onChange({ ...config, mockRecords: Number(event.target.value) || 25 })
          }
          style={{ maxWidth: 160 }}
        />
      </Field>
    </>
  );
}
