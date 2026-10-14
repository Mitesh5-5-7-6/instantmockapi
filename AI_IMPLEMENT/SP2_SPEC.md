# Phase 7 — Sub-project 2: Review, Edit, Authentication, Create

> **Status:** design approved in conversation (2026-10-14), awaiting written-spec review.
> **Builds on:** Sub-project 1 (generic AI generation core), branch `feat/phase7-sp1-ai-core`.
> **Parent docs:** [PHASE7_SPEC.md](PHASE7_SPEC.md) §5, §7, §13, §16 · [PHASE7_TASKS.md](PHASE7_TASKS.md) §6 (T2.1–T2.10).
> **Next step after approval:** an implementation plan, `SP2_PLAN.md`.

---

## 1. Goal

Replace SP1's minimal "ready" summary with a full review screen. On it the user:

1. sees the proposed data model as a diagram and as editable entity cards;
2. edits entities, fields and relations, the API type, the name, the description, the endpoint methods and the mock record count;
3. **must answer "Does this API require authentication?"** before creating anything;
4. can regenerate the suggestion, optionally answering the AI's questions, **without silently losing edits**, by merging per entity;
5. can switch the explanation language after generation without losing the draft;
6. creates the API, which goes through the existing generate → progress → ready flow and ends on an improved "Your Mock API is ready" screen.

### Decisions already made

| #   | Decision                               | Chosen                                                                                                                                                            |
| --- | -------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | Where edits live while reviewing       | **A server draft on the proposal**: autosave plus dry-run validation                                                                                              |
| D2  | Changing the language after generation | **Translate the prose in place** with a small background job; the schema and draft are untouched                                                                  |
| D3  | How Regenerate merges with edits       | **A choice per entity**, defaulting to "keep mine"                                                                                                                |
| D4  | Where the review UI lives              | **A dedicated page at `/new/ai/[id]`**, built from the existing builder components                                                                                |
| D5  | What Create does                       | commit, then the existing generate flow; the first generation publishes exactly as the manual wizard's does                                                       |
| D6  | Authentication choices                 | Project: None / All protected / Some endpoints protected. Single: None / All protected. Nothing is pre-selected; the AI's recommendation is shown only as a hint. |
| D7  | Undo                                   | Client-side, keeping the last 50 states, not kept across reloads (the saved draft is)                                                                             |

### Out of scope

- Research and citations (SP4).
- Change events, memory and preferences (SP3). The stored draft and the AI's original result already give SP3 its "AI version vs. final" pair.
- Hand-editing endpoint paths: paths stay derived by the platform, so they are always valid.
- Field-level merge on Regenerate.

---

## 2. Existing pieces reused

| Piece                                                                                  | Location                                                | Use in SP2                                                                                    |
| -------------------------------------------------------------------------------------- | ------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `EntityCard` (embeds `FieldRow`, `RelationEditor`)                                     | `apps/web/src/components/builder/`                      | The entity editor. Its `noun="endpoint"` and `showRelations={false}` props cover Single APIs. |
| `ErDiagram`, `ErLegend`                                                                | `apps/web/src/components/er-diagram.tsx`                | Read-only model diagram                                                                       |
| `AuthStep`                                                                             | `apps/web/src/components/builder/auth-step.tsx`         | The authentication question (one small change, §6.3)                                          |
| `validateRelations`, `hasEmptyEnum`, `relationTargets`                                 | `apps/web/src/lib/relations.ts`, `builder.ts`           | Instant client-side checks                                                                    |
| `ipsToBuilder`                                                                         | `apps/web/src/lib/draft-schema.ts`                      | Converting a proposal or draft into builder state                                             |
| `configForChoice`, `authConfigOf`, `authProblems`, `PROJECT_CHOICES`, `SIMPLE_CHOICES` | `apps/web/src/lib/auth-config.ts`, `auth-onboarding.ts` | Auth choice ↔ `AuthConfig`                                                                    |
| `entityEndpoints`                                                                      | `@instantmockapi/shared`                                | The endpoint list                                                                             |
| `SnippetTabs`, `HostedPlayground`                                                      | `apps/web/src/components/`                              | Request examples and "Try it" on the ready page                                               |
| `useGenerate`, the progress page, the ready page                                       | `apps/web/src/lib/hooks.ts`, `app/projects/[id]/…`      | What happens after Create                                                                     |
| `toBuilderShape`, `validateShape`, proposal routes, worker, queue                      | SP1                                                     | Extended, not replaced                                                                        |

