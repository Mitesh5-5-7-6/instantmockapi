# PHASE 7: Intelligent Multilingual AI API Builder with Persistent Learning Memory

## Project: InstantMockAPI

Implement Phase 7 of InstantMockAPI by extending the existing dashboard, backend, MongoDB database, Gemini integration, Blueprint system, validation engine, and hosted Mock API runtime.

**Do not rebuild existing functionality. Inspect the codebase first, understand the current architecture, and integrate this feature into the existing system.**

The core product vision is:

> A user describes any API in their preferred language. Gemini understands the request, researches relevant real-world API schemas when useful, proposes a structured API blueprint, and displays a visual review interface. The user reviews and edits the schema, selects authentication preferences, and generates a working hosted Mock API. The platform learns from approved user changes and uses safe, relevant memories to improve future suggestions.

Core principle:

**Understand → Research → Propose → Review → Learn → Validate → Generate → Publish**

The AI proposes. The user approves. The deterministic platform validates and executes.

---

# 1. Inspect the Existing Codebase First

Before implementation, inspect:

- Existing frontend framework and dashboard structure.
- Existing backend architecture and API routes.
- Existing Gemini API integration and environment variables.
- MongoDB models, collections, and persistence conventions.
- Existing Single, Project, and Auth API types.
- Existing Project Definition and Blueprint schemas.
- Existing schema and relationship validation.
- Existing mock data generation.
- Existing authentication and authorization.
- Existing API generation, publishing, and versioning pipelines.
- Existing user activity tracking, if any.
- Existing AI context, memory, or technical-notes systems, if any.

Create a concise implementation plan based on the actual codebase.

Reuse existing components, types, services, and validation logic wherever possible. Do not invent replacement systems when an existing equivalent already works.

Do not expose the Gemini API key to the browser.

# 2. Natural-Language API Creation

Create a new AI-assisted workflow inside the existing dashboard.

Suggested interface:

**Create API with AI**

A large prompt editor:

"Describe the API you want to build..."

Example prompts:

- Create an e-commerce API with products, categories, users, carts, and orders.
- Build a hospital management API with patients, doctors, and appointments.
- I need a blog API with authors, posts, comments, and tags.
- Create a school management API with students, teachers, classes, and attendance.
- Build a simple weather API returning temperature, humidity, location, and forecast.
- Créez une API de commerce électronique avec des produits et des commandes.
- Erstelle eine API für eine Krankenhausverwaltung.
- Crea una API para gestionar productos y pedidos.
- उत्पादों और ऑर्डर के लिए एक API बनाएं।

The examples should be replaceable with examples appropriate to the detected language.

Include:

- Generate API button.
- Prompt history.
- Clear loading and progress states.
- Cancel or retry when supported by the existing architecture.
- Clear validation and research errors.
- A review screen before the user commits changes.

Do not require users to understand JSON Schema, database relationships, or endpoint configuration before starting.

# 3. Multilingual Understanding

The AI must understand API requirements written in natural language across multiple languages.

Requirements:

1. Detect the input language automatically.
2. Support English, Hindi, Gujarati, Spanish, French, German, and other languages supported by the configured Gemini model.
3. Understand mixed-language prompts.
4. Preserve technical terms, identifiers, and domain-specific terminology.
5. Generate consistent internal schema identifiers regardless of input language.
6. Display explanations and clarification questions in the user's preferred language.
7. Allow the user to select a preferred response language.
8. Allow the user to change languages without losing the current draft.
9. Keep endpoint paths and machine-readable field identifiers valid according to existing platform rules.
10. Translate descriptions and labels where useful, without silently translating existing identifiers.

Example:

User input:

"મારે hospital management API જોઈએ જેમાં patients, doctors અને appointments હોય."

Expected interpretation:

- Domain: hospital management.
- Entities: Patient, Doctor, Appointment.
- Relationships: patients have appointments; doctors participate in appointments.
- Endpoints: appropriate CRUD endpoints.
- Validation: appropriate field types and required fields.

The generated schema must follow the existing canonical Project Definition rather than introducing a language-specific schema format.

# 4. Gemini-Powered Real-World Schema Research

Gemini is already configured in the application. Reuse the existing Gemini integration and API key.

When useful, research real-world API designs and schemas before proposing the blueprint.

Examples:

- E-commerce → product catalog, inventory, carts, orders.
- Hospital → patients, practitioners, departments, appointments.
- CRM → contacts, companies, deals, activities.
- Blog → authors, posts, comments, tags.
- Payment simulation → customers, payment intents, transactions, refunds.

