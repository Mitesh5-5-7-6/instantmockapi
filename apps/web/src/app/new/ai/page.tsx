'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button, Card, Field, FormError, Input, Textarea } from '@instantmockapi/ui';
import { useCreateAiProject } from '../../../lib/hooks';
import { normalizeError } from '../../../lib/errors';

export default function NewAiPage() {
  const router = useRouter();
  const createAi = useCreateAiProject();
  const [prompt, setPrompt] = useState(
    'Create a hospital management API with patients, doctors, departments and appointments.',
  );
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit() {
    setError(null);
    if (!prompt.trim()) {
      setError('Describe the API you want to generate.');
      return;
    }

    setSubmitting(true);
    try {
      const created = await createAi.mutateAsync({
        prompt: prompt.trim(),
        name: name.trim() || undefined,
      });
      router.push(`/projects/${created.id}`);
    } catch (caught) {
      const normalized = normalizeError(caught);
      setError(normalized.title || 'AI generation failed.');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="ui-stack" style={{ gap: 'var(--space-6)', maxWidth: '760px' }}>
      <div className="ui-stack" style={{ gap: 'var(--space-2)' }}>
        <h1>Describe your API</h1>
        <p className="ui-meta">
          The AI proposes entities, fields and relationships, then the platform validates the result
          through the same deterministic project pipeline before creation.
        </p>
      </div>

      <Card className="ui-stack">
        <Field label="Project name (optional)">
          <Input
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="Hospital management API"
          />
        </Field>

        <Field label="Describe the API">
          <Textarea
            value={prompt}
            onChange={(event) => setPrompt(event.target.value)}
            rows={8}
            placeholder="Create a hospital management API with patients, doctors, departments and appointments."
          />
        </Field>

        <div className="ui-row" style={{ justifyContent: 'flex-end', gap: 'var(--space-3)' }}>
          <Button variant="secondary" onClick={() => router.back()} disabled={submitting}>
            Back
          </Button>
          <Button onClick={handleSubmit} disabled={submitting || !prompt.trim()}>
            {submitting ? 'Generating...' : 'Generate API'}
          </Button>
        </div>

        {error ? (
          <FormError title={error} detail="Please refine the prompt and try again." />
        ) : null}
      </Card>
    </div>
  );
}
