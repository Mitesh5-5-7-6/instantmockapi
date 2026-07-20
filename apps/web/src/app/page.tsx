'use client';

/**
 * Working shell for the dashboard (S1) wired to the real data layer:
 * dev login, project list, create-from-JSON, generate, live job progress.
 * Visual design is intentionally bare — the MockForge design (Phase 6
 * design import) restyles these flows without changing the data layer.
 */

import { useState } from 'react';
import {
  useCreateProject,
  useGenerate,
  useJob,
  useJobStream,
  useLogin,
  useLogout,
  useMe,
  useProjects,
} from '../lib/hooks';

function LoginForm() {
  const login = useLogin();
  const [email, setEmail] = useState('');
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        if (email) {
          login.mutate(email);
        }
      }}
    >
      <h1>InstantMockAPI</h1>
      <p>Sign in with your email to continue.</p>
      <input
        type="email"
        value={email}
        placeholder="you@example.com"
        onChange={(event) => setEmail(event.target.value)}
      />
      <button type="submit" disabled={login.isPending}>
        {login.isPending ? 'Signing in…' : 'Sign in'}
      </button>
      {login.isError ? <p role="alert">{login.error.message}</p> : null}
    </form>
  );
}

function JobProgress({ jobId }: { jobId: string }) {
  useJobStream(jobId);
  const job = useJob(jobId);
  if (!job.data) {
    return <p>Starting…</p>;
  }
  return (
    <div>
      <p>
        Job {job.data.status} — {job.data.progress.percent}% ({job.data.progress.settled}/
        {job.data.progress.total})
      </p>
      <ul>
        {job.data.workers.map((worker) => (
          <li key={worker.artifactType}>
            {worker.artifactType}: {worker.status}
            {worker.error ? ` — ${worker.error}` : ''}
          </li>
        ))}
      </ul>
    </div>
  );
}

function ProjectRow({ id, name, status }: { id: string; name: string; status: string }) {
  const generate = useGenerate(id);
  const [jobId, setJobId] = useState<string | null>(null);
  return (
    <li>
      <strong>{name}</strong> — {status}{' '}
      <button
        onClick={() => generate.mutate(undefined, { onSuccess: (job) => setJobId(job.jobId) })}
        disabled={generate.isPending}
      >
        Generate
      </button>
      {jobId ? <JobProgress jobId={jobId} /> : null}
    </li>
  );
}

const SAMPLE_JSON = JSON.stringify(
  { customer: { name: 'Ada Lovelace', email: 'ada@example.com', age: 36 } },
  null,
  2,
);

function Dashboard() {
  const me = useMe();
  const logout = useLogout();
  const projects = useProjects({ sort: '-updatedAt' });
  const createProject = useCreateProject();
  const [name, setName] = useState('');
  const [rawJson, setRawJson] = useState(SAMPLE_JSON);

  if (me.isError) {
    return <LoginForm />;
  }

  return (
    <div>
      <header style={{ display: 'flex', justifyContent: 'space-between' }}>
        <h1>Dashboard</h1>
        <div>
          {me.data ? `${me.data.email} (${me.data.plan})` : ''}{' '}
          <button onClick={() => logout.mutate()}>Sign out</button>
        </div>
      </header>

      <section>
        <h2>New project from JSON</h2>
        <input
          value={name}
          placeholder="Project name"
          onChange={(event) => setName(event.target.value)}
        />
        <textarea
          rows={6}
          style={{ width: '100%' }}
          value={rawJson}
          onChange={(event) => setRawJson(event.target.value)}
        />
        <button
          disabled={createProject.isPending || !name}
          onClick={() => {
            try {
              createProject.mutate({
                name,
                inputSource: { type: 'json', raw: JSON.parse(rawJson) },
              });
            } catch {
              // leave invalid JSON to the API's PARSE_ERROR envelope
              createProject.mutate({ name, inputSource: { type: 'json', raw: rawJson } });
            }
          }}
        >
          Create project
        </button>
        {createProject.isError ? <p role="alert">{createProject.error.message}</p> : null}
      </section>

      <section>
        <h2>Projects {projects.data ? `(${projects.data.meta.total})` : ''}</h2>
        {projects.isLoading ? <p>Loading…</p> : null}
        <ul>
          {projects.data?.data.map((project) => (
            <ProjectRow
              key={project.id}
              id={project.id}
              name={project.name}
              status={project.status}
            />
          ))}
        </ul>
      </section>
    </div>
  );
}

export default function HomePage() {
  return (
    <main>
      <Dashboard />
    </main>
  );
}