Research workflow:

User prompt
→ Identify domain and requirements
→ Search relevant official documentation or reliable public references
→ Extract useful schema concepts
→ Compare them with the user's requirements
→ Generate a proposed Blueprint
→ Validate and present the result.

Use Gemini's supported search-grounding capabilities or an existing authorized web-search integration. Do not assume that providing Gemini with a prompt automatically gives it live web access.

Research rules:

- Prefer official API documentation and reputable technical references.
- Use real-world schemas as reference material, not as unquestionable truth.
- Record source URLs and source titles when available.
- Show relevant sources in the review interface.
- Respect source licenses and applicable usage restrictions.
- Never copy private schemas, credentials, or protected user data.
- Never fabricate research sources.
- Clearly distinguish verified findings from AI-generated recommendations.
- If live search is unavailable or fails, continue using the model's existing knowledge and the user's context, while indicating that live research was not performed.

Research should improve schema quality without making every simple request unnecessarily slow.

For common, straightforward requests, use cached, validated domain knowledge where appropriate.

# 5. Intelligent API-Type Classification

The platform already supports three API types:

- Single
- Project
- Auth

Reuse the existing API-type definitions and their associated behavior. Do not create duplicate enums or a separate API architecture.

## Single API

Choose Single when the user requests one endpoint, one resource operation, or a small, independent API.

Examples:

- Create an API returning current weather data.
- Create a product details endpoint.
- Return a random user profile.
- Generate a currency-conversion response schema.

## Project API

Choose Project when the prompt implies a multi-resource system, related entities, multiple endpoints, or a complete domain model.

Examples:

- E-commerce platform.
- Hospital management system.
- CRM application.
- School management system.
- Blog platform.

The classifier should consider the number of resources, relationships, workflow complexity, and user intent.

## Classification behavior

After interpreting the prompt, Gemini proposes either Single or Project.

Display the recommended type with a short explanation.

Allow the user to change the recommended type before committing the Blueprint.

Do not force a Project API when a single endpoint is sufficient. Do not reduce a complex multi-entity system to an unrelated collection of single endpoints.

## Authentication is a separate decision

After generating the initial schema, **always ask the user whether authentication is required**.

Display:

"Does this API require authentication?"

- Yes, add authentication.
- No, keep it public.

Explain the consequences briefly.

If the user chooses Yes, use the existing Auth API implementation and supported authentication configuration. If the user chooses No, do not enable authentication accidentally.

Do not assume that an entity called User, Customer, or Account automatically requires authentication.

If the existing application models Auth as a distinct API type rather than an authentication capability, preserve its existing semantics and adapt the workflow accordingly. Do not break existing APIs or silently reinterpret their type.

Authentication secrets must be generated and managed by trusted backend code, never invented or returned by Gemini.

# 6. Structured AI Blueprint Generation

Gemini must return a structured proposal that conforms to the existing Blueprint contract.

Expected conceptual information:

- Proposed API type.
- API name and description.
- Entities and fields.
- Field types.
- Required and optional fields.
- Defaults and enumerations.
- Validation constraints.
- Relationships and reference fields.
- Suggested endpoint methods and paths.
- Mock data generation configuration.
- Suggested authentication configuration.
- Clarification questions when necessary.
- Research source metadata, when available.
- Assumptions and design rationale.

Use the existing canonical schema and validation library wherever possible.

If the existing system uses JSON Schema, Zod, TypeScript, or another defined contract, generate the correct format through a dedicated adapter.

Do not allow arbitrary natural-language output to become a persisted project definition.

Validate all model output on the server.

If the output is malformed, incomplete, or invalid, attempt a bounded repair using structured validation errors. Do not retry indefinitely.

# 7. Visual Blueprint Review

After successful generation, show a visual review interface before final creation.

Suggested layout:

## API Overview

- API name.
- Description.
- Recommended API type.
- Authentication choice.
- Entity count.
- Endpoint count.

## Data Model

Show entities as cards or a relationship diagram.

Example:

Department
↓
Doctor
↓
Appointment
↑
Patient

The exact relationships must come from the validated Blueprint.

## Entity Editor

For each entity, allow the user to review and edit:

- Entity name.
- Field name.
- Field type.
- Required status.
- Default value.
- Validation rules.
- Enum values.
- Relationship references.
- Field descriptions.