---

## 3. Architecture and flow

```
/new/ai  (SP1: describe → generating)
   │ proposal ready  → router.replace('/new/ai/' + id)
   ▼
/new/ai/[id]  — the review page
   ├─ Overview: name, description, type (+ recommendation and reason), language ▾, assumptions, questions
   ├─ Data model: ErDiagram + EntityCard list (Single → noun="endpoint", no relations)
   ├─ Endpoints: read-only list + method checkboxes + mock record count
   ├─ Authentication: AuthStep, nothing pre-selected; "Create API" disabled until answered
   ├─ Actions: Undo · View changes · Regenerate… · Create API
   │
   ├─ every edit → debounce 800 ms → PATCH /v1/ai/proposals/:id/draft
   │                                  → saves draft + dry-run validation → issues mapped onto fields
   ├─ language change → POST …/translate → worker re-writes result prose → client applies it to the draft
   ├─ Regenerate → POST …/regenerate {answers, instruction} → child proposal
   │                 → per-entity diff: draft vs child result → user picks → POST …/:childId/adopt
   │                 → parent `superseded`, URL moves to the child
   │
   └─ Create API → POST …/commit (requires the saved draft, incl. the auth answer)
                   → POST /v1/projects/:id/generate (existing) → /projects/:id/progress/:job → /ready
```

---

## 4. Data model changes (`packages/db/src/models/aiProposal.ts`)

| Field           | Type                                                                            | Default | Purpose                                                                                                               |
| --------------- | ------------------------------------------------------------------------------- | ------- | --------------------------------------------------------------------------------------------------------------------- |
| `status`        | adds `'superseded'`                                                             | —       | A parent whose regenerated child was adopted. Superseded proposals cannot be edited, committed, retried or cancelled. |
| `draft`         | `ProposalDraft \| null`                                                         | `null`  | The user's working copy                                                                                               |
| `translation`   | `{ status: 'pending' \| 'failed'; language: string; message?: string } \| null` | `null`  | Translation in progress or failed                                                                                     |
| `parentId`      | `ObjectId \| null`                                                              | `null`  | Set on a regenerated child                                                                                            |
| `childId`       | `ObjectId \| null`                                                              | `null`  | The latest regeneration of this proposal                                                                              |
| `clarification` | `{ answers?: string; instruction?: string } \| null`                            | `null`  | What the user added when regenerating (child only)                                                                    |
| `translations`  | `number`                                                                        | `0`     | Counts toward the hourly AI budget; part of the translate job id                                                      |

```ts
interface ProposalDraft {
  revision: number; // optimistic concurrency; +1 on every save
  kind: 'project' | 'single';
  name: string; // ≤ 120
  description: string; // ≤ 500
  entities: Entity[]; // builder shape — exactly what commit uses
  generationConfig: { methods: HttpMethod[]; mockRecords: number };
  authAnswered: boolean; // false until the user picks an option
  authentication: AuthConfig | null; // null = "No authentication" (meaningful only when answered)
  savedAt: Date;
}
```

Document every field's _why_ in the model file, as SP1 did.

**Queue payload** (`packages/queue`): `AiProposalJobPayload` becomes `{ proposalId; run; kind: 'propose' | 'translate'; language? }`.

- A missing `kind` means `'propose'`, so jobs already queued keep working.
- Translate job id: `${proposalId}-t${translations}`.

---

## 5. Server

### 5.1 `PATCH /v1/ai/proposals/:id/draft`: autosave plus dry-run validation

