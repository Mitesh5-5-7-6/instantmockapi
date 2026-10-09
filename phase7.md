# PHASE 7: AI API Builder

Implement Phase 7 of InstantMockAPI.

The goal is to add an AI-assisted API creation workflow where a user can describe an API in natural language and receive a validated, generated, hosted Mock API.

The core principle is:

> **AI proposes. The platform validates. The Blueprint becomes the contract. The deterministic engine executes.**

Do not build a second project-generation system.

Reuse the existing canonical Project Definition, validation, versioning, dependency graph, generation pipeline, authentication system, blueprint system, and hosted API runtime.

---

# 1. Product Goal

A user should be able to write:

> Create a hospital API with patients, doctors and appointments.

The system should produce:

- entities
- fields
- relationships
- validation rules
- API endpoints
- mock data configuration

Then validate the result and use the existing deterministic generation pipeline to create the hosted API.

Target experience:

```text
Natural Language
       ↓
AI API Design
       ↓
Structured Blueprint
       ↓
Deterministic Validation
       ↓
Canonical Project Definition
       ↓
Mock Data Generation
       ↓
Seed Data Validation
       ↓
Generation
       ↓
Hosted Mock API
```

---

# 2. Wizard UX

Keep the initial wizard extremely simple.

## Step 1: Create Mock API

Display:

```text
Create Mock API

[ Paste JSON ] [ Swagger ] [ Describe it ]
```

The initial AI workflow is:

```text
Describe it
```

Do not add unnecessary configuration before the user has described what they want.

---

# 3. Step 2: Describe API

Display:

```text
Describe your API

[ a hospital management system with
  patients, doctors, departments and
  appointments ]

                    [Generate API]
```

The input should support natural language.

Examples:

```text
Create a hospital API with patients,
doctors and appointments.
```

```text
Create an e-commerce API with users,
products, categories, orders and payments.
```

```text
I need a simple blog API with authors,
posts, comments and tags.
```

The AI should infer a reasonable initial data model but must not silently invent important business requirements.

---

# 4. AI Agent Responsibilities

The AI is responsible for:

- understanding the user's description
- identifying likely entities
- proposing fields
- proposing relationships
- proposing validation rules
- proposing CRUD endpoints
- identifying ambiguity
- asking clarifying questions when necessary
- producing the structured API Blueprint

The AI is NOT responsible for directly:

- writing MongoDB documents
- creating MongoDB collections
- creating runtime routes
- deploying services
- modifying Redis
- creating authentication secrets
- bypassing validation
- bypassing versioning
- mutating the canonical project directly without validation

The AI output must pass through the same deterministic platform machinery used by the normal UI.

---

# 5. AI Output Contract

Do not allow free-form AI text to become the project definition.

The AI must produce a structured object conforming to a strict schema.

Conceptually:

```text
AI
 ↓
AI API Blueprint
 ↓
Schema validation
 ↓
Normalization
 ↓
Canonical Project Definition
```

The Blueprint should contain:

```text
entities
fields
relationships
validation
endpoints
generation configuration
authentication configuration when explicitly requested
```

Do not allow platform identity fields inside the generated blueprint:

```text
projectId
publicId
ownerId
slug
credentials
secrets
runtime credentials
```

Follow the Phase 4 Blueprint security rules.

User schema fields such as:

```text
apiKey
password
token
```

remain valid when they are actual fields in the user's data model.

Do not reject those merely because their names resemble credentials.

---

# 6. Clarification System

The AI should not ask questions unnecessarily.

Use this rule:

### Low-risk ambiguity

Make a reasonable assumption.

Example:

```text
"Create a blog API."
```

The AI may generate:

```text
User
Post
Comment
```

with reasonable fields.

### High-impact ambiguity

Ask the user.

Examples:

```text
Should appointments belong to one doctor only,
or can multiple doctors participate?
```

```text
Should users authenticate with email/password?
```

```text
Should an order support multiple products?
```

The AI should prefer a useful default when the ambiguity does not materially affect the API contract.

When clarification is required, show the question in the wizard/chat rather than generating an incorrect project silently.

---

# 7. Generated Blueprint Review

After successful AI generation, show:

```text
Generated API Blueprint

Patients          6 fields
Doctors           7 fields
Departments       4 fields
Appointments      6 fields

Relations

Patient → Appointment
Doctor → Appointment
Department → Doctor

                    [Review Blueprint]
```

The user must be able to inspect:

- entities
- fields
- field types
- required status
- defaults
- validation
- relationships
- endpoint methods
- endpoint paths
- visibility/auth requirements

Reuse existing Project API editor components wherever possible.

Do not create a second editor specifically for AI-generated projects.

---

# 8. Blueprint Review Is a Safety Boundary

AI output is considered untrusted input.

Before creating or mutating a project:

```text
AI output
   ↓
Schema validation
   ↓
Canonical normalization
   ↓
Deterministic IPS validation
   ↓
Dependency validation
   ↓
Blueprint accepted
```