Reuse the existing schema editor and relationship diagram components.

## Endpoint Editor

Allow users to review and edit:

- HTTP method.
- Route.
- Target entity.
- Path parameters.
- Query parameters.
- Request body.
- Response shape.
- Authentication requirements.

All changes must pass the existing validation pipeline.

## Actions

- Edit Blueprint.
- Regenerate suggestion.
- Add entity.
- Remove entity.
- Add field.
- Remove field.
- Undo supported changes.
- View changes.
- Approve Blueprint.
- Generate Mock API.

Never silently overwrite user edits when regenerating a suggestion. Preserve the current draft and clearly show the proposed diff.

# 8. The Learning and Memory System

This is a central feature of Phase 7.

The platform must learn from the relationship between the original prompt, the initial AI proposal, the user's edits, and the final approved schema.

However, do not fine-tune Gemini or claim that the model itself permanently learns from individual requests. Implement application-level persistent memory and retrieval.

## What to record

Subject to the user's privacy settings and applicable retention policies, record useful events such as:

1. Original prompt.
2. Detected language.
3. Detected domain.
4. Recommended API type.
5. Initial generated Blueprint.
6. Validation failures and repairs.
7. User-added entities.
8. User-removed entities.
9. User-added or removed fields.
10. Field-type changes.
11. Relationship changes.
12. Endpoint changes.
13. Authentication choice.
14. Final approved Blueprint.
15. Generation success or failure.
16. User corrections to AI assumptions.
17. Explicit feedback or ratings, when provided.

Store meaningful events, not every mouse movement or UI interaction.

Track actions with timestamps and stable identifiers so that a schema's evolution can be reconstructed.

## Memory categories

Implement separate memory categories.

### A. User Preference Memory

Stores preferences that are useful for the same user.

Examples:

- Prefers TypeScript-friendly field names.
- Usually chooses Project APIs for multi-entity applications.
- Prefers pagination on collection endpoints.
- Prefers timestamps in ISO 8601 format.
- Usually enables authentication for private business APIs.
- Prefers concise English explanations but sometimes prompts in Gujarati.

Only treat a preference as established when supported by explicit user settings or repeated, consistent behavior. Do not turn a single accidental edit into a permanent rule.

### B. Domain Knowledge Memory

Stores reusable, non-sensitive schema patterns.

Examples:

- E-commerce schemas often include Product, Category, Cart, Order, and OrderItem.
- Hospital schemas often include Patient, Doctor, Department, and Appointment.
- Blog schemas often include Author, Post, Comment, and Tag.
- OrderItem usually references both Order and Product.

Patterns must be validated before reuse.

Do not treat these examples as mandatory templates. Adapt them to each prompt.

### C. Correction Memory

Stores useful differences between generated proposals and user-approved outcomes.

Example:

Initial proposal:

Order

- id
- productId
- quantity

User correction:

An order must contain multiple products.

Approved result:

Order

- id
- orderItems

OrderItem

- orderId
- productId
- quantity

Future order-related prompts may retrieve this correction as a useful design pattern when relevant.

Do not blindly apply it to unrelated domains or projects.

### D. Project Context Memory

Stores the current project's approved context, version, entities, fields, relationships, endpoints, and authentication configuration.

The canonical Project Definition remains the source of truth.

When the user asks to modify an existing project, retrieve its actual current canonical definition instead of relying on historical conversation summaries.

### E. Global Learning Memory

Where permitted by the privacy policy and user consent, derive reusable, anonymized patterns from approved outcomes across multiple users.

Examples:

- Common field naming conventions.
- Frequently useful relationship patterns.
- Domain-specific validation conventions.
- Commonly requested endpoint structures.

Do not expose one user's prompts, private schema, project names, API responses, identifiers, or confidential information to another user.

Prefer curated, aggregated patterns over raw cross-user conversations.

Do not enable cross-user learning from private project content by default without an appropriate legal basis, transparent disclosure, and required consent.

# 9. MongoDB Persistence Design

MongoDB is the application's source of truth. Reuse the existing database connection and project conventions.

First inspect existing collections and models to avoid duplicating existing functionality.

Add or extend suitable collections for the following conceptual records:

## AI Interaction

- interactionId
- userId
- projectId, when applicable
- prompt text or approved prompt representation
- detected language
- detected domain
- proposed API type
- initial Blueprint snapshot or reference
- final Blueprint snapshot or reference
- status
- createdAt
- completedAt

