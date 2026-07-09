# Claude Design Prompt — InstantMockAPI Prototype

Copy everything below the line into Claude Design.

---

Build a fully working, clickable prototype of **InstantMockAPI — Backend Development Studio**, a SaaS web app that turns backend requirements into a complete generated backend toolkit (schemas, validations, types, mock data, docs, and a hosted mock API). This is a frontend prototype: simulate all backend behavior with in-memory state, realistic fake data, and timed async transitions so every flow feels real end-to-end.

## Product in One Line

Developer pastes a JSON payload or builds a schema → answers a few config questions (which validators, types, HTTP methods) → reviews the parsed model → clicks Generate → watches parallel workers complete live → gets downloadable assets + a temporary hosted mock API URL.

## Aesthetic & Design System

- Modern developer-tool aesthetic: dark theme by default (deep charcoal `#0D1117`-style background, elevated card surfaces), with a light theme toggle.
- One vivid accent color (electric violet or emerald) used for primary actions, progress states, and the "Generate" CTA. Success = green, failed = red, pending = muted gray, generating = accent with pulse animation.
- Monospace font (JetBrains Mono / Fira Code style) for all code, JSON, schemas, and URLs; a clean geometric sans (Inter-like) for UI.
- Generous spacing, 8–12px radius, subtle borders instead of heavy shadows, smooth 150–250ms transitions.
- Status chips everywhere: `pending · generating · completed · failed · expired`.

## Screens to Build (all connected via navigation)

### 1. Dashboard
- Sidebar nav: Dashboard, New Project, Templates, Settings, Billing.
- Grid of project cards, each showing: project name, entity count, plan badge, status (Active / Generating / Expired), and an **expiration countdown** ("Expires in 1d 6h").
- Expired projects show a prominent **"Generate Again"** button (one-click regeneration — the project shell is kept, only hosted assets were deleted).
- Seed with 4–5 realistic fake projects: "CRM Backend" (expired), "E-commerce API" (active, 1d 6h left), "Blog Platform" (generating), "Task Manager" (active), etc.
- Top bar: plan indicator (Free — 2 day expiry, 1 concurrent job), upgrade button.

### 2. New Project — Step 1: Input
- Tabbed input selector: **Paste JSON** | **Manual Schema Builder** | **Swagger/OpenAPI** (Swagger tab can be a stub with "coming soon" file-drop).
- **Paste JSON tab:** large code editor textarea with syntax-highlighted placeholder JSON; a "Parse" button that infers fields + types.
- **Manual Schema Builder tab (the star of the prototype):**
  - Add entities (e.g., Customer, Order).
  - Per entity, dynamic field rows: name, type dropdown (string, number, boolean, date, email, url, uuid, enum, object, array), required toggle, default value.
  - **Unlimited nesting:** "object" and "array of objects" types expand into indented child field groups with their own "Add Field" buttons — support at least 3–4 visible nesting levels (e.g., `addresses[] → location → { country, state, city }`).
  - "Add Another" for dynamic arrays.
  - Per-field validation popover (Layer 2 config): min, max, length, regex, enum values, custom error message.
  - Auto-detection hint chips (Layer 1): typing a field named "email" auto-suggests email validation, "phone" → phone, "url" → URL.

### 3. New Project — Step 2: Configuration Questions
A clean wizard step asking:
- **Validation needed?** Checkboxes: ☑ Zod ☑ Yup, plus an "Advanced" expander with ☐ JSON Schema.
- **Schema types?** ☑ TypeScript.
- **API methods?** Checkboxes: GET, POST, PUT, PATCH, DELETE — with a helper note: "Seed data is always generated for readable endpoints; GET-only APIs are read-only."
- **Mock records per entity:** number input, default 25.

