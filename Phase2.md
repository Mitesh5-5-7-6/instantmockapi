# PHASE 2 — Versioning + Visual Diff

## Product

InstantMockAPI

## Objective

Implement a production-grade versioning and visual diff system for Project API.

Phase 2 must build on the existing architecture from:

- Phase 0: Canonical Project Definition
- Phase 1: Editable Project Definition + Dependency Graph + Impact Analysis

Do NOT redesign Phase 0 or Phase 1 unless a small compatibility fix is absolutely required.

Do NOT implement authentication in this phase.

Do NOT mix billing, admin roles, Google Ads, or unrelated features into this phase.

---

# 1. CORE PRODUCT PRINCIPLE

The project definition is the canonical source of truth.

Every meaningful project modification must be represented as a versioned change.

Architecture:

Canonical Project Definition
↓
Draft Changes
↓
Diff Engine
↓
Dependency / Impact Analysis
↓
Selective Regeneration
↓
New Immutable Version
↓
Generated Artifacts
↓
Published / Hosted Runtime

Important:

- Never mutate an existing published version.
- Never overwrite historical versions.
- Never regenerate unrelated APIs unnecessarily.
- Never use field/entity names as identity.
- Stable IDs from Phase 1 must remain stable across versions.
- A rename must not appear as delete + create when the stable ID is unchanged.
- Old versions must remain readable and comparable.
- Rollback must create a new version rather than destroying history.

---

# 2. PHASE 2 FEATURES

Implement exactly these capabilities:

1. Version creation
2. Version history
3. Before/after visual comparison
4. Rollback
5. Selective regeneration

Additional supporting functionality:

6. Version metadata
7. Change classification
8. Diff summary
9. Version status
10. Version-to-version comparison
11. Regeneration state
12. Version-aware hosted API handling

---

# 3. VERSION MODEL

Create or adapt the existing version model.

Recommended conceptual structure:

Project
├── canonicalDefinition
├── publishedVersionId
├── draft
└── versions[]

Version:

{
id: string,
projectId: string,

versionNumber: number,

sourceDefinition: CanonicalProjectDefinition,

parentVersionId: string | null,

status:
| "DRAFT"
| "GENERATING"
| "READY"
| "PUBLISHED"
| "FAILED"
| "ROLLED_BACK",

changeSummary: {
entitiesAdded: number,
entitiesRemoved: number,
entitiesModified: number,

    fieldsAdded: number,
    fieldsRemoved: number,
    fieldsModified: number,

    relationsAdded: number,
    relationsRemoved: number,
    relationsModified: number,

    endpointsAdded: number,
    endpointsRemoved: number,
    endpointsModified: number

},

changeType:
| "INITIAL"
| "FEATURE"
| "FIX"
| "BREAKING"
| "ROLLBACK"
| "REGENERATION",

createdBy: string,

createdAt: Date,
publishedAt: Date | null,

generationStatus: {
total: number,
pending: number,
generating: number,
completed: number,
failed: number
}
}

Use the existing project's conventions if these fields already exist.

Do not duplicate data unnecessarily if an equivalent model already exists.

---

# 4. IMMUTABLE VERSION RULE

Once a version becomes READY or PUBLISHED:

It must be immutable.

Forbidden:

PATCH /versions/:id

that changes:

- entity definitions
- fields
- relationships
- endpoint configuration
- validation rules
- generated artifact configuration

Instead:

Version 1
↓
edit
↓
Version 2

Never:

Version 1
↓
edit Version 1 directly

Historical versions are snapshots.

---

# 5. DRAFT MODEL

Editing should happen against a draft.

Example:

Published Version:
v3

User edits:

Customer.email
string → number

The system should produce:

Published: v3
Draft: unpublished changes

The hosted API must continue using v3.

The user can then:

Review Changes
→ Select regeneration
→ Generate
→ Create v4
→ Publish v4

Until v4 is published, production/hosted runtime remains on v3.

This prevents incomplete generation from breaking a working API.

---

# 6. VERSION CREATION FLOW

Implement this flow:

User edits project
↓
Save Draft
↓
Compare Draft vs Published Version
↓
Calculate Diff
↓
Build Impact Graph
↓
Show Impact Analysis
↓
User reviews changes
↓
Select affected APIs/artifacts
↓
Confirm Regeneration
↓
Create Version
↓
Queue generation jobs
↓
Generate selected artifacts
↓
Validate generation
↓
Mark version READY
↓
User publishes
↓
Version becomes PUBLISHED

