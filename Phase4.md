# PHASE 4 — Technical Notes + Blueprint

## Objective

Implement **Phase 4: Technical Notes + Blueprint** for InstantMockAPI.

Phase 4 adds:

```text
Project Definition
│
├── Technical Notes
│   ├── Human-readable documentation
│   └── AI-ready documentation (without use any AI can make Technical Notes.)
│
└── Blueprint
    ├── Export
    └── Import
```

The **canonical IPS / Project Definition remains the single source of truth**.

Technical Notes and Blueprint must be derived from the canonical project definition. They must never become an independent schema or silently mutate the project.

Do not redesign Phase 1, Phase 2, or Phase 3 architecture.

---

# 1. Non-Negotiable Rules

### Canonical source

The canonical Project Definition remains authoritative for:

- entities
- fields
- field types
- stable IDs
- relationships
- validation
- API configuration
- endpoint configuration
- authentication configuration
- generation configuration
- version metadata

Technical Notes are a **projection** of the canonical definition.

Blueprints are a **portable serialized representation** of the canonical definition.

Never parse generated code to reconstruct project state.

Never use Technical Notes as project configuration.

Never create a second competing schema.

---

# 2. Technical Notes

Add a Technical Notes view for every project.

The document must explain the project clearly enough for:

1. a developer joining the project
2. an AI coding assistant
3. someone importing/reviewing the project later

Technical Notes should include:

## Project Overview

- project name
- description if available
- project type
- current version
- published version
- generation status
- authentication mode
- generation configuration summary

Do not expose:

- secrets
- signing keys
- refresh tokens
- access tokens
- password hashes
- API keys
- internal credentials
- Redis credentials
- database credentials

---

# 3. Data Model Documentation

For every entity document:

- entity name
- stable entity ID
- description if available
- authentication visibility
- fields
- relationships
- relevant validation rules

For every field document:

- stable field ID
- name
- type
- required/optional
- default
- validation rules
- nested/object structure where applicable
- relevant metadata

Example structure:

```text
User
  Authentication: Protected

  Fields
    id
      type: string
      required: true

    email
      type: string
      required: true
      validation: email

    age
      type: number
      required: false
      validation: min=18
```

Use actual project data, not generic placeholders.

---

# 4. Relationship Documentation

Document every relationship.

Include:

- relationship stable ID
- source entity
- target entity
- relationship type
- source field
- target field
- cardinality if represented by the canonical model
- relevant cascade/reference behavior if represented

Make relationships understandable without opening the schema editor.

---

# 5. API Documentation

Document every enabled API endpoint.

For each endpoint include:

- stable endpoint ID
- HTTP method
- path
- entity
- authentication requirement
- enabled/disabled state
- request schema
- response schema
- relevant query parameters
- path parameters
- validation behavior
- example request
- example response

Authentication must use the **resolved runtime behavior**, not raw `entity.authentication`.

For example:

```text
GET /payment/{id}
Authentication: Required
```

not merely:

```text
Entity authentication: PROTECTED
```

This matters for:

- ALL_PUBLIC
- ALL_PROTECTED
- COMBINATION

---

# 6. Authentication Documentation

When authentication is enabled, document:

- authentication mode
- signup endpoint
- signin endpoint
- refresh endpoint
- me endpoint
- logout endpoint
- access-token lifetime
- refresh-token lifetime
- cookie authentication enabled/disabled
- configured user fields
- protected entities

Never document:

- signing secrets
- actual JWTs
- refresh tokens
- password hashes
- session hashes

Document configuration, never credentials.

When authentication is disabled, clearly state:

```text
Authentication: Disabled
```

Do not generate misleading auth sections.

---

# 7. AI-Ready Documentation

Add an **AI-ready** version of Technical Notes.

The purpose is to allow a developer to copy/export project context into an AI coding assistant.

It should be:

- deterministic
- structured
- concise
- explicit
- unambiguous
- stable across repeated generation

Prefer a structure such as:

```markdown
# Project Context

## Project

Name:
Type:
Version:

## Authentication

Mode:
Cookie Auth:
Access Token TTL:
Refresh Token TTL:

## Entities

### User

ID:
Authentication:

#### Fields

- id | string | required
- email | string | required | email
- age | number | optional | min=18

## Relationships

- User.posts -> Post.userId | one-to-many

## APIs

- GET /users | public
- GET /users/{id} | protected
- POST /users | protected

## Generation

...
```