AI-generated data must never bypass:

- IPS validation
- relationship validation
- field validation
- endpoint validation
- authentication validation
- version rules
- dependency graph rules

If validation fails, return structured errors to the AI layer so it can repair the proposal where safe.

---

# 9. Canonical Project Definition

Once the Blueprint passes validation:

```text
Blueprint
    ↓
Canonical Project Definition
```

The canonical Project Definition remains the single source of truth.

Do not introduce:

```text
AIProject
AIBlueprint
AIProjectDefinition
```

as a competing persistent project model.

The AI layer is an interface over the existing project-definition system.

---

# 10. Mock Data Generation

After Blueprint approval:

```text
Generate Mock Data
```

Display progress:

```text
Generating realistic data...

Patients        50
Doctors         20
Departments      5
Appointments   100
```

The generated data must respect:

- field types
- required fields
- defaults
- min/max
- regex
- enums
- relationships
- uniqueness
- foreign-key/reference constraints
- endpoint/runtime expectations

Do not treat AI-generated mock data as trusted.

---

# 11. Seed Data Validation

Generated mock data must pass deterministic validation before storage.

```text
Mock Data
    ↓
Schema validation
    ↓
Relationship validation
    ↓
Uniqueness validation
    ↓
Seed validation
    ↓
Store
```

If seed validation fails:

```text
Mock Data
    ↓
Validation failure
    ↓
Regenerate affected data
    ↓
Validate again
```

Do not store invalid seed data merely because an AI generated it.

---

# 12. Database Storage

After successful validation:

```text
Validated Project Definition
        +
Validated Mock Data
        ↓
MongoDB
```

MongoDB remains the source of truth.

Redis remains infrastructure only.

Do not use the AI layer as persistent project state.

---

# 13. Generation

After the project is valid:

```text
Canonical Project Definition
        ↓
Existing generation pipeline
        ↓
Mock API
```

Use the existing generation architecture:

```text
JSON Schema
    ↓
Zod
    ↓
TypeScript
    ↓
Mock Data
    ↓
OpenAPI
    ↓
Postman
    ↓
Database/code artifacts
```

Do not create an AI-specific generator.

---

# 14. Versioning

AI-created projects must follow the existing versioning rules.

Use:

```text
Draft
 ↓
Generate
 ↓
READY
 ↓
Explicit Publish
 ↓
Published
```

Do not allow AI generation to automatically replace the currently published version.

If the AI modifies an existing project:

```text
Current Published Version
        ↓
AI proposal
        ↓
Draft modification
        ↓
Diff / impact analysis
        ↓
Generate
        ↓
READY
        ↓
Explicit Publish
```

Existing dependency-aware selective regeneration must continue to work.

---

# 15. Existing Project Agent

Phase 7 should support two contexts.

## Create mode

```text
User
 ↓
"Create a hospital API..."
 ↓
AI
 ↓
New Project Definition
```

## Existing project mode

```text
User
 ↓
"Add insurance claims to my hospital API"
 ↓
AI inspects current project context
 ↓
AI asks clarification if necessary
 ↓
AI proposes changes
 ↓
Blueprint / structured changes
 ↓
Existing validation
 ↓
Existing diff engine
 ↓
Draft version
```

The AI must inspect the actual canonical project definition rather than relying on conversation memory.

---

# 16. AI Context

Create a clean project-context interface for the AI.

Conceptually:

```text
ProjectContext

project
version
entities
fields
relationships
endpoints
authentication
generation
```

The AI may use this context to answer questions such as:

```text
What entities exist?
```

```text
What fields does Patient have?
```

```text
Does Appointment already reference Doctor?
```

```text
Is authentication enabled?
```

Exact structured project information should come from the canonical project definition.

Semantic documentation can later come from the existing Technical Notes / AI Context / vector retrieval architecture.

Do not dump the entire MongoDB database into an LLM prompt.

---

# 17. Agent Architecture

Keep the AI system behind an abstraction.

Conceptually:

```text
Chat / Agent UI
       ↓
Agent Service
       ↓
Intent / Planning
       ↓
Project Context
       ↓
AI Provider
       ↓
Structured Blueprint / Change Proposal
       ↓
Deterministic Validation
       ↓
Canonical Project Definition
```

The AI provider must be replaceable.

Do not hard-code the entire platform around one LLM vendor.

Use an abstraction such as:

```ts
interface LLMProvider {
  generateStructured<T>(input: AgentInput, schema: Schema<T>): Promise<T>;
}
```

The exact interface should match existing project conventions.

---

# 18. AI Provider Independence

The future architecture must support:

- external LLM provider
- self-hosted LLM
- internal/custom model

without changing the canonical Project Definition or generation pipeline.

The LLM is an intelligence layer.

It is NOT the source of truth.

---

# 19. Customer Chat vs Project Agent

Keep these logically distinct:

```text
ChatSystem
├── SUPPORT
└── PROJECT_AGENT
```

