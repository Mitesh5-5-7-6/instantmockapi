# 11 · UI / UX

← [10 · Worker Engine](./10-worker-engine.md) · [Master Index](./README.md) · Next: [12 · Design System](./12-design-system.md)

Screen-by-screen specification. Screen IDs (S1–S8) match [03 · User Flow](./03-user-flow.md), §9. Visual tokens (color, type, spacing, components) live in [12 · Design System](./12-design-system.md); this doc defines *layout, content, states, and interactions*.

**Interface voice** (applies to all copy): active voice, sentence case, name things by what the user controls. An action keeps its name through the flow — the button that says **Generate** leads to a "Generating…" state and a "Generated" result. Errors state what happened and how to fix it; empty screens invite an action.

---

## 1. Navigation Model

- Persistent left **sidebar**: Dashboard · New Project · Templates · Settings · Billing.
- Top bar: plan indicator (e.g., "Free · 2-day APIs · 1 job"), usage (active jobs vs. limit), account menu.
- The **New Project wizard** (S2→S3→S4) is a focused 3-step flow with a visible stepper; the browser back and an in-wizard "Back" both work without losing entered data.

## 2. S1 · Dashboard

**Purpose:** see every project's state at a glance and start a new one.

- **Project card grid.** Each card: name, entity count, **status chip** (`draft · generating · active · expired`), plan badge, **expiration countdown** ("Expires in 1d 6h", live tick), last generated time.
- **Primary CTA:** New Project (top-right + empty-state center).
- **Per-status actions:** draft → *Continue setup* · generating → *View progress* · active → *Open* / *Download ZIP* / *Regenerate* · expired → **Generate Again**.
- **States:** empty ("No projects yet — create your first backend"), loading (card skeletons), error (inline retry).
- Countdowns and status come from the API/Registry, never guessed client-side.

## 3. S2 · Input (wizard step 1)

**Purpose:** capture requirements from one source and produce an IPS draft.

- **Tabbed input selector:** Paste JSON · Manual Schema Builder · Swagger/OpenAPI.
- **Paste JSON:** large editor with a syntax-highlighted placeholder; **Parse** infers entities, field types, and format suggestions (email/phone/url). Parse errors point at the offending path (`addresses[0].location.city`).
- **Manual Schema Builder** (the centerpiece):
  - Entity list; per entity, dynamic field rows: name · type dropdown · required toggle · default.
  - `object` / `array` types expand into **indented child groups** with their own "Add Field"; arrays of objects at any level; "Add Another" models dynamic arrays. Supports the demo 4-level schema (primaryDetail → addresses[] → location → …).
  - Per-field **validation popover** (Layer 2): min, max, length, regex, enum, custom message, nullable/optional/default, unique.
  - **Layer 1 hint chips** appear inline (naming a field `email` suggests email validation — accept or dismiss).
- **Swagger/OpenAPI:** file drop → parsed to IPS (stub allowed early, clearly labeled).
- **Next** advances to Configure; entered data persists on Back.

## 4. S3 · Configure (wizard step 2)

**Purpose:** choose exactly what to generate (selective generation).

Ordered questions:
1. **Validation** — ☑ Zod ☑ Yup; "Advanced" expander reveals ☐ JSON Schema.
2. **Types** — ☑ TypeScript.
3. **API methods** — checkboxes GET · POST · PUT · PATCH · DELETE, with helper text: *"Seed data is always generated for readable endpoints. A GET-only API is read-only."*
4. **Mock records per entity** — number input, default 25.

These form the **generationConfig**; only matching workers will run. **Next** → Review.

## 5. S4 · Review (wizard step 3)

**Purpose:** confirm the parsed model before spending compute — the trust step.

- **Split layout.** Left: collapsible **IPS tree** — entities → fields → nested structures → validation rules (Layer 1 rules as chips, Layer 2 rules editable inline). Right: **generation summary** — "Will generate: Zod, Yup, TypeScript, 25 × 2 entities mock records, OpenAPI, Postman, Hosted API (GET, POST), Export ZIP."
- **Inline edits:** rename field, toggle required, adjust rules (writes to the IPS; a save bumps the version on generate).
- **Generate** is the only way forward — review is mandatory. Disabled with a reason if the IPS is invalid (e.g., depth cap exceeded), with the offending node highlighted.

## 6. S5 · Progress (live worker board)

**Purpose:** make generation feel active and honest.