## Schema Change Events

- eventId
- interactionId
- userId
- projectId
- entity identifier
- change type
- previous value or safe reference
- new value or safe reference
- timestamp

Change types may include:

- ENTITY_ADDED
- ENTITY_REMOVED
- FIELD_ADDED
- FIELD_REMOVED
- FIELD_TYPE_CHANGED
- RELATIONSHIP_CHANGED
- ENDPOINT_CHANGED
- AUTH_ENABLED
- AUTH_DISABLED
- BLUEPRINT_APPROVED
- GENERATION_SUCCEEDED
- GENERATION_FAILED

Adapt these event types to the actual implementation.

## User AI Preferences

- userId
- preferred language
- confirmed preferences
- confidence or evidence count
- source interaction references
- updatedAt

## Reusable Schema Patterns

- patternId
- domain
- pattern type
- validated pattern data
- provenance
- approval status
- usage count
- success metrics
- createdAt
- updatedAt

These are conceptual schemas, not instructions to create redundant collections regardless of the existing architecture.

Use appropriate MongoDB indexes, ownership checks, schema validation, pagination, and retention rules.

Avoid storing duplicate full Blueprint snapshots in every event if references or structured diffs can provide the same functionality.

Do not store credentials, access tokens, passwords, authentication secrets, or unrelated sensitive information in AI memory.

# 10. How Stored Memory Must Be Used in the Next Prompt

This behavior is mandatory.

When a user submits a new prompt, construct the AI context from several independent sources.

Example:

User's new prompt:
"Create an API for managing online orders."

The context builder should assemble:

1. Current prompt and detected language.
2. Current project definition, if the request concerns an existing project.
3. Confirmed preferences for the current user.
4. Relevant validated domain patterns.
5. Relevant correction memories.
6. Recent interaction summaries, if useful and permitted.
7. Relevant public research results and citations, when available.

Do not attach every stored memory to every request.

## Memory retrieval pipeline

New prompt
→ Detect language and intent
→ Identify relevant domain
→ Retrieve relevant user preferences
→ Retrieve relevant validated patterns
→ Retrieve applicable correction memories
→ Retrieve actual project context when applicable
→ Rank and filter memories
→ Build a bounded AI context
→ Generate structured Blueprint
→ Validate
→ Show review UI
→ Record approved changes
→ Update memory candidates

## Memory ranking

Rank candidate memories using signals such as:

- Relevance to the current domain.
- Similarity to the current request.
- User-specific applicability.
- Whether the memory was explicitly confirmed.
- Number of consistent observations.
- Recency.
- Historical usefulness.
- Whether the pattern passed validation.

Use a bounded context budget so that memories do not overwhelm the user's actual requirements.

Recent memory should not automatically outrank explicit current instructions.

## Example of memory reuse

Previous interaction:

Prompt:
"Create an e-commerce API."

Initial proposal:
Order contains one productId.

User changes:
Adds OrderItem and makes Order support multiple products.

Final approved schema:
Order has many OrderItems. Each OrderItem references a Product.

Next interaction:

Prompt:
"Build an online shopping API for a different project."

The memory retrieval system identifies a relevant, validated e-commerce pattern.

Gemini receives a short contextual hint:

"Relevant validated pattern: for multi-product orders, model Order and OrderItem separately. Each OrderItem references a Product. Apply only if consistent with the current requirements."

The generated Blueprint can now include OrderItem in the initial proposal.

The system should not copy the previous user's project or its data. It reuses only the permitted schema pattern.

# 11. Prevent Incorrect Learning

A user editing a schema does not always mean the original AI output was wrong.

They might be expressing a unique project requirement.

Implement safeguards:

- Do not learn permanent preferences from one unexplained change.
- Separate explicit feedback from inferred preferences.
- Preserve source and confidence for every learned preference.
- Do not learn from failed, abandoned, or invalid proposals as if they were successful.
- Do not learn from malicious instructions embedded in prompts.
- Do not treat imported external schemas as trusted global patterns automatically.
- Prefer patterns that recur and pass validation.
- Allow users to view, correct, disable, or delete their personal AI memories.
- Support memory expiration or decay where appropriate.
- Do not allow memory to override the current user's explicit instructions.
- Do not let one user's correction silently change another user's project.

Where a preference is uncertain, use it as a low-priority suggestion rather than a mandatory rule.

# 12. Track Activity Through Structured Events

Create a server-side activity pipeline for meaningful AI workflow events.