- **Body:** `{ revision, kind, name, description, entities, generationConfig, authAnswered, authentication }`. `revision` is the revision the client last saw; it is 0 when there is no draft yet.
- **Owner-scoped:** another user's proposal → 404. A proposal not in `ready` → 409 with `{ status, projectId?, childId? }`.
- **Cleaning:**
  - `entities` go through `toBuilderShape` with a new option, `{ keepEntityAuth: true }`. It keeps an entity's `authentication` only when the value is `'PROTECTED'` or `'PUBLIC'`. The AI output path keeps stripping it.
  - `mockRecords` is coerced to `1..maxMockRecords` as in SP1.
  - `name` and `description` are trimmed and capped.
- **Dry-run validation:** `parseBuilderPayload(entities, generationConfig, authentication ?? undefined, kind)` followed by `validateIPS(…, maxNestingDepth)`. This is exactly what commit runs. The result is `issues: { path, issue }[]`.
- **Saving:** always, even when there are issues, so no edit is ever lost. A conditional update on `{ _id, status: 'ready', 'draft.revision': revision }` (or `draft: null` when the revision is 0) sets the draft with `revision + 1` and `savedAt`.
- **Response:** `200 { draft, issues }`. Revision mismatch → **409** `{ error: { code: 'CONFLICT', … }, draft: <current> }`.
- Autosave costs no AI calls and doesn't count toward the budget.

### 5.2 Commit (changed)

- **Source:** the saved `draft`. **A draft is required**, because the authentication answer lives only there ("always ask", spec §5). The review page always saves one before Create.
  - SP1's commit-from-`result` path is removed.
  - The SP1 commit tests must be updated to save a draft (with `authAnswered: true`) first.
- The body keeps only overrides: `kind`, `name`, `slug`, `description`.
- **No draft, or `draft.authAnswered` not `true`** → 422 `VALIDATION_ERROR`, path `authentication`, "Answer the authentication question first".
- **`authentication`** comes from `draft.authentication` and is added to the builder raw payload. That payload is validated by `parseInputSource` as before.
- **A body `authentication`** is still rejected with 422 (SP1 Ruling 15). Its message changes to "set authentication in the draft".
- **Auth-invariant allow-list** (`packages/ips/src/auth-invariants.test.ts`): add `apps/api/src/routes/ai-proposals.ts` with the reason _"passes the reviewed draft's auth block to the builder adapter; makes no protection decision"_. If the guard's regex also catches the `keepEntityAuth` read in `packages/ai/src/shape.ts`, add it with the reason _"preserves the user's per-entity PUBLIC/PROTECTED stamp from a reviewed draft; makes no protection decision"_.
- **Secrets:** unchanged. The signing key is minted lazily by `ensureAuthSecret`; nothing secret is in the draft, the proposal or the client.

### 5.3 `POST /v1/ai/proposals/:id/regenerate` `{ answers?, instruction? }`

- `answers` ≤ 1000 characters and `instruction` ≤ 500, both trimmed and both optional. With neither, Regenerate is a plain re-roll that still revises `<current_blueprint>`.
- **Preconditions:** the parent is `ready` (409 otherwise). There is no child in `generating` (409 `{ childId }`). The hourly budget check (§5.6) passes.
- **Creates a child:**
  - It copies the parent's `prompt`, `hints` and `responseLanguage`.
  - It sets `parentId` and `clarification`, with status `generating` and stage `queued`.
  - It sets the parent's `childId`, then enqueues `{ proposalId: child, run: 1, kind: 'propose' }`.