Do not automatically change the live hosted API merely because the user edited the draft.

---

# 7. VERSION NUMBERING

Use sequential project versions:

v1
v2
v3
v4

Never reuse deleted version numbers.

If v4 is rolled back to v2:

Do NOT make v2 active by modifying v2.

Instead create:

v5

with the definition from v2.

Metadata:

v5
changeType = ROLLBACK
parentVersionId = v4
rollbackSourceVersionId = v2

History becomes:

v1
v2
v3
v4
v5 (rollback to v2)

This preserves the audit trail.

---

# 8. VERSION HISTORY UI

Create a dedicated Version History experience.

Suggested layout:

---

Project / CRM API
Version History
---------------------------------------------

Current
v5 Published
Rollback to v2
Created 10 minutes ago

---

v5
Rollback
Published
Today 10:42

- Customer.phone
  ~ Customer.email
  ~ Order.status

[View Changes]

---

v4
Published
Today 10:21

- Payment
- Shipment

[View Changes]

---

v3
Published
Yesterday

~ Customer
~ Order

[View Changes]

---

v2
Published
Yesterday

- Customer
- Order

[View Changes]

---

v1
Initial version

[View Changes]

---

Version history should clearly communicate:

- version number
- status
- created date/time
- author
- change type
- change summary
- affected entities
- affected endpoints
- generation status
- published status

---

# 9. VERSION STATUS

Use clear statuses:

DRAFT
GENERATING
READY
PUBLISHED
FAILED
ROLLED_BACK

Do not use vague statuses like:

"Processing"
"Done"
"Something went wrong"

The UI should always know exactly what state the version is in.

---

# 10. VISUAL DIFF SYSTEM

This is one of the most important Phase 2 features.

Build a structured visual diff.

The diff must compare:

Version A
vs
Version B

Example:

v3 → v4

---

Changes
---------------------------------------------

3 changes
2 non-breaking
1 breaking

Entities
---------------------------------------------

Customer
Fields

- phone
  ~ email
  string → number
  BREAKING

Order
Fields

- trackingNumber

Relations
---------------------------------------------

Order → Shipment

- relation

Endpoints
---------------------------------------------

GET /customers
Modified

POST /customers
Modified

GET /orders
Unchanged

---

[View Full Diff]

11. DIFF CLASSIFICATION

Every change must be classified.

Supported classifications:

Added

Examples:

Entity added
Field added
Relation added
Endpoint added

UI:

Green semantic color.

Removed

Examples:

Entity removed
Field removed
Relation removed
Endpoint removed

UI:

Red semantic color.

Modified

Examples:

Field type changed
Required changed
Default changed
Validation changed
Relation cardinality changed
Endpoint configuration changed

UI:

~

Amber/neutral semantic color.

Renamed

If stable ID remains identical:

Entity:

Customer
→
Client

This must be represented as:

RENAME

NOT:

Customer removed
Client added

Same rule for:

entities
fields
endpoints
relations 12. BREAKING CHANGE DETECTION

Implement basic breaking-change classification.

Examples:

Field:

string → number

BREAKING

required:

false → true

BREAKING

Field removed:

BREAKING

Entity removed:

BREAKING

Relation removed:

BREAKING

Endpoint removed:

BREAKING

Endpoint path changed:

BREAKING

Validation tightened:

minLength 3 → minLength 8

Potentially BREAKING

Validation relaxed:

minLength 8 → minLength 3

NON-BREAKING

Field added:

NON-BREAKING

Optional field added:

NON-BREAKING

Do not pretend every change can be perfectly classified.

Use:

BREAKING
NON_BREAKING
POTENTIALLY_BREAKING

when appropriate.

13. DIFF DATA STRUCTURE

Create a structured diff model.

Example:

{
entityId,
fieldId,
relationId,
endpointId,

entityName,
fieldName,

changeType:
| "ADDED"
| "REMOVED"
| "MODIFIED"
| "RENAMED",

impact:
| "BREAKING"
| "NON_BREAKING"
| "POTENTIALLY_BREAKING",

before: {},
after: {},

affectedEndpoints: [],
affectedArtifacts: []
}

The UI should consume structured diff data.

Do NOT generate the UI by comparing arbitrary JSON strings.

14. VISUAL DIFF UI

Build a professional developer-tool style comparison interface.

Recommended:

┌──────────────────────────────────────────────┐
│ Compare Versions │
│ │
│ v3 → v4 │
│ │
│ 8 changes │
│ 5 non-breaking 2 breaking 1 modified │
└──────────────────────────────────────────────┘