- **Vertical worker board.** Each row: worker label + **status chip** transitioning `pending → generating (pulse) → completed ✓` or `failed ✗`. Only workers implied by the config appear.
- **Overall progress bar** (settled ÷ total selected tasks).
- **Failure row:** shows the error message + a **Retry** button that re-runs *only* that worker; completed rows are untouched; the DAG dependents (E/F after D) show "Waiting on Mock Data" until the dependency completes.
- **Leaving is safe:** generation runs in the background; returning shows true current state (Registry-driven, via SSE). A toast/notification fires on completion.

## 7. S6 · Project Page (Artifact Registry view)

**Purpose:** use everything that was generated.

- **Header:** name, current version badge, expiration countdown, **Download ZIP** and **Regenerate**.
- **Hosted API card:** the URL (`https://api.InstantMockAPI.dev/p/{projectId}/customers`), copy button, method chips for the selected verbs, and a **request playground** — pick method + endpoint, Send, see a real JSON response. Unselected methods aren't offered.
- **Artifact grid:** one card per artifact (IPS, JSON Schema, Zod, Yup, TypeScript, Mock Data, OpenAPI, Postman, Hosted API, Export Bundle), each showing status chip, version, generated time, worker id, with **View** (modal of the generated code), **Download**, **Regenerate**.
- **Regenerate modal (per-asset):** checkboxes (☑ Zod ☐ Types ☐ Mock Data ☐ OpenAPI …) → runs only those workers; each regenerated artifact gets a new version.
- **Version history panel:** versions with timestamps; **Restore** reverts the IPS + config to that snapshot (next generation builds from it).

## 8. S7 · Expired State

**Purpose:** turn an expiry into a one-click recovery (and a conversion moment).

- Hosted API card **grayed out** with "Hosted assets deleted"; artifact files marked expired (metadata/versions still listed).
- The IPS tree and configuration remain fully intact and viewable.
- Single accent CTA: **Generate Again** → jumps to S5 with the kept config → new hosted URL.
- Upgrade prompt inline for Free ("Pro APIs last 7 days") — offered, not nagged.

## 9. S8 · Settings & Billing

- **Settings:** profile, **theme toggle** (dark default / light), notification preferences (expiry reminders).
- **Billing:** plan comparison table — Free (2-day APIs, 1 job), Pro (7-day, 3 jobs), Enterprise (30-day, unlimited) — noting "hosted assets are hard-deleted after expiry; your project, schema, and config are always kept." Upgrade/downgrade actions.

## 10. Templates (light in V1)

- Gallery of starter IPS models (CRM, E-commerce, Blog). Selecting one pre-loads the Schema Builder at S2. Expands in V2 (doc 16).

## 11. Cross-Cutting UX Rules

| Concern | Rule |
|---|---|
| **Status chips** | One consistent chip vocabulary everywhere: `pending · generating · completed · failed · active · expired` (doc 12) |
| **Loading** | Skeletons for lists/cards; inline spinners for in-place actions; never a blank screen |
| **Errors** | Interface-voice, specific, actionable ("This field name is required" / "Invalid JSON at addresses[0]") — never a raw stack trace |
| **Empty states** | Each is a prompt to act, not a dead end |
| **Copy actions** | URLs and code blocks have a one-tap copy with confirmation |
| **Optimistic vs. truthful** | Generation/expiry states are **truthful** (server-driven); only lightweight UI (e.g., rename) is optimistic |
| **Accessibility floor** | Keyboard-navigable, visible focus, reduced-motion respected, sufficient contrast in both themes |
| **Responsive** | Full flow works down to mobile; the Schema Builder collapses nested groups gracefully on narrow screens |

## 12. Screen → Feature/API Map

| Screen | Features (doc 04) | Key API (doc 08) |
|---|---|---|
| S1 Dashboard | F1, F15 | `GET /projects` |
| S2 Input | F2, F4 | `POST /projects`, `POST /projects/{id}/parse` |
| S3 Configure | F5 config | (carried into generate) |
| S4 Review | F3, F5 | `PATCH /projects/{id}` |
| S5 Progress | F7, F13 | `POST /generate`, `GET /jobs/{id}/stream`, retry |
| S6 Project | F8–F12, F14 | artifacts, export, versions, hosted playground |
| S7 Expired | F11 | `POST /generate-again` |
| S8 Settings/Billing | F15 | `GET /me`, billing |

---

Next: [12 · Design System →](./12-design-system.md)
