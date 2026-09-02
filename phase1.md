# MASTER IMPLEMENTATION PROMPT

# Phase 0 + Phase 1: Canonical Project Definition + Edit & Dependency Graph

## IMPORTANT

You are working on an existing production-oriented Mock API platform.

Do NOT rewrite the application from scratch.

Do NOT replace working functionality unnecessarily.

Do NOT introduce a new architecture just because it is aesthetically cleaner.

First inspect the existing repository, database models, API routes, generator engine, worker system, authentication system, project structure, and frontend.

Then implement this phase incrementally while preserving existing behavior.

The goal of this phase is:

1. Establish one canonical source of truth for every Project API and Single API.
2. Allow users to edit generated projects safely.
3. Detect exactly which generated APIs are affected by a change.
4. Detect dependencies between entities, fields, relationships, validations, authentication, and API endpoints.
5. Prepare the architecture for Phase 2:
   - Versioning
   - Visual diff
   - Selective regeneration
6. Do NOT implement full versioning yet unless required internally to support safe editing.
7. Do NOT regenerate everything after every edit.
8. Never silently destroy the user's existing generated API.

---

# 1. PRODUCT OBJECTIVE

The current system generates a project once.

Current conceptual flow:

User
↓
Define schema
↓
Generate
↓
Generated APIs
↓
Hosted Mock API

The problem is that after generation the user may discover:

- Entity name is wrong
- Field name is wrong
- Field type is wrong
- Validation rule is wrong
- Relationship is wrong
- API method is wrong
- Authentication requirement is wrong
- Endpoint path is wrong
- Public/protected setting is wrong
- Required field is wrong
- Default value is wrong
- Enum is wrong
- Nested object is wrong
- Array definition is wrong

The user must NOT be forced to delete the entire project and rebuild it.

New flow:

Project
↓
Canonical Project Definition
↓
Generated Runtime
↓
User edits definition
↓
System calculates dependency graph
↓
System performs impact analysis
↓
System shows affected APIs
↓
User reviews changes
↓
User later confirms regeneration

The key architectural principle:

> The generated API is a projection of the canonical project definition.

The canonical definition is the source of truth.

Generated APIs, schemas, mock data, OpenAPI documents, authentication configuration, and other artifacts are derived outputs.

---

# 2. CORE ARCHITECTURAL PRINCIPLE

Never use generated API code/data as the primary source of truth.

Bad architecture:

User
↓
Generated API
↓
Edit generated API
↓
Try to infer project structure

Correct architecture:

User
↓
Canonical Project Definition
↓
Dependency Graph
↓
Generator Engine
↓
Generated Artifacts
↓
Hosted Runtime

The canonical definition must contain enough information to reconstruct the project.

---

# 3. SUPPORT TWO PROJECT TYPES

The architecture must support:

## Project API

Multiple entities, relationships, authentication, multiple endpoints.

Example:

User
Product
Category
Order
OrderItem
Payment

Relationships:

User
1 ─── N Order

Order
1 ─── N OrderItem

Product
1 ─── N OrderItem

Authentication:

SignUp
SignIn
Me

Endpoints:

GET /users
POST /users
GET /orders
POST /orders
PATCH /orders/:id
DELETE /orders/:id

## Single API

A single standalone API definition.

Single API has three modes:

1. Authentication API
2. Public API
3. Authenticated API

Authentication API:

POST /signup
POST /signin

Public API:

GET /products

Authenticated API:

GET /products
POST /products
PUT /products/:id
PATCH /products/:id
DELETE /products/:id

The same canonical-definition and dependency-graph system must work for both.

---

# 4. CANONICAL PROJECT DEFINITION

Create a normalized internal representation.

The exact database technology should follow the existing project's database architecture.

Do not blindly store only arbitrary JSON if the existing system already has normalized models.

However, a serialized canonical snapshot may also be stored for reproducibility.

Conceptually:

ProjectDefinition

{
project,
entities,
fields,
relationships,
validations,
endpoints,
authentication,
mockData,
generatorConfiguration,
metadata
}

---

# 5. PROJECT DEFINITION