Then sections:

Entities
Fields
Relationships
Endpoints
Validation
Generated Artifacts

Each item can expand.

Example:

Customer
──────────────────────────────────────────────

email

Before
string
required: false

After
number
required: false

Impact
BREAKING

Affected APIs:

✓ GET /customers
✓ POST /customers
✓ PUT /customers/:id
✓ PATCH /customers/:id

Affected artifacts:

✓ Zod
✓ TypeScript
✓ OpenAPI
✓ Mock Data
✓ Postman
✓ Hosted API

15. SIDE-BY-SIDE DIFF

Provide a side-by-side mode for complex changes.

LEFT:

Version 3

RIGHT:

Version 4

Example:

┌──────────────────┬──────────────────┐
│ v3 │ v4 │
├──────────────────┼──────────────────┤
│ email: string │ email: number │
│ required: false │ required: true │
│ │ │
│ validation: none │ min: 1 │
└──────────────────┴──────────────────┘

Use semantic highlighting.

Do not turn the interface into a wall of colored text.

16. DEPENDENCY-AWARE DIFF

Integrate Phase 1 dependency graph.

Example:

Customer.email
↓
Customer
↓
GET /customers
POST /customers
PUT /customers/:id
PATCH /customers/:id
↓
Zod
TypeScript
OpenAPI
Mock Data
Postman
Hosted API

If Product is unrelated:

Product
↓
GET /products
POST /products

Product APIs should NOT be regenerated.

17. SELECTIVE REGENERATION

This is a major feature.

After calculating impact:

Show:

Affected APIs

☑ Customer API
☑ Order API
☐ Product API
☐ Inventory API

Affected artifacts:

☑ Zod
☑ TypeScript
☑ OpenAPI
☑ Mock Data
☑ Postman

The system should recommend affected items by default.

The user may deselect items when technically safe.

18. OUT-OF-SYNC STATE

If the user deselects an affected API/artifact, do NOT silently pretend everything is synchronized.

Example:

Customer API
⚠ Out of sync with current schema

Schema:
v4

Generated API:
v3

Display:

"Generated from an older version."

This is extremely important.

Selective regeneration must never create invisible inconsistency.

19. REGENERATION RULES

Example:

Customer.email changes.

Affected:

Customer CRUD
Zod
TypeScript
OpenAPI
Mock Data
Postman
Hosted runtime

Unaffected:

Product
Category
Inventory

Generate only the affected components.

Do not regenerate the entire project.

20. REGENERATION JOBS

Use the existing generation queue architecture.

Do not introduce a second queue system.

If BullMQ already exists:

Use the existing BullMQ infrastructure.

Each generation unit should have:

{
versionId,
projectId,
targetId,
generatorType,
status,
attempts,
error,
startedAt,
completedAt
}

Example:

v4

Customer API
Zod COMPLETED
TypeScript COMPLETED
OpenAPI COMPLETED
Mock Data GENERATING
Postman PENDING

The frontend should receive/update progress using the existing architecture.

21. VERSION GENERATION FAILURE

If generation fails:

Version:

FAILED

Do NOT publish it.

The previous published version must remain live.

Example:

Published:
v3

Attempted:
v4

v4 generation fails.

Runtime remains:

v3

The user sees:

v4
Generation failed

[View Error]
[Retry Generation]
[Compare with v3]

Never break the currently published API because a new version failed.

22. ROLLBACK

Implement rollback from Version History.

Example:

Current:

v5

User clicks:

Rollback v2

Show confirmation:

Rollback to v2?

This will create a new version containing the definition
from v2.

Current version:
v5

New version:
v6

Changes:

Customer.phone removed
Order.trackingNumber removed
Payment restored

This action does not delete v5.

Buttons:

Cancel
Create Rollback Version

After confirmation:

v6
changeType = ROLLBACK

Then run normal:

Diff
→ Impact Analysis
→ Selective Regeneration
→ Generation
→ Ready
→ Publish

Rollback must reuse the normal versioning pipeline.

Do NOT create a special hidden rollback implementation that bypasses version generation.

23. ROLLBACK SAFETY

If rollback is breaking:

Show:

⚠ Breaking Changes

The selected version differs from the current version.

Affected endpoints:

GET /customers
POST /customers
GET /orders

Breaking changes:

Customer.email type changed
Order.trackingNumber removed

Require explicit confirmation.