They may share UI infrastructure.

Support chat should answer product/help questions.

Project Agent should be authorized to inspect and propose modifications to the user's project.

Do not allow support conversations to mutate project state.

---

# 20. Security

AI input must be treated as untrusted.

Protect against:

- prompt injection
- cross-project data access
- unauthorized project modification
- secret leakage
- system prompt leakage
- tool abuse
- arbitrary database operations
- arbitrary code execution

Every project-context request must verify project ownership/access server-side.

The AI must never receive:

- passwords
- password hashes
- auth secrets
- API keys
- Redis credentials
- MongoDB credentials
- AWS credentials
- internal service credentials

A user's legitimate schema field called `apiKey` is not itself a platform credential and may remain in project context according to the normal project-schema rules.

---

# 21. Tool Permissions

Do not initially give the AI arbitrary backend tools.

Prefer narrowly scoped operations such as:

```text
inspect_project
inspect_entity
inspect_fields
propose_blueprint
validate_blueprint
create_draft
generate_version
```

Do NOT expose:

```text
execute_arbitrary_mongo_query
execute_shell
execute_arbitrary_code
modify_any_project
read_any_project
```

All mutations must pass through existing authorization and validation.

---

# 22. Final User Experience

After successful generation:

```text
🎉 Your Mock API is ready

Base URL

https://api.yourdomain.com/mock/abc123

GET  /patients
GET  /doctors
GET  /departments
GET  /appointments

[Open API] [Copy Base URL]
```

The user should be able to immediately call:

```text
GET /patients
```

and receive realistic mock data.

The killer demo is:

```text
Describe API
      ↓
AI creates model
      ↓
Review
      ↓
Generate data
      ↓
Hosted API
      ↓
GET /patients
      ↓
Real response
```

---

# 23. Example End-to-End Flow

Input:

```text
Create a hospital management API with
patients, doctors, departments and
appointments.
```

AI proposes:

```text
Patients
- id
- name
- dateOfBirth
- gender
- phone
- email

Doctors
- id
- name
- specialization
- departmentId
- email
- phone

Departments
- id
- name
- description

Appointments
- id
- patientId
- doctorId
- appointmentDate
- status
- notes
```

Relationships:

```text
Department
    ↓
Doctor

Patient
    ↓
Appointment
    ↑
Doctor
```

Endpoints:

```text
GET    /patients
POST   /patients
GET    /patients/:id
PATCH  /patients/:id
DELETE /patients/:id

GET    /doctors
POST   /doctors
GET    /doctors/:id
PATCH  /doctors/:id
DELETE /doctors/:id

GET    /departments
POST   /departments
GET    /departments/:id
PATCH  /departments/:id
DELETE /departments/:id

GET    /appointments
POST   /appointments
GET    /appointments/:id
PATCH  /appointments/:id
DELETE /appointments/:id
```

The exact structure is only an example. The implementation must derive the actual structure through the same canonical project-definition and endpoint systems already used by the product.

---

# 24. Failure Handling

AI generation must never leave the project in a partially mutated state.

If:

```text
AI generation succeeds
but
validation fails
```

the project remains unchanged.

If:

```text
Blueprint valid
but
mock data generation fails
```

do not publish the incomplete version.

If:

```text
Generation fails
```

the existing published version remains active.

Use the existing versioning and job-state machinery.

---

# 25. Phase 7 Scope

Implement:

- natural-language API creation
- structured AI Blueprint generation
- deterministic Blueprint validation
- clarification questions
- Blueprint review
- mock-data generation
- seed-data validation
- existing generation pipeline integration
- AI project context
- create-project Agent workflow
- existing-project proposal workflow
- provider abstraction
- security boundaries
- existing versioning integration

Do NOT implement yet:

- autonomous multi-step agents
- arbitrary tool execution
- autonomous production deployment
- arbitrary code execution
- autonomous database administration
- billing AI
- team administration AI
- OAuth/SSO
- voice agent
- multi-agent orchestration
- custom model training
- vector infrastructure replacement
- a second project-definition system

---

# 26. Architecture Invariant

The final architecture must remain:

```text
                     User
                       │
                       ▼
                  AI Agent
                       │
                       ▼
              Structured Blueprint
                       │
                       ▼
          Deterministic Validation
                       │
                       ▼
          Canonical Project Definition
                       │
          ┌────────────┴────────────┐
          ▼                         ▼
   Existing Versioning       Existing Generator
          │                         │
          │                         ▼
          │                    Mock Data
          │                         │
          │                         ▼
          │                   Seed Validation
          │                         │
          └────────────┬────────────┘
                       ▼
                    MongoDB
                       │
                       ▼
                Hosted Mock API
                       │
                       ▼
                     User
```

## Final principle

> **The AI should be an interface over InstantMockAPI, not the foundation underneath it.**

The existing deterministic platform remains responsible for correctness, persistence, validation, versioning, generation, and deployment. The AI provides natural-language understanding, planning, clarification, and structured proposals.