Do not add conversational prose such as:

> "Here is a detailed overview of your project..."

AI-ready output should contain project facts, not assistant-style filler.

---

# 8. Deterministic Documentation

Documentation generation must be deterministic.

The same canonical Project Definition must produce the same Technical Notes content.

Sort where necessary:

- entities by stable ID
- fields by stable ID
- relationships by stable ID
- endpoints by stable ID

Do not depend on:

- database insertion order
- object iteration order where semantic ordering matters
- generated timestamps
- random IDs
- runtime state

If timestamps are included, clearly separate them from canonical project content.

---

# 9. Documentation Generation Architecture

Create a dedicated documentation generation module.

Prefer:

```text
IPS
 ↓
Documentation Model
 ↓
Markdown Renderer
 ↓
Technical Notes
```

Do not build Markdown directly from scattered UI components.

The documentation model should be testable independently.

The UI should consume the generated documentation rather than reconstructing it itself.

---

# 10. Technical Notes UI

Add a project-level **Technical Notes** section/tab.

Provide:

- rendered Markdown/document view
- raw Markdown view
- copy
- download `.md`
- AI-ready view
- copy AI-ready documentation
- download AI-ready `.md`

Keep the UI consistent with the existing dark developer dashboard.

Do not introduce a new visual system.

Use the existing design tokens.

---

# 11. Blueprint

Implement portable **Blueprint Export and Import**.

A Blueprint represents the canonical project definition required to recreate a project.

Blueprints are NOT generated source-code archives.

Blueprints must contain project configuration, not generated runtime artifacts.

---

# 12. Blueprint Contents

A Blueprint should contain:

```text
Blueprint
├── blueprintVersion
├── schemaVersion
├── metadata
├── project
├── entities
├── fields
├── relationships
├── API configuration
├── endpoint configuration
├── authentication configuration
├── generation configuration
└── version metadata where appropriate
```

Preserve stable IDs where they are part of the canonical definition.

Do not include:

- database credentials
- MongoDB connection strings
- Redis credentials
- JWT signing keys
- auth secrets
- API keys
- access tokens
- refresh tokens
- password hashes
- session hashes
- generated ZIP files
- generated source code
- runtime database records
- private infrastructure configuration

A blueprint must be safe to export and share.

---

# 13. Blueprint Versioning

Blueprints require explicit versioning.

Example:

```json
{
  "blueprintVersion": 1,
  "schemaVersion": "1.x",
  "project": {},
  "entities": []
}
```

Do not rely solely on the application version.

Implement:

```text
validateBlueprint()
migrateBlueprint()
normalizeBlueprint()
```

Import flow:

```text
Raw Blueprint
    ↓
Parse
    ↓
Validate blueprintVersion
    ↓
Validate schema
    ↓
Migrate older versions if supported
    ↓
Normalize
    ↓
Validate canonical IPS rules
    ↓
Create project
```

Never partially import an invalid blueprint.

---

# 14. Import Safety

Blueprint import must be transactional.

If validation fails:

- create nothing
- do not partially create entities
- do not partially create relationships
- do not create generation jobs
- do not publish anything

Return structured validation errors.

Errors should identify:

- path
- field
- reason

Example:

```text
entities[1].fields[2].type
Invalid field type
```

Reuse existing validation/error-normalization infrastructure where possible.

Do not create a second error system.

---

# 15. Blueprint Import Behavior

Importing a blueprint creates a **new project**.

Do not automatically overwrite an existing project.

The imported project must receive:

- a new project ID
- new runtime secrets where required
- new authentication secret
- new generated runtime state

Preserve canonical IDs only where required for blueprint semantics.

Never copy runtime credentials from the source project.

---

# 16. Authentication + Blueprint

Authentication configuration is portable.

Authentication secrets are not.

For example, export:

```text
authentication:
  mode: ALL_PROTECTED
  accessTokenExpiresIn: 15m
  refreshTokenExpiresIn: 7d
  cookieAuth: true
```