24. VERSION COMPARISON

Users should be able to select any two versions.

Example:

Compare:

[v2 ▼]

with:

[v5 ▼]

Then:

[Compare]

Do not restrict comparison only to adjacent versions.

The diff engine must support:

v1 → v2
v2 → v3
v1 → v5
v4 → v2

25. VERSION DETAIL PAGE

Create a version detail page.

Example:

Project: CRM Backend

Version v4

Status:
READY

Created:
Sep 7, 2026

Based on:
v3

Change Type:
FEATURE

Summary:

- 2 fields
  ~ 1 field
- 1 relation
  ~ 3 endpoints

Actions:

[Compare]
[Publish]
[Rollback]
[View Generated Artifacts]

If already published:

[PUBLISHED]

Do not show Publish on the currently published version.

26. PUBLISHING

Publishing must be explicit.

Generation success does not automatically mean publish.

Flow:

Generate
→ READY

Then:

Publish Version

When publishing:

Verify generation completed.
Verify required artifacts exist.
Verify no blocking generation failures.
Update project's publishedVersionId.
Mark previous published version as historical.
Mark new version as PUBLISHED.
Update hosted runtime reference.

Runtime must resolve:

project.publishedVersionId

NOT:

project.currentVersion

Do not use mutable project fields as a substitute for immutable version identity.

27. HOSTED API SAFETY

This is critical.

The live hosted API must always point to a successfully generated published version.

Never allow:

Draft schema
↓
Live API

Never allow:

Failed version
↓
Live API

Never allow:

Generating version
↓
Live API

Correct:

Draft
↓
Generation
↓
Ready
↓
Publish
↓
Live API

28. VERSION HISTORY PERFORMANCE

Do not load entire generated artifacts into the version history page.

Version history should load:

metadata
summary
change counts
status

Load full definitions/diff only when the user opens comparison.

Use pagination if version count becomes large.

Recommended:

GET /projects/:id/versions

GET /projects/:id/versions/:versionId

GET /projects/:id/versions/compare?from=v3&to=v4

Use existing API conventions if routes differ.

29. DATABASE INDEXES

Add appropriate indexes.

At minimum:

ProjectVersion:

projectId
projectId + versionNumber
projectId + createdAt
projectId + status

Artifacts:

versionId
versionId + generatorType

Do not add random indexes without checking actual query patterns.

30. API DESIGN

Implement clean API boundaries.

Suggested endpoints:

GET
/projects/:projectId/versions

GET
/projects/:projectId/versions/:versionId

GET
/projects/:projectId/versions/compare

POST
/projects/:projectId/versions

POST
/projects/:projectId/versions/:versionId/publish

POST
/projects/:projectId/versions/:versionId/rollback

POST
/projects/:projectId/versions/:versionId/regenerate

Use the project's existing API naming/versioning conventions.

Every API must:

validate input
authorize project ownership
return structured errors
use consistent response format
never expose internal stack traces
log server-side errors 31. ERROR HANDLING

Follow the project's global error/toast architecture.

IMPORTANT:

Do not create random inline API error blocks.

For API/server/network/system errors:

Show a global toast.

Example:

❌ Version generation failed

Customer API could not be generated.

[View details]

For field validation:

Show inline validation.

For structured server validation errors:

Map them to the relevant field when possible.

Otherwise:

Show toast.

Never display raw JSON as the primary user-facing error.

32. TOAST EVENTS

Versioning should use standardized toast events.

Success:

"Version v4 generated successfully."

"Version v4 published."

"Rollback version v6 created."

Error:

"Version generation failed."

"Unable to publish version."

"Rollback failed."

Warning:

"This version contains breaking changes."

Info:

"3 APIs are affected by this change."

Loading:

"Generating affected APIs..."

Prevent duplicate toasts.

33. UI DESIGN SYSTEM

Follow the existing InstantMockAPI theme.

Theme:

Vercel-inspired developer platform structure +
MongoDB-inspired green accent

Use:

near-black primary background
dark elevated surfaces
subtle gray borders
white primary text
muted gray secondary text
green accent for primary/success states
amber for warnings
red for destructive/breaking/error states
blue only for informational states when necessary

Do not use:

gradients
neon effects
excessive green
giant glowing cards
random colors
excessive rounded containers
unnecessary animations
AI-looking decorative UI

The interface should feel like a serious developer infrastructure product.

34. DIFF COLOR RULES

Use semantic colors consistently.

Added:
green

Removed:
red

