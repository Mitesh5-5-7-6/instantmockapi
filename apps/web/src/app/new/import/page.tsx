'use client';

/**
 * Import a blueprint (Phase 4 §15, §17, §18).
 *
 * ## Why this is its own entry point rather than a fourth kind
 *
 * `/new` asks what you are building, and the answer sets `kind` permanently.
 * An import does not answer that question — the blueprint already did. So this
 * sits below the three choices as a different kind of action: not "what am I
 * building" but "I already have this".
 *
 * ## The flow, and why it ends where the wizard ends
 *
 * Read the file → show what it will create → Import → Generate → progress.
 *
 * The wizard's shape is create, review, Generate, progress page, and an import
 * lands in exactly the same place. The review step is the reason the preview
 * exists: importing makes a project, and the person doing it should see the
 * name, kind and size first. Generating is a second call, so a failed import
 * cannot leave a job queued against nothing (§14).
 *
 * ## The file is read here, but validated on the server
 *
 * `readBlueprintFile` only answers "is this plausibly a blueprint" so a wrong
 * file is caught without a round trip. Every real rule — the format version,
 * the canonical schema, the credential ban — is the server's, and when the
 * server refuses, its structured `path`/`issue` details are what get shown.
 * §14 is explicit that there must not be a second error system.
 */

import { useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import {
  Alert,
  AlertDescription,
  AlertTitle,
  Button,
  Card,
  ErrorDetails,
  Field,
  FormError,
  Icon,
  Input,
  Note,
  Textarea,
} from '@instantmockapi/ui';
import { apiFetch } from '../../../lib/api-client';
import { useImportBlueprint } from '../../../lib/hooks';
import { describeKind, describeSurface, readBlueprintFile } from '../../../lib/blueprint-file';
import { normalizeError, type AppFailure } from '../../../lib/errors';

export default function ImportBlueprintPage() {
  const router = useRouter();
  const fileInput = useRef<HTMLInputElement>(null);

  const [text, setText] = useState('');
  const [filename, setFilename] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [failure, setFailure] = useState<AppFailure | null>(null);
  const [busy, setBusy] = useState(false);

  const importBlueprint = useImportBlueprint();

  // Re-read on every keystroke, which is cheap and means the preview and the
  // local error track the textarea rather than a stale submit.
  const parsed = useMemo(() => (text.trim() === '' ? null : readBlueprintFile(text)), [text]);

  async function run(): Promise<void> {
    if (parsed === null || !parsed.ok) {
      return;
    }
    setBusy(true);
    setFailure(null);
    try {
      const project = await importBlueprint.mutateAsync({
        blueprint: parsed.blueprint,
        ...(name.trim() === '' ? {} : { name: name.trim() }),
      });
      /*
       * Generate immediately, then follow the job.
       *
       * The point of importing is a working API, and stopping at a draft
       * project would leave the user on a page whose only useful button is
       * Generate. Two calls rather than one endpoint that does both, so a
       * rejected blueprint never queues work.
       */
      const job = await apiFetch<{ jobId: string }>(`/v1/projects/${project.id}/generate`, {
        method: 'POST',
        body: {},
      });
      router.push(`/projects/${project.id}/progress/${job.jobId}`);
    } catch (cause) {
      setFailure(normalizeError(cause));
      setBusy(false);
    }
  }

  function onFile(file: File | undefined): void {
    if (file === undefined) {
      return;
    }
    setFilename(file.name);
    setFailure(null);
    void file.text().then(setText);
  }

  return (
    <div className="ui-stack" style={{ gap: 'var(--space-6)' }}>
      <div className="ui-stack" style={{ gap: 'var(--space-2)' }}>
        <h1>Import a blueprint</h1>
        <p className="ui-meta">
          A blueprint holds everything needed to recreate a project — entities, fields,
          relationships, authentication settings and generation options. Importing one creates a new
          project with its own hosted URL and its own credentials.
        </p>
      </div>

      <Card className="ui-stack">
        <div className="ui-row" style={{ gap: 'var(--space-3)', flexWrap: 'wrap' }}>
          <Button variant="secondary" onClick={() => fileInput.current?.click()}>
            <Icon name="cloud-upload" size={16} /> Choose .json file
          </Button>
          {filename === null ? null : <span className="ui-meta">{filename}</span>}
          <input
            ref={fileInput}
            type="file"
            accept="application/json,.json"
            hidden
            onChange={(event) => onFile(event.target.files?.[0])}
          />
        </div>

        <Field label="Or paste the blueprint" htmlFor="blueprint-json">
          <Textarea
            id="blueprint-json"
            rows={10}
            value={text}
            spellCheck={false}
            placeholder='{ "blueprintVersion": 1, ... }'
            onChange={(event) => {
              setText(event.target.value);
              setFilename(null);
              setFailure(null);
            }}
          />
        </Field>

        {/* The local read: a wrong file, named as such, without a round trip. */}
        {parsed !== null && !parsed.ok ? (
          <FormError title="That file cannot be imported" detail={parsed.reason} />
        ) : null}
      </Card>

      {parsed !== null && parsed.ok ? (
        <Card className="ui-stack">
          <h2 style={{ margin: 0 }}>This will create</h2>
          <div className="ui-stack" style={{ gap: 'var(--space-1)' }}>
            <strong>{parsed.preview.name}</strong>
            <span className="ui-meta">
              {describeKind(parsed.preview.kind)} · {describeSurface(parsed.preview)}
              {parsed.preview.authMode === null
                ? ''
                : ` · authentication ${parsed.preview.authMode}`}
            </span>
            {parsed.preview.description === null ? null : (
              <span className="ui-meta">{parsed.preview.description}</span>
            )}
            {parsed.preview.sourceVersion === null ? null : (
              <span className="ui-meta">
                Exported from v{parsed.preview.sourceVersion} of the source project
              </span>
            )}
          </div>

          <Field
            label="Name"
            htmlFor="import-name"
            hint="Leave blank to keep the blueprint’s own name. The hosted URL is new either way — a blueprint does not carry the original’s address."
          >
            <Input
              id="import-name"
              value={name}
              placeholder={parsed.preview.name}
              maxLength={120}
              onChange={(event) => setName(event.target.value)}
            />
          </Field>

          <div className="ui-row" style={{ gap: 'var(--space-3)' }}>
            <Button onClick={() => void run()} disabled={busy}>
              {busy ? 'Importing…' : 'Import and generate'}
            </Button>
            <Link href="/new" style={{ textDecoration: 'none' }}>
              <Button variant="ghost">Back</Button>
            </Link>
          </div>
        </Card>
      ) : null}

      {failure === null ? null : (
        <Alert variant="warning">
          <AlertTitle>{failure.title}</AlertTitle>
          <AlertDescription>
            {failure.detail}
            {failure.details.length > 0 ? (
              <ErrorDetails details={failure.details} code={failure.code} />
            ) : null}
          </AlertDescription>
        </Alert>
      )}

      <Note>
        Nothing in a blueprint is secret: it carries no signing keys, no tokens and no hosted URL,
        so it is safe to keep or share. The imported project gets fresh credentials of its own.
      </Note>
    </div>
  );
}