- **Prompt (`packages/ai/src/prompt.ts`):**
  - `buildUserTurn` gains optional `clarification` and `currentBlueprint` inputs. They are emitted as `<clarifications>` (answers, then instruction) and `<current_blueprint>` (JSON of the parent's draft entities, or the result entities if there is no draft). All the text is neutralised exactly like other user text (SP1 Ruling 6).
  - `SYSTEM_PROMPT` gains one rule: _"When `<current_blueprint>` is present, revise it: keep everything the clarifications do not ask to change."_
  - **`PROMPT_VERSION = 'generic-v2'`.**
- **The worker** passes the child's `clarification` and the parent's current blueprint to `proposeBlueprint` (new optional `ProposeInput` fields).
- **Response:** 202 with the child view.

### 5.4 `POST /v1/ai/proposals/:childId/adopt` `{ draft }`

- **Preconditions:** the child is `ready`, it has a `parentId`, and the parent is `ready` with `childId` equal to this child. Otherwise → 409.
- **Draft:** the merged draft is cleaned and validated exactly as in §5.1, then saved on the child with revision 1.
- **Parent:** a conditional update `{ _id: parentId, status: 'ready', childId }` → `superseded`. If that update matches nothing, the child's draft is left saved and the response is 409.
- **Response:** 200 `{ draft, issues }` for the child.
- **Keep my draft** uses the existing `POST …/:childId/cancel`, which now also clears the parent's `childId` (conditional on it pointing at this child).

### 5.5 `POST /v1/ai/proposals/:id/translate` `{ language }`

- **Language:** must match `^[a-z]{2,3}(-[A-Za-z]{2,4})?$`. The same language as `responseLanguage ?? result.detectedLanguage` is a no-op 200.
- **Preconditions:** the proposal is `ready`; the budget check (§5.6) passes.
- **Start:** a conditional update sets `translation = { status: 'pending', language }` and `$inc: { translations: 1 }`, then enqueues `{ proposalId, run: <current runs>, kind: 'translate', language }`.
- **Worker** (`processAiProposalJob` branches on `kind`):
  - **Input:** only the prose: `{ description, kindRationale, authReason, assumptions[], questions[], entityDescriptions: { [entityName]: string } }`.
  - **Call:** one Gemini call with a new domain-free `TRANSLATE_PROMPT` (`packages/ai/src/translate.ts`). The prose is neutralised and the output must be JSON.
  - **Validation:** the output must have the same keys, the same list lengths and the same entity names. Each string is cleaned with the SP1 sanitizer. Any mismatch → final failure.
  - **Success:** a conditional update on `{ _id, status: 'ready', 'translation.language': language }` writes the translated prose into `result`, sets `responseLanguage = language` and clears `translation`. The worker **never writes the draft**, because that would change its revision and make every open tab conflict.
  - **Final failure:** `translation = { status: 'failed', language, message: 'Translation failed – keep this language or retry' }`.
  - **Temporary error:** throws, so the queue retries. Exhaustion → `failed`.
- **The client applies translated prose to its draft state**, but only for the description and entity descriptions the user hasn't edited (where the draft value still equals the previous AI text), then saves through the normal autosave.
- **Lazy expiry:** a `translation.status === 'pending'` older than 10 minutes (by `updatedAt`) reads as `failed`.

### 5.6 Budget

The hourly cost guard becomes the sum of `runs + translations` over the owner's proposals whose `runStartedAt` falls in the last hour. A translate request sets `runStartedAt` like a run does. The limit stays `AI_RUNS_PER_HOUR = 20`; exceeding it → 429 `RATE_LIMIT_EXCEEDED`. Regenerate counts as a new proposal run.

### 5.7 Statuses and lazy expiry

- `superseded` is final.
- `GET` on a superseded proposal returns it with `childId`; the client follows it.
- Lazy expiry gains the translation rule above. The rest is unchanged from SP1 (generating > 10 min, committing > 2 min).

---

## 6. Client

### 6.1 Pure libraries (unit-tested; `apps/web` vitest covers `src/lib/**`)

| File                       | Exports                                                                                                                                                                  | Notes                                                                                                                                                                                                                                          |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `lib/builder-payload.ts`   | `serializeBuilder({ entities, methods, mockRecords, kind, authMode, protectedNames })` → `{ entities, generationConfig, authentication: AuthConfig \| null, pathIndex }` | **Moved, unchanged, out of `app/new/project/page.tsx:193-256`.** The wizard switches to it with no behaviour change.                                                                                                                           |
|                            | `proposalToBuilder(source)` → `{ entities: BuilderEntity[], methods, mockRecords, kind, name, description, authMode: AuthMode \| null, protectedNames }`                 | Reads `draft` when present, otherwise `result`. Uses `ipsToBuilder`. `authMode` is `null` unless `draft.authAnswered`.                                                                                                                         |
| `lib/proposal-diff.ts`     | `diffEntities(mine, next)` → `EntityChange[]`                                                                                                                            | Matches entities by name (case-insensitive). Each is `added`, `removed`, `changed` or `same`, with `fieldChanges` (added, removed, type, required, enum) and `relationChanges`.                                                                |
|                            | `mergeEntities(mine, next, choices)`                                                                                                                                     | Per entity, `'mine'` or `'new'`. **The default is `'mine'` everywhere**, so an untouched diff is a no-op. My order is kept and new entities are appended. Dangling relations are left for `validateRelations` to flag, never deleted silently. |
| `lib/undo.ts`              | `createHistory<T>(limit = 50)`                                                                                                                                           | push / undo / canUndo                                                                                                                                                                                                                          |
| `lib/ai-proposal.ts` (SP1) | `pollInterval` extended                                                                                                                                                  | Also polls while `translation?.status === 'pending'`                                                                                                                                                                                           |

### 6.2 Review page: `app/new/ai/[id]/page.tsx` + `components/ai-review/*`

The page owns one `useReducer` state: entities, methods, mockRecords, kind, name, description, authMode, protectedNames. Every change pushes the previous state onto the undo history and schedules an autosave **800 ms** later.

| Component          | Content                                                                                                                                                                                                                                                                                            |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `OverviewCard`     | Name, description, type selector with "Recommended: …" and the reason, language selector ("Translating…" or the failure), assumptions, questions                                                                                                                                                   |
| `ModelSection`     | `ErDiagram`, `EntityCard`s, Add entity. Single → `noun="endpoint"` and `showRelations={false}`. Server issues that can't be placed on a field are listed at the top.                                                                                                                               |
| `EndpointsSection` | A read-only endpoint list (`entityEndpoints`), method checkboxes, and the mock record count (1..1000)                                                                                                                                                                                              |
| `AuthSection`      | `AuthStep` with `PROJECT_CHOICES` or `SIMPLE_CHOICES`. The AI hint is a separate line, "Suggested: … because …", and is never selected for the user.                                                                                                                                               |
| `ActionBar`        | Save status ("Saved", "Saving…", "Couldn't save – retry"; `aria-live`) · Undo · View changes · Regenerate… · **Create API**                                                                                                                                                                        |
| `ChangesPanel`     | A read-only `diffEntities(proposalToBuilder(result), current)`                                                                                                                                                                                                                                     |
| `RegenerateDialog` | The answers box, pre-filled with the AI's questions, plus an optional instruction → waiting → the per-entity diff. Choices per row: changed → mine / new; added → add / skip; removed → keep / remove. Then **Apply** (adopt, then go to the child's URL) or **Keep my draft** (cancel the child). |