Example:

{
"id": "project_123",
"type": "project_api",
"name": "E-commerce API",
"slug": "ecommerce-api",
"status": "active",
"definitionVersion": 1,
"schemaVersion": 1,
"createdAt": "...",
"updatedAt": "..."
}

Required:

- projectId
- project type
- name
- slug
- status
- schema/definition version
- timestamps

Do not confuse:

project definition version

with

generated API runtime version.

Versioning will be expanded in Phase 2.

---

# 6. ENTITY DEFINITION

Every entity must have a stable internal ID.

Example:

{
"id": "ent_user_123",
"name": "User",
"slug": "users",
"displayName": "User",
"description": "Application user",
"status": "active"
}

IMPORTANT:

Entity ID must never depend on the entity name.

Bad:

User ID = "User"

Correct:

id = "ent_01H..."

Therefore:

User
→ Product

renaming User to Customer should not break every dependency.

The dependency graph uses stable IDs.

---

# 7. ENTITY EDITING

Users must be able to edit:

- Entity name
- Display name
- Slug
- Description
- Status
- Endpoint configuration
- Authentication requirement
- CRUD configuration

Potential entity operations:

- Create entity
- Rename entity
- Change slug
- Duplicate entity
- Archive entity
- Restore entity
- Delete entity

Do not immediately hard-delete entities if generated APIs depend on them.

Prefer:

active
archived
deleted/pending deletion

depending on existing architecture.

---

# 8. ENTITY NAME CHANGE

Example:

Before:

User

After:

Customer

The system must detect impact.

Potentially affected:

- Entity endpoint
- GET endpoint
- POST endpoint
- PUT endpoint
- PATCH endpoint
- DELETE endpoint
- Relationships
- Foreign references
- Authentication
- Mock data
- OpenAPI
- TypeScript types
- Zod schemas
- Technical notes
- API documentation

Do not simply perform a text replacement.

Use entity IDs.

---

# 9. ENTITY SLUG CHANGE

Before:

/users

After:

/customers

This is different from renaming the display name.

The dependency graph must identify endpoint path dependencies.

Affected:

GET /users
POST /users
GET /users/:id
PUT /users/:id
PATCH /users/:id
DELETE /users/:id

Relationships may also expose nested routes.

Example:

/users/:userId/orders

If the user slug changes:

/customers/:userId/orders

This must be detected.

---

# 10. FIELD DEFINITION

Every field must have a stable field ID.

Example:

{
"id": "field_email_123",
"entityId": "ent_user_123",
"name": "email",
"type": "string",
"required": true,
"nullable": false,
"defaultValue": null
}

Field properties may include:

- name
- type
- required
- nullable
- default
- description
- unique
- indexed
- readOnly
- writeOnly
- hidden
- enum
- format

---

# 11. SUPPORTED FIELD TYPES

Design the system to support at least:

Primitive:

- string
- number
- integer
- float
- boolean
- date
- datetime
- uuid
- email

Structured:

- object
- array

Potential future:

- bigint
- decimal
- binary
- json
- geo
- enum

Do not assume every generator supports every type.

The canonical definition should remain generator-independent.

---

# 12. FIELD EDITING

Users can edit:

- Field name
- Field type
- Required
- Nullable
- Default
- Description
- Validation
- Unique
- Index
- Read-only
- Write-only
- Enum
- Format
- Array configuration
- Object configuration

Every modification must generate an internal Change object.

Example:

{
"type": "FIELD_TYPE_CHANGED",
"entityId": "ent_user",
"fieldId": "field_age",
"before": "string",
"after": "number"
}

---

# 13. FIELD TYPE CHANGE

This is a high-impact change.

Example:

Before:

age: string

After:

age: number

Affected:

- POST entity endpoint
- PUT entity endpoint
- PATCH entity endpoint
- Validation
- Zod
- TypeScript
- OpenAPI
- Mock data
- Documentation

Potentially affected:

- Filters
- Sorting
- Searching
- Query parameters
- Relationships if used as a key
- Database adapter
- Generated client types

Mark this as a breaking change.

Do NOT silently regenerate.