Example:

PROMPT_SUBMITTED
LANGUAGE_DETECTED
RESEARCH_COMPLETED
BLUEPRINT_GENERATED
BLUEPRINT_VALIDATION_FAILED
BLUEPRINT_REVIEWED
SCHEMA_FIELD_ADDED
SCHEMA_FIELD_CHANGED
SCHEMA_RELATIONSHIP_CHANGED
AUTH_CHOICE_RECORDED
BLUEPRINT_APPROVED
MOCK_DATA_GENERATED
SEED_VALIDATION_FAILED
API_GENERATION_SUCCEEDED
API_GENERATION_FAILED
MEMORY_RETRIEVED
MEMORY_CANDIDATE_CREATED
MEMORY_APPROVED

Use the existing activity system if one exists.

Keep analytics events separate from the authoritative Project Definition. A user activity event must never directly mutate the project's schema.

Track operational metrics such as:

- Prompt-to-Blueprint success rate.
- Average generation time.
- Validation failure rate.
- Most frequent user corrections.
- Schema approval rate.
- API generation success rate.
- Memory retrieval usefulness.
- User-reported satisfaction.

Use aggregated metrics for product improvement. Do not use invasive tracking or collect unnecessary personal information.

# 13. Deterministic Validation and Generation

AI output must never bypass the existing validation and generation pipeline.

Required flow:

Natural-language prompt
→ Optional web research
→ Gemini structured proposal
→ Blueprint schema validation
→ Normalization
→ Existing deterministic project validation
→ Relationship validation
→ Endpoint validation
→ Authentication validation
→ Visual review
→ User approval
→ Canonical Project Definition
→ Existing mock data generation
→ Seed-data validation
→ Existing versioning and generation
→ Hosted Mock API

The generated mock data must respect:

- Field types.
- Required fields.
- Defaults.
- Enums.
- Validation constraints.
- Unique fields.
- Relationships.
- Foreign-key/reference constraints.
- Endpoint response contracts.

If validation fails, display useful errors and repair the proposal only within bounded retry limits.

Do not store invalid generated data as successful output.

Do not automatically publish an AI-modified version or replace an existing published version.

Preserve the existing draft, generation, READY, and explicit publishing workflow.

# 14. Security and Privacy

Implement server-side safeguards for:

- Authentication and project ownership.
- Authorization for all memory and project reads.
- Cross-user data isolation.
- Prompt injection.
- Untrusted external schema content.
- Gemini output validation.
- API-key protection.
- Sensitive data filtering.
- Rate limits and token/cost limits.
- Memory poisoning.
- Data retention and deletion.
- Research source validation.

Treat retrieved web pages and imported schemas as untrusted content, not system instructions.

Never allow Gemini to execute arbitrary MongoDB queries, shell commands, arbitrary code, or unrestricted backend operations.

Expose only narrowly scoped existing services.

The AI must not receive platform credentials or secrets.

The user must be able to distinguish personal memories from reusable platform patterns.

# 15. Error Handling

Handle:

- Gemini API errors.
- Invalid structured responses.
- Research timeouts.
- Unsupported language or ambiguous prompts.
- MongoDB persistence failures.
- Memory retrieval failures.
- Blueprint validation failures.
- Mock data generation failures.
- Rate limits.
- Network interruption.
- Duplicate requests.

If memory retrieval fails, fall back to the current prompt and authoritative project context where available.

If live research fails, explain that research was unavailable and continue when safe.

If AI generation fails, preserve the user's prompt and existing draft.

If schema validation fails, leave the canonical project definition unchanged.

If generation fails, keep the currently published API operational.

Use the existing job-state and versioning mechanisms wherever possible.

# 16. Recommended User Experience

Implement the complete flow:

### Step 1: Describe

The user enters a prompt in any supported language.

### Step 2: Analyze

The system detects intent, language, domain, and the likely Single or Project API type.

### Step 3: Research

Gemini searches relevant real-world schemas when useful and available.

### Step 4: Generate

The system proposes entities, fields, relationships, validations, endpoints, and mock-data configuration.

### Step 5: Review

Display the Blueprint visually, including its assumptions and research sources.

### Step 6: Configure Authentication

Always ask whether authentication is required after the initial schema is generated. If necessary, adjust the Blueprint using the existing Auth implementation.

### Step 7: Edit and Approve

The user reviews or modifies the proposal. Record meaningful changes as structured events.