**The one change to an existing component:** `AuthStep`'s `mode` accepts `null`, meaning no radio is selected. The wizard always passes a value, so it is unaffected.

### 6.3 Saving, validation and Create

- **Autosave:** `PATCH …/draft` with the current revision.
  - The returned `issues` are mapped to fields through `pathIndex` into the `errors` map that `EntityCard` already takes.
  - Client checks (`validateRelations`, `hasEmptyEnum`, `authProblems`) show instantly; the server's answer is the authority.
- **409 because another tab saved:** a banner says "This proposal was changed in another tab", with **Load latest** (unsaved local changes are named as lost).
- **Create API is enabled only when** the auth question is answered, no save is pending or failed, and there are zero issues.
- **Create:** flush any pending save → commit → `useGenerate(projectId)` → `/projects/:id/progress/:jobId`.
  - Commit 409 because it was already committed → go to the project.
  - Generate fails to start → go to the project page with the error (the project exists).
- **Regenerate and Create both wait for a pending save to finish first.**

### 6.4 Changes to existing screens

- **`/new/ai`:** when a proposal becomes `ready`, `router.replace('/new/ai/' + id)`. History items open that URL. SP1's minimal summary branch is removed.
- **`/projects/[id]/ready`** (every project): adds Copy URL, Open API (`hosted.url`), Open dashboard, the endpoint list, `SnippetTabs` for the selected endpoint, and **Try it** (`HostedPlayground`, shown only when the URL exists).

### 6.5 New hooks (`lib/hooks.ts`)