but never:

```text
secret:
  signingKey: ...
```

After import:

```text
Blueprint
    ↓
New Project
    ↓
New MockAuthSecret
```

The imported project must not share signing secrets with the original project.

---

# 17. Blueprint Export Formats

Support:

### JSON

```text
Download Blueprint
```

produces:

```text
project.blueprint.json
```

### Copy JSON

Provide a copy-to-clipboard action.

### Markdown

Provide a Markdown export of Technical Notes.

Do not make Markdown the canonical import format.

JSON is the machine-readable blueprint format.

---

# 18. Project Actions

Add project actions:

```text
Technical Notes
AI Context
Export Blueprint
Import Blueprint
Duplicate Project
```

Do not duplicate these actions across multiple unrelated locations.

Use the existing project action/menu patterns.

---

# 19. Duplicate Project

Implement Duplicate Project using the Blueprint/canonical-definition pathway rather than manually copying individual database documents.

Conceptually:

```text
Existing Project
    ↓
Canonical Blueprint
    ↓
Validate / Normalize
    ↓
Create New Project
    ↓
Generate new runtime secrets
```

Do not copy:

- users
- sessions
- auth secrets
- generated mock records
- generation jobs
- private runtime state

The duplicate is a new project definition.

---

# 20. Versioning Integration

Technical Notes must be version-aware.

When viewing a historical version:

```text
Technical Notes
```

must describe that version's canonical definition.

When viewing the current draft:

```text
Technical Notes
```

must describe the draft.

When viewing the published version:

```text
Technical Notes
```

must describe the published version.

Never accidentally combine draft configuration with published runtime configuration.

Use the existing Phase 2 version model.

Do not modify the semantics of:

```text
publishedVersionId
```

or introduce another publication mechanism.

---

# 21. Diff Integration

Technical Notes should work with Phase 2 visual diff.

Where useful, provide:

```text
View Changes
```

from Technical Notes.

Do not implement a second diff engine.

Reuse the existing:

```text
ChangeKind
risk
aspect
classifyImpact
```

infrastructure.

Authentication changes must use the existing Phase 3 auth diff behavior.

---

# 22. Hosted Runtime Separation

Technical Notes and Blueprint functionality must never expose runtime secrets.

Hosted runtime configuration may contain resolved behavior such as:

```text
requiresAuth: boolean
```

but Blueprint/Technical Notes must derive from canonical configuration.

Do not copy hosting secrets into the documentation or blueprint.

---

# 23. Expired Hosted APIs

Hosted API expiration must not destroy the canonical project definition.

After hosted runtime expiry:

- retain the project definition
- retain Technical Notes capability
- retain Blueprint export
- retain enough metadata to recreate the hosted API
- remove heavy runtime/generated data according to the existing retention policy

A user should be able to recreate the hosted runtime from the canonical definition.

Do not resurrect expired runtime automatically.

---

# 24. API Design

Add minimal project APIs for:

```text
GET    /projects/:id/technical-notes
GET    /projects/:id/technical-notes/ai
GET    /projects/:id/blueprint
POST   /projects/:id/blueprint/import
POST   /projects/:id/duplicate
```

Adjust naming to match existing API conventions.

All endpoints must:

- verify project ownership/access
- respect existing platform authorization
- never expose secrets
- use existing error handling
- use existing validation
- follow existing response conventions

Do not introduce unnecessary endpoints if an existing project-definition API can safely serve the same purpose.

---

# 25. Testing Requirements

## Technical Notes

Test:

- every entity appears
- every field appears
- field type appears
- required/default values appear
- validation appears
- relationships appear
- endpoints appear
- methods and paths appear
- resolved authentication appears
- disabled authentication does not produce misleading auth data
- deterministic output
- stable ordering
- no secrets
- no tokens
- no passwords/password hashes

## AI-ready documentation

Test:

- deterministic output
- complete project context
- explicit auth state
- explicit endpoint visibility
- relationships
- validation
- no secrets
- no runtime credentials

## Blueprint

Test:

- export contains canonical definition
- export excludes secrets
- export excludes runtime state
- export/import round trip preserves semantics
- stable IDs preserved where required
- invalid blueprint rejected
- unsupported blueprint version rejected
- migration works for supported older blueprint versions
- malformed fields rejected
- malformed relationships rejected
- malformed endpoints rejected
- malformed auth configuration rejected
- import is transactional
- imported project gets a new project ID
- imported project gets a new auth secret
- source and imported project cannot share auth secrets

## Duplicate

Test:

- new project created
- canonical definition preserved
- users not copied
- sessions not copied
- auth secret not copied
- runtime records not copied
- generated artifacts not copied unless explicitly required by existing architecture
- new project is independently editable

---

# 26. Critical Security Tests

Add explicit tests proving:

```text
Blueprint export
    ≠
secret export
```

Search the serialized blueprint and generated Technical Notes for:

- JWT secrets
- auth signing keys
- refresh tokens
- access tokens
- passwordHash
- session hashes
- database URLs
- Redis URLs
- API keys

The test should fail if any forbidden credential field appears.

Also test:

```text
Project A Blueprint
        ↓
Import
        ↓
Project B
```

and prove:

```text
Project A auth secret !== Project B auth secret
```

and:

```text
Project A token cannot authenticate against Project B
```

Reuse Phase 3's project-isolation behavior.

---

# 27. No Scope Creep

Do NOT implement in Phase 4:

- RBAC changes
- OAuth
- SSO
- MFA
- billing
- team collaboration
- AI generation
- AI chat
- code generation changes
- new authentication providers
- Kubernetes
- new database architecture
- redesign of the generator
- a new versioning system
- a second project-definition schema

AI-ready documentation means **documentation formatted for AI consumption**.

It does not mean building an AI product.

---

# 28. Implementation Strategy

Before changing code:

1. inspect the existing IPS types
2. inspect versioning/version snapshots
3. inspect Phase 3 authentication configuration
4. inspect existing project APIs
5. inspect existing error normalization
6. inspect existing project UI/navigation
7. inspect existing export/download utilities
8. inspect existing validation
9. identify reusable infrastructure

Then implement in this order:

### Stage 1

Documentation model + deterministic Technical Notes generator.

### Stage 2

AI-ready documentation.

### Stage 3

Technical Notes UI and export.

### Stage 4

Blueprint schema + validation + normalization.

### Stage 5

Blueprint export.

### Stage 6

Blueprint import.

### Stage 7

Duplicate Project through Blueprint pathway.

### Stage 8

Version-aware documentation.

### Stage 9

Integration tests + security/adversarial tests.

Do not jump directly into UI before understanding the canonical data model.

---

# 29. Acceptance Criteria

Phase 4 is complete only when:

- Technical Notes accurately describe the canonical project definition.
- AI-ready documentation is deterministic and machine-friendly.
- Technical Notes can be copied/downloaded.
- Blueprint can be exported as JSON.
- Blueprint can be imported into a new project.
- Blueprint import is validated and transactional.
- Blueprint round-trip preserves project semantics.
- Authentication configuration is preserved.
- Authentication secrets are never exported.
- Imported projects receive new runtime secrets.
- Duplicate Project creates an independent project.
- Users/sessions/runtime state are never accidentally copied.
- Historical version documentation works.
- Draft documentation does not accidentally describe published state.
- Published documentation does not accidentally describe draft state.
- Existing Phase 2 version semantics remain unchanged.
- Existing Phase 3 authentication isolation remains unchanged.
- No generated artifact becomes the source of truth.
- No second project-definition schema is introduced.
- All relevant tests pass.
- Typecheck passes.
- Lint passes.
- Build passes.
- Dependency architecture checks pass.

## Final architectural invariant

The implementation must preserve:

```text
                    Canonical Project Definition
                              │
              ┌───────────────┴────────────────┐
              ↓                                ↓
      Technical Notes                     Blueprint
              │                                │
       ┌──────┴──────┐                    Export / Import
       ↓             ↓                         │
    Human          AI-ready                   ↓
    Docs            Docs                 New Project
```

Never:

```text
Generated Code → Technical Notes → Project Definition
```

Never:

```text
Technical Notes → Project Definition
```

Never:

```text
Blueprint → Runtime Secrets
```

The canonical Project Definition remains the single source of truth throughout Phase 4.