Modified:
amber/neutral

Breaking:
red

Non-breaking:
green

Potentially breaking:
amber

Unchanged:
muted gray

Do not use color as the only indication.

Always include:

Added
Removed
~ Modified

and accessible text labels.

35. VERSION TIMELINE

Consider a compact timeline visualization.

Example:

v1 ───── v2 ───── v3 ───── v4 ───── v5
↑ ↑
Feature Breaking

Current published version should have a clear indicator.

Do not make the timeline overly decorative.

36. VERSION DIFF SUMMARY

At the top of comparison page:

v3 → v4

8 Changes

2 Added
3 Modified
1 Removed
2 Renamed

Impact:

5 Non-breaking
2 Potentially breaking
1 Breaking

Affected:

3 Entities
7 Endpoints
6 Artifacts

This gives developers immediate understanding before they inspect details.

37. CHANGE GROUPING

Group changes hierarchically:

Entity
→ Fields
→ Relations
→ Endpoints

Example:

Customer

phone
~ email
string → number

Relations

address

APIs
~ GET /customers
~ POST /customers

Do not display 50 separate flat change rows when they belong to one entity.

38. EMPTY STATES

Version history empty state:

"No versions yet."

"Your first generated project version will appear here."

Comparison empty state:

"Select two versions to compare."

No changes:

"No changes detected between these versions."

Rollback unavailable:

"This version cannot be rolled back because it is already the current published definition."

39. LOADING STATES

Use skeleton loaders.

Do not block the entire page unnecessarily.

Version history:

Show metadata skeletons.

Diff:

Show section skeletons.

Generation:

Show individual generation progress.

Example:

Customer API
████████████░░ 80%

Zod ✓
TypeScript ✓
OpenAPI ✓
Mock Data …
Postman …

40. SECURITY

Never trust client-provided:

project ownership
user ID
version ownership
publication permissions
role
artifact access

Verify server-side.

A user must never be able to:

read another user's versions
compare another user's versions
rollback another user's project
publish another user's version
regenerate another user's artifacts 41. AUDIT INFORMATION

Every version should record:

createdBy
createdAt
parentVersionId
changeType
publishedAt
rollback source when applicable

Do not implement a massive audit platform in Phase 2.

Only capture the version lifecycle information needed by this feature.

42. MIGRATION / EXISTING PROJECTS

Existing projects may not have version history.

Create a safe migration/backfill strategy.

For existing projects:

If a canonical definition exists:

Create:

v1

with:

changeType = INITIAL

status = PUBLISHED

Use the current valid canonical definition.

Do not destroy existing hosted APIs during migration.

Do not blindly create duplicate versions on every startup.

Migration must be idempotent.

43. STABLE ID REQUIREMENT

Use Phase 1 stable IDs.

Required stable IDs:

projectId
entityId
fieldId
relationId
endpointId

Example:

fieldId:
fld_abc123

If:

email → emailAddress

the ID remains:

fld_abc123

This allows diff:

RENAMED

rather than:

REMOVED + ADDED

Never identify entities/fields only by:

name

path

array index

display label

44. TESTING

Add unit tests for:

Versioning
creates v1
creates sequential versions
never reuses version number
versions are immutable
parentVersionId is correct
Diff
entity added
entity removed
entity renamed
field added
field removed
field renamed
field type changed
required changed
default changed
validation changed
relation changed
endpoint added
endpoint removed
Breaking changes

Test:

string → number
optional → required
field removal
entity removal
endpoint removal
validation tightening

Selective regeneration

Verify:

changed Customer field
→ Customer APIs regenerated

Product APIs:
→ untouched

Rollback

v1
v2
v3

Rollback v1

creates:

v4

with v1 definition.

Verify:

v1 remains unchanged
v2 remains unchanged
v3 remains unchanged
v4 is new

Publishing

Verify:

failed v4
→ v3 remains live

successful v4
→ v4 becomes published

Authorization

User A cannot:

read User B versions
compare User B versions
rollback User B
publish User B 45. ACCEPTANCE CRITERIA

Phase 2 is complete only when:

Version creation
Every published project has an immutable version.
New changes create a new version.
Version numbers are sequential.
Historical versions cannot be mutated.
Version history
Users can see all project versions.
Current published version is obvious.
Version metadata is visible.
Generation status is visible.
Visual diff
Any two versions can be compared.
Added/removed/modified/renamed changes are detected.
Breaking changes are identified.
Entity/field/relation/API hierarchy is visible.
Before/after values can be inspected.
Selective regeneration
Only affected APIs/artifacts are regenerated.
User can review affected APIs.
User can select/deselect regeneration where safe.
Deselected affected APIs are visibly marked out-of-sync.
Unrelated APIs remain untouched.
Rollback
Any historical version can be used as rollback source.
Rollback creates a NEW version.
Historical versions remain intact.
Rollback goes through normal diff/regeneration flow.
Breaking rollback requires confirmation.
Publishing
Generation must succeed before publishing.
Failed versions cannot become live.
Drafts cannot become live.
Hosted API references publishedVersionId.
Existing live API remains safe during failed generation.
UX
API errors use global toasts.
Validation errors use field-level messages where appropriate.
No random API error blocks.
Loading states exist.
Empty states exist.
Breaking changes are visually obvious.
UI follows the InstantMockAPI black + restrained green theme. 46. IMPLEMENTATION ORDER

Implement in this exact order:

Step 1
Inspect current Phase 0 + Phase 1 implementation.

Step 2
Identify existing:

canonical project definition
stable IDs
endpoint model
dependency graph
generation queue
artifact model
hosted API resolution

Step 3
Create/adapt Version model.

Step 4
Implement version snapshot creation.

Step 5
Implement draft → version flow.

Step 6
Implement diff engine.

Step 7
Implement breaking-change classification.

Step 8
Implement version history API.

Step 9
Implement visual diff UI.

Step 10
Connect dependency graph to selective regeneration.

Step 11
Connect regeneration to existing BullMQ generation system.

Step 12
Implement version status/progress.

Step 13
Implement publish flow.

Step 14
Implement rollback.

Step 15
Add migration/backfill for existing projects.

Step 16
Add unit/integration/e2e tests.

Step 17
Run typecheck/lint/tests/build.

Step 18
Perform manual UX review.

47. IMPORTANT ENGINEERING RULES

Do not:

rewrite working Phase 1 architecture
introduce a second queue
create duplicate project-definition models
use names as IDs
mutate historical versions
automatically publish drafts
regenerate the entire project for every change
silently leave APIs out of sync
expose raw server errors
add random UI components
introduce authentication in Phase 2
introduce billing in Phase 2
introduce admin features in Phase 2
introduce unrelated infrastructure

Prefer:

existing abstractions
existing queue
existing error handling
existing API conventions
existing design system
incremental migrations
immutable snapshots
dependency-aware regeneration
explicit publish boundaries 48. FINAL DELIVERABLE

At the end of implementation provide:

Files changed
Database/schema changes
API endpoints added/changed
Version lifecycle explanation
Diff engine explanation
Selective regeneration explanation
Rollback behavior
Migration/backfill behavior
Tests added
Known limitations
Commands executed:
typecheck
lint
unit tests
integration tests
build

Do not claim a feature is complete if tests/build fail.

The final implementation must preserve backward compatibility with existing Project API functionality.

## Recommended Phase 2 UX

I would structure the actual product flow like this:

```text
Project
│
├── Builder
│   ├── Data Model
│   ├── APIs
│   └── Configuration
│
├── Versions
│   ├── v1
│   ├── v2
│   ├── v3
│   └── Compare
│
├── Changes
│   ├── Added
│   ├── Modified
│   ├── Removed
│   ├── Renamed
│   └── Breaking Changes
│
└── Hosted API
    └── Published Version
The most important architectural distinction

Don't make Version History just a pretty list.

The real system should be:

             Canonical Definition
                     │
                     ▼
                   Draft
                     │
                     ▼
                Diff Engine
                     │
                     ▼
              Impact Analysis
                     │
          ┌──────────┴──────────┐
          ▼                     ▼
   Affected APIs         Unaffected APIs
          │                     │
          ▼                     │
 Selective Regeneration         │
          │                     │
          └──────────┬──────────┘
                     ▼
                  Version
                     │
              ┌──────┴──────┐
              ▼             ▼
           Ready         Failed
              │
              ▼
           Publish
              │
              ▼
       Hosted API Runtime

That gives you a genuinely useful version system rather than the usual "v1, v2, v3" list that humans somehow call version control.

One feature I strongly recommend adding inside Phase 2

"What changed?" should be the first thing users see after an edit.

For example:

3 changes detected

Customer.email
string → number 🔴 Breaking

Customer.phone
Added 🟢

Order → Shipment
Relationship added 🟢

Affected: 6 endpoints, 5 generated artifacts

[Review Changes]
```