### 4. Review Screen
- Split view: left = the parsed **Internal Project Schema** as a collapsible tree (entities → fields → nested structures → validation rules); right = summary of selected outputs ("Will generate: JSON Schema, Zod, Yup, TypeScript, 25 mock records × 2 entities, OpenAPI, Postman, Hosted API with GET/POST").
- Inline edit affordances on the tree (rename field, toggle required).
- Big accent **"Generate"** CTA.

### 5. Progress Screen (live worker board)
- Vertical checklist of workers, each animating from pending → generating (pulsing) → ✓ completed over staggered simulated timings (total ~6–8 seconds):
  - Worker A — Schema (JSON Schema)
  - Worker B — Validation (Zod, Yup)
  - Worker C — Types (TypeScript)
  - Worker D — Mock Data (25 records)
  - Worker E — Documentation (OpenAPI, Postman)
  - Worker F — Hosted API
  - Worker G — Export bundle
- **Simulate one failure:** have Worker D randomly fail (~30% of runs) showing a red ❌ with error message "Faker seed error: circular reference in education[]" and a **"Retry"** button that retries ONLY that worker while everything else stays ✓. The project never fails as a whole.
- Overall progress bar + "Generation feels active" micro-copy.

### 6. Success / Project Page (Artifact Registry view)
- Header: project name, version badge (v1), expiration countdown, "Regenerate" and "Download ZIP" buttons.
- **Hosted API card:** fake URL like `https://api.InstantMockAPI.dev/p/cx7k2m/customers`, copy button, method chips for the selected verbs, and a mini request playground: pick method + endpoint, click "Send", show a realistic fake JSON response in a code block.
- **Artifact grid** — one card per artifact (Internal Schema, JSON Schema, Zod, Yup, TypeScript, Mock Data, OpenAPI, Postman, Hosted API, Export Bundle), each with: status chip, version, generated timestamp, worker ID, and buttons: **View** (opens a modal with realistic syntax-highlighted generated code for that artifact — write real plausible Zod/TS/JSON Schema output for a Customer entity), **Regenerate** (per-asset checkbox regeneration modal: ☑ Zod ☐ Types ☐ Mock API ☐ OpenAPI), **Download**.
- **Version history panel:** v1 → v2 with "Restore" buttons; editing the schema and regenerating bumps the version.

### 7. Expired State
- When a project expires (add a demo "Force expire" dev button in Settings), the project page shows: hosted API card grayed out with "Hosted assets deleted", artifacts marked expired, but the schema tree and config fully intact, with a single accent **"Generate Again"** button that jumps straight to the Progress screen.

### 8. Settings & Billing (light)
- Plan comparison table: Free (2-day expiry, 1 concurrent job), Pro (7-day, 3 jobs), Enterprise (30-day, unlimited) — with "hard delete of hosted assets after expiry, project shell always kept" noted.
- Theme toggle, fake profile.

## Behavior Rules (make the prototype feel real)

1. All state in memory (React state) — creating a project from the wizard actually adds it to the dashboard.
2. Parsing pasted JSON should genuinely infer the field tree (walk the JSON, detect types, detect email/url by key name) and feed the Review screen.
3. Generated code shown in artifact modals must be derived from the actual schema the user built (at minimum interpolate entity/field names into Zod/TS templates).
4. The mock request playground returns data generated from the schema (faker-style values matching field types).
5. Only the workers matching the user's config selections appear on the Progress screen (selective generation).
6. Countdown timers tick live.
7. Everything navigable with no dead ends: every button leads somewhere or shows a toast.

## Sample Nested Schema to Pre-load in the Builder (demo data)

Customer entity: `primaryDetail { name (string, required, min 3), email (email, required) }`, `addresses[] { type (enum: home|work), location { country, state, city } }`, `education[] { college { name, address { city } } }` — demonstrating objects, arrays of objects, and 4-level nesting.

Prioritize the core loop (Builder → Config → Review → Progress → Project page) as flawless; Templates and Billing can be lighter. Ship it as a polished multi-screen prototype I can click through in a demo.
