'use client';

/**
 * Recursive field editor for the schema builder.
 *
 * Lifted out of the wizard page unchanged in behaviour, plus the `searchable`
 * opt-in the query layer reads. The row renders its own controls, an optional
 * rules panel, and — for object/array types — a nested editor for its children.
 */

import { Button, Checkbox, FieldError, Icon, Input, Select } from '@instantmockapi/ui';
import {
  FIELD_TYPES,
  MAX_DEPTH,
  NUMERIC_TYPES,
  TEXTUAL_TYPES,
  newField,
  suggestFor,
  type BuilderField,
  type BuilderValidation,
} from '../../lib/builder';

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

export function FieldRow({
  field,
  depth,
  removable = true,
  onChange,
  onRemove,
  errors,
}: {
  field: BuilderField;
  depth: number;
  removable?: boolean;
  onChange: (next: BuilderField) => void;
  onRemove: () => void;
  /**
   * Server-reported problems, keyed by builder node id.
   *
   * The whole map is passed down rather than this row's own messages, because a
   * nested child needs its own and only the map can carry them. Undefined when
   * the form has no server errors to show, which is the ordinary case.
   */
  errors?: ReadonlyMap<string, string[]> | undefined;
}) {
  const isObject = field.type === 'object';
  const isArray = field.type === 'array';
  const isGroup = isObject || isArray;
  const suggestion = suggestFor(field);
  const element = field.children[0];

  const fieldErrors = errors?.get(field.id) ?? [];

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
          // Marked on the control the message belongs to, so a reader is not
          // left matching a message at the bottom of a form to one of many rows.
          aria-invalid={fieldErrors.length > 0 ? true : undefined}
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
            <Icon name="zap" size={14} /> {suggestion.label}?
          </Button>
        ) : null}
        <div style={{ flex: 1 }} />
        {removable ? (
          <Button variant="ghost" size="sm" onClick={onRemove} aria-label="Remove field">
            <Icon name="x" size={14} />
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
          {/* Offered only where it has an effect: search compares textual
              scalars, so the flag is dropped elsewhere on serialization. */}
          {TEXTUAL_TYPES.includes(field.type) ? (
            <Checkbox
              checked={!!field.validation.searchable}
              label="searchable"
              onChange={(c) => setValidation({ searchable: c })}
            />
          ) : null}
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

      {/*
        Under the row they belong to. This is the difference the whole change is
        about: "IPS validation failed" at the bottom of a form told the user
        nothing about which of their fields the server rejected.
      */}
      {fieldErrors.map((issue) => (
        <FieldError key={issue}>{issue}</FieldError>
      ))}

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
              errors={errors}
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
              errors={errors}
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