Record it in the impact report.

---

# 14. FIELD NAME CHANGE

Example:

firstName

→

givenName

Detect all references.

Potentially affected:

- Entity GET
- POST
- PUT
- PATCH
- Mock data
- Validation
- OpenAPI
- Generated TypeScript
- Zod
- Technical notes
- Search/filter configuration
- Sorting configuration

If used inside a relationship or generated query configuration, include those dependencies.

---

# 15. FIELD REQUIRED CHANGE

Before:

email required = false

After:

email required = true

Affected:

- POST
- PUT if full replacement requires the field
- Validation
- Zod
- OpenAPI
- Forms/examples if generated
- Mock data if required values are missing

PATCH behavior must be treated carefully.

PATCH generally allows partial updates.

Do not automatically treat PATCH as identical to POST.

---

# 16. NULLABLE CHANGE

Before:

email nullable = true

After:

email nullable = false

Potentially affected:

- Validation
- POST
- PUT
- PATCH
- Mock data
- OpenAPI
- TypeScript
- Zod

---

# 17. DEFAULT VALUE CHANGE

Before:

status = "active"

After:

status = "pending"

Affected:

- POST
- Mock data
- API examples
- Documentation

Do not necessarily regenerate GET if GET simply reads stored data.

The dependency system must understand read vs write dependencies.

---

# 18. ENUM CHANGE

Example:

Before:

status = ["active", "inactive"]

After:

status = ["active", "inactive", "blocked"]

This may affect:

- Validation
- POST
- PUT
- PATCH
- OpenAPI
- TypeScript
- Zod
- Mock data
- Documentation

Removing enum values is a breaking change.

Adding enum values is generally non-breaking.

The impact engine should record severity.

---

# 19. VALIDATION DEFINITION

Validation must be first-class.

Examples:

{
"fieldId": "field_email",
"rules": [
{
"type": "email"
},
{
"type": "maxLength",
"value": 255
}
]
}

Support rules such as:

- required
- min
- max
- minLength
- maxLength
- regex
- email
- url
- uuid
- integer
- positive
- negative
- enum
- custom format

Future validation libraries:

- Zod
- Yup
- Joi
- Valibot

Do not tightly couple canonical validation rules to Zod/Yup syntax.

Canonical rules must be library-independent.

---

# 20. VALIDATION EDITING

Examples:

Add:

email validation

Remove:

regex

Change:

minLength 3 → 5

Change:

max 100 → 120

Every validation change creates a dependency event.

Affected:

- Write endpoints
- Validation generator
- Zod
- Yup
- OpenAPI
- Documentation
- Technical notes

Do not regenerate unrelated GET endpoints unless their generated response schema actually depends on the validation metadata.

---

# 21. NESTED OBJECTS

Support:

customer.address.city

The dependency graph must understand nested paths.

Example:

customer
└── address
└── city

If city changes:

customer.address.city
→ affected parent object schema
→ affected entity schema
→ affected endpoints that serialize/validate the entity

---

# 22. ARRAY FIELDS

Example:

tags: string[]

or:

orders: Order[]

The dependency graph must distinguish:

array of primitive

from:

array of entity/reference.

Example:

orders: Order[]

creates a dependency:

Order
↓
User.orders

Changing Order may affect User-generated schemas.

---

# 23. RELATIONSHIP DEFINITION

Relationship must have stable relationship ID.

Example:

{
"id": "rel_user_orders",
"sourceEntityId": "ent_user",
"targetEntityId": "ent_order",
"type": "one_to_many",
"sourceField": "orders",
"foreignKey": "userId"
}

Support:

- one-to-one
- one-to-many
- many-to-one
- many-to-many

Future:

- polymorphic relations
- self-references

---

# 24. RELATIONSHIP EDITING

Users must be able to:

- Create relationship
- Delete relationship
- Change relationship type
- Change source
- Change target
- Change foreign key
- Change relation field
- Change cascade behavior
- Change requiredness

Every relationship modification must trigger impact analysis.

---

# 25. RELATIONSHIP EXAMPLE

Before:

User
1 → N
Order

After:

User
1 → N
Order

and:

Order
1 → 1
Payment

Only APIs involving Order, Payment, User relationships should be affected.

Do NOT regenerate unrelated:

Product
Category

APIs.

---

# 26. RELATIONSHIP DELETE

If User.orders relationship is removed:

Potentially affected:

- Nested API responses
- Query expansion
- Include/populate functionality
- Generated schemas
- Mock data relationships
- OpenAPI
- Documentation
- Technical notes

The system must identify exactly which generated artifacts depend on that relationship.

---

# 27. API CONFIGURATION

Every endpoint must have a stable API ID.

Example:

{
"id": "api_users_get",
"entityId": "ent_user",
"method": "GET",
"path": "/users",
"enabled": true,
"access": "protected"
}

Supported methods:

- GET
- POST
- PUT
- PATCH
- DELETE

---

# 28. API CONFIGURATION EDITING

Users can change:

- HTTP method
- Path
- Endpoint enabled/disabled
- Public/protected
- Authentication requirement
- Pagination
- Filtering
- Searching
- Sorting
- Query parameters
- Response configuration
- Request body configuration

Potential future:

- custom status codes
- custom response templates
- artificial delay
- error simulation

---

# 29. PUBLIC VS PROTECTED

Every endpoint must explicitly define access.

Example:

{
"access": "public"
}

or:

{
"access": "protected"
}

Do not infer this only from frontend state.

The backend runtime must enforce it.

Changing:

public → protected

affects:

- Authentication middleware
- API documentation
- OpenAPI security definitions
- Postman collection
- Technical notes

Changing:

protected → public

has security implications.

Mark as HIGH impact.

---

# 30. AUTHENTICATION DEPENDENCY

Authentication is a project-level dependency.

Example:

Authentication:

enabled = true

Features:

- signup
- signin
- me
- access token
- refresh token
- cookies
- bearer token

If authentication is enabled:

SignUp
SignIn
Me

may become dependencies of protected APIs.

---

# 31. AUTHENTICATION API

For Project API:

POST /auth/signup

POST /auth/signin

GET /auth/me

Optional:

POST /auth/refresh

POST /auth/logout

The dependency graph should understand:

Protected API
↓
Authentication
↓
Access token

---

# 32. SINGLE API AUTHENTICATION MODE

Single API can be:

AUTHENTICATION_ONLY

PUBLIC

AUTHENTICATED

If mode changes:

PUBLIC
→
AUTHENTICATED

the API gains authentication dependency.

This must appear in impact analysis.

---

# 33. MOCK DATA DEPENDENCIES

Mock data must not be treated as independent.

Mock data depends on:

- field type
- required fields
- enum
- validation
- relationships
- default values

Example:

email changes:

string
→
email

Mock data generation must adapt.

Example:

age:

string
→
number

Mock data must generate numeric age.

---

# 34. GENERATOR DEPENDENCY GRAPH

The system must internally represent:

Project
↓
Entity
↓
Field
↓
Validation

and:

Entity
↓
Relationship
↓
Entity

and:

Entity
↓
API
↓
Authentication

and:

Entity
↓
Mock Data

and:

Entity
↓
OpenAPI

and:

Entity
↓
TypeScript

and:

Entity
↓
Zod

Conceptually:

Project
├── Entity
│ ├── Field
│ │ └── Validation
│ ├── Relationship
│ └── API
│ └── Authentication
│
├── Mock Data
├── OpenAPI
├── Postman
├── Zod
├── TypeScript
└── Documentation

---

# 35. DEPENDENCY GRAPH

Create an internal dependency graph.

Each node should have:

{
"id": "...",
"type": "...",
"parentId": "...",
"metadata": {}
}

Example:

ENTITY:User

FIELD:User.email

VALIDATION:User.email.email

API:POST:/users

API:GET:/users

AUTH:Project

The graph can then calculate:

User.email changed
↓
FIELD:User.email
↓
VALIDATION:User.email
↓
POST:/users
↓
PUT:/users/:id
↓
PATCH:/users/:id
↓
OpenAPI
↓
Zod
↓
TypeScript
