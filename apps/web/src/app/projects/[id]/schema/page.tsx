'use client';

/**
 * The Schema tab.
 *
 * Was a modal on the old page, behind a "View schema" button. A modal is the wrong
 * container for a reference document: it cannot be linked to, cannot be kept open
 * beside the endpoint list, and closes on a stray Escape while you are reading it.
 */

import { useParams } from 'next/navigation';
import { Card, EmptyState, SchemaTree, type SchemaTreeEntity } from '@instantmockapi/ui';
import { useProject } from '../../../../lib/hooks';

export default function SchemaPage() {
  const { id } = useParams<{ id: string }>();
  const project = useProject(id);

  if (!project.data) {
    return <div className="ui-skeleton" />;
  }

  // `ips` is `unknown` on the wire because the API serializes the stored document
  // as-is; every consumer narrows it at the edge like this.
  const entities = (project.data.ips as { entities?: SchemaTreeEntity[] })?.entities ?? [];

  return (
    <Card className="ui-stack">
      <div>
        <h2>Schema</h2>
        <p className="ui-meta">
          The internal project schema every generator reads. Entities become API resources; fields
          define each record&rsquo;s shape.
        </p>
      </div>
      {entities.length === 0 ? (
        <EmptyState title="No entities yet">
          Parse an input source or use the builder to define this project&rsquo;s data model.
        </EmptyState>
      ) : (
        <SchemaTree entities={entities} />
      )}
    </Card>
  );
}