- `useSaveAiDraft`, `useRegenerateAiProposal`, `useAdoptAiProposal`, `useTranslateAiProposal`.
- `useCommitAiProposal` typed with its overrides `{ kind?, name?, slug?, description? }`.

---

## 7. Edge cases

| Situation                                                                                      | Behaviour                                                                                                                             |
| ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| Saving after the proposal stopped being `ready` (committed, superseded or cancelled elsewhere) | 409 with the status. Committed → go to the project. Superseded → go to the child. Cancelled → back to `/new/ai` with the prompt kept. |
| Opening a superseded proposal's URL                                                            | Follows `childId` to the current proposal                                                                                             |
| Regenerate or Create clicked with a save pending                                               | Waits for the save first                                                                                                              |
| A regenerated child fails                                                                      | The dialog shows the error with **Retry** (the child's retry) or **Keep my draft**                                                    |
| The dialog is closed while the child is generating                                             | The child is cancelled                                                                                                                |
| Switching Project → Single while relations exist                                               | A confirmation, then the relations are removed; Undo restores them                                                                    |
| Switching type while "Some endpoints protected" is selected                                    | The auth answer resets to unanswered (Single doesn't offer that choice)                                                               |
| Renaming or removing an entity while some endpoints are protected                              | The protected list follows the rename, or drops the removed entity                                                                    |
| The hourly budget is used up (regenerate or translate)                                         | The 429 message appears inline next to the button                                                                                     |
| Draft over the 1 MB body limit                                                                 | "Couldn't save"; Create stays disabled                                                                                                |
| A translation reply with the wrong shape                                                       | Final failure with a retry option; the prose stays in the old language                                                                |

---

## 8. Testing

**`packages/ai`:**

- `TRANSLATE_PROMPT` contains no domain words (regression guard).
- A translation reply with different keys, list lengths or entity names is rejected.
- `buildUserTurn` neutralises `<clarifications>` and `<current_blueprint>` content.
- `PROMPT_VERSION` is `'generic-v2'`.
- `toBuilderShape(…, { keepEntityAuth: true })` keeps only `PROTECTED`/`PUBLIC`, and the default still strips it.

**`packages/db` and `packages/queue`:**

- The new fields have their defaults.
- A payload without `kind` is treated as `propose`.
- The translate job id format.

**`apps/workers`:**

- A translation succeeds.
- A malformed reply → `failed`.
- A stale language (the user changed it again) → the result is dropped.
- A temporary error → it throws.
- Exhaustion → `failed`.
- A regenerate job receives the clarification and the current blueprint.

**`apps/api`:**

- **Draft:** save plus issues; revision conflict → 409 with the current draft; not ready → 409; another user → 404; entity auth kept; `mockRecords` coerced.
- **Commit:**
  - uses the draft;
  - unanswered auth → 422;
  - All protected and Some protected each end up on the project's IPS;
  - a body `authentication` → 422;
  - **the auth-invariant test passes with the new allow-list entry**.
- **Regenerate:** budget; one child at a time; the child records `parentId` and `clarification` and is queued.
- **Adopt:** the parent becomes `superseded` and the child's draft is saved; a second adopt → 409; adopt after the parent changed → 409.
- **Translate:** budget; same-language no-op; pending state; lazy expiry.

**`apps/web` (pure libraries):**

- **`serializeBuilder` golden test:** output captured from the wizard's inline serializer _before_ the move must equal the extracted function's output for the same inputs, including all auth modes.
- `proposalToBuilder` round-trips with `serializeBuilder`.
- **Diff and merge:** the default merge is a no-op; added, removed and changed each behave as chosen; a dangling relation is flagged by `validateRelations`.
- `createHistory`.
- The `pollInterval` translation rule.

**Regression:** every existing suite, especially the manual wizard (`new/project`) and the ready page. The SP1 baseline failure ("rejects a reserved slug") is pre-existing.

**Manual, with a real `GEMINI_API_KEY`:**

- A full flow with "Some endpoints protected", ending on the ready page.
- A regenerate with a mixed per-entity merge.
- Switching to Gujarati after generation.
- One Single API flow.
