'use client';

/**
 * SchemaTree — an entity's fields, nested.
 *
 * Not a shadcn component. shadcn's `Tree` is a file-browser with expand state;
 * this is a read-only rendering of a schema, and every field is always visible
 * because the point is to see the whole shape at once.
 */

import { cn } from '../lib/utils.js';

export interface SchemaTreeField {
  name: string;
  type: string;
  required: boolean;
  children: SchemaTreeField[];
  validation?: Record<string, unknown>;
}

export interface SchemaTreeEntity {
  name: string;
  fields: SchemaTreeField[];
}

function ruleSummary(validation: Record<string, unknown> | undefined): string {
  if (!validation) {
    return '';
  }
  return Object.entries(validation)
    .filter(([, value]) => value !== null && value !== undefined && value !== false)
    .map(([key, value]) => (value === true ? key : `${key}:${JSON.stringify(value)}`))
    .join(' ');
}

function TreeField({ field }: { field: SchemaTreeField }) {
  const rules = ruleSummary(field.validation);
  return (
    <div>
      <div className="flex items-baseline gap-2 border-b border-border/50 py-1">
        <span className="min-w-40">
          {field.name}
          {field.required ? '' : '?'}
        </span>
        {/*
          Metadata, not an accent.

          These were green, and a seven-field entity therefore rendered seven
          green labels — the Schema tab was one of the greenest screens in the
          product. A type annotation is information about a field, not a
          highlight, so the hierarchy comes from weight and size instead: the
          field name is `--foreground` and its type is muted mono beside it.
        */}
        <span className="font-mono text-xs text-muted-foreground">{field.type}</span>
        {rules ? <span className="font-mono text-xs text-muted-foreground">{rules}</span> : null}
      </div>
      {field.children.length > 0 ? (
        <div className="ml-6">
          {field.children.map((child) => (
            <TreeField key={child.name} field={child} />
          ))}
        </div>
      ) : null}
    </div>
  );
}

export function SchemaTree({
  entities,
  className,
}: {
  entities: SchemaTreeEntity[];
  className?: string;
}) {
  return (
    <div className={cn('text-sm', className)}>
      {entities.map((entity) => (
        <div key={entity.name}>
          <div className="py-2 font-semibold">{entity.name}</div>
          {entity.fields.map((field) => (
            <TreeField key={field.name} field={field} />
          ))}
        </div>
      ))}
    </div>
  );
}