### Step 8: Validate and Generate

Run all existing deterministic validation and generation pipelines.

### Step 9: Publish

Use the existing explicit publishing process.

### Step 10: Learn

Record the final approved outcome and update eligible memory candidates under the applicable privacy and learning rules.

### Step 11: Reuse Memory

On future prompts, retrieve only relevant, permitted memories and inject concise hints into the Gemini context.

Final screen:

"Your Mock API is ready."

Show:

- API base URL.
- Generated endpoints.
- Request examples.
- Response preview.
- Copy URL action.
- Open API action.
- Open dashboard action.

# 17. Technical Architecture

Keep the AI provider behind an abstraction that matches the existing codebase.

Conceptual architecture:

Dashboard
→ AI API Builder service
→ Intent and language detection
→ Research service
→ Project-context service
→ Memory retrieval service
→ Gemini provider
→ Structured Blueprint
→ Existing validation
→ Existing Project Definition
→ Existing generation pipeline
→ MongoDB persistence
→ Hosted Mock API

Memory writes should be handled by a controlled service that validates events, applies privacy rules, and determines whether a candidate is eligible for reuse.

Do not let Gemini directly write persistent memories or mutate the canonical project definition.

Use the existing Gemini key and existing backend conventions. Keep provider-specific behavior isolated so the AI provider can be replaced later without changing the canonical schema or generation engine.

# 18. Implementation Order

Implement Phase 7 incrementally.

**Stage A: Codebase integration**

- Audit current architecture.
- Identify existing models, routes, validation, and generation services.
- Document the integration plan.

**Stage B: Natural-language generation**

- Prompt UI.
- Language detection.
- Gemini structured Blueprint.
- Single versus Project classification.
- Existing validation integration.

**Stage C: Visual review**

- Reuse schema editor.
- Display relationships and endpoints.
- Preserve edits and show diffs.
- Add the mandatory authentication question.

**Stage D: Research integration**

- Add grounded schema research.
- Store source metadata.
- Handle unavailable sources.

**Stage E: Learning memory**

- Track prompt and schema changes.
- Store approved outcomes.
- Implement personal preference memory.
- Implement validated domain and correction patterns.
- Add memory retrieval and ranking.

**Stage F: Generation integration**

- Connect to the existing deterministic pipeline.
- Validate mock data.
- Preserve versioning and explicit publishing.

**Stage G: Security and testing**

- Ownership and privacy tests.
- Multilingual tests.
- Schema correctness tests.
- Memory relevance tests.
- Regression tests for existing API types.
- Generation failure tests.
- End-to-end workflow tests.

Do not implement every stage as one large, unreviewed change. Finish and verify each stage before proceeding.

# 19. Acceptance Criteria

Phase 7 is complete only when the following work end to end:

1. A user can describe an API in natural language.
2. The system understands supported languages and mixed-language prompts.
3. Gemini produces a valid structured Blueprint.
4. Relevant real-world schema research is performed when available.
5. Research sources are not fabricated.
6. The system recommends Single or Project based on the request.
7. The user can override the recommendation.
8. The system always asks whether authentication is required after initial schema generation.
9. The user can visually review and edit the schema.
10. The system tracks meaningful schema changes.
11. The approved Blueprint is stored through existing MongoDB persistence conventions.
12. Mock data passes deterministic validation.
13. The existing generator creates the API.
14. Publishing follows existing versioning rules.
15. A future prompt retrieves relevant permitted memories.
16. A previous approved correction can improve a later relevant proposal.
17. Irrelevant memories do not contaminate unrelated prompts.
18. Private data never leaks between users.
19. Memory retrieval failure does not break normal API generation.
20. Existing Single, Project, and Auth functionality continues to work.
21. Existing dashboard workflows are not broken.
22. The feature works without requiring users to understand the underlying schema implementation.

# 20. Final Architecture Rule

The canonical Project Definition remains the single source of truth.

MongoDB remains the persistence layer.

Gemini is the reasoning and structured-proposal provider.

The memory system provides controlled retrieval of prior preferences and validated patterns.

The existing deterministic engine remains responsible for validation, mock data generation, versioning, and publishing.

**Do not build a second project-generation system, do not train a custom model, and do not let AI-generated memory override explicit user instructions.**

The desired outcome is not simply an AI that generates schemas.

It is an API-building platform that becomes more useful over time by learning which schema suggestions users approve, which they correct, and which patterns reliably produce valid, useful Mock APIs.
