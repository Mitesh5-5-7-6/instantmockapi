# 🚨 HIGH PRIORITY: GLOBAL ERROR HANDLING + TOAST NOTIFICATION SYSTEM

THIS REQUIREMENT IS HIGH PRIORITY AND NON-NEGOTIABLE.

The current application has a serious UX problem:

The backend/API can return a detailed and useful error response, for example:

{
"message": "IPS validation failed",
"details": [
{
"path": "entities[1].fields[1].name",
"issue": "Field name 'sdsds dasds' must be alphanumeric starting with letter/underscore"
},
{
"path": "entities[2].name",
"issue": "Entity name 'asd' is invalid"
}
]
}

But the current UI may display only:

"IPS validation failed"

in a random location below the form.

This behavior MUST be removed.

The frontend must provide a professional, centralized, predictable error-handling system.

---

# 1. CORE ERROR UX RULE

Every error must have a deliberate destination.

There are ONLY TWO PRIMARY ERROR PRESENTATION PATTERNS:

### A. API / SERVER / NETWORK / SYSTEM ERRORS

→ ALWAYS use the global Toast notification system.

### B. FIELD-LEVEL VALIDATION ERRORS

→ ALWAYS display inline next to/below the relevant field.

Do NOT put API errors in random places in the page.

Do NOT render generic server errors below unrelated forms.

Do NOT create random red text blocks.

Do NOT silently swallow errors.

---

# 2. API ERROR → TOAST

Whenever an API request fails, the user must receive a toast.

Examples:

- POST request failed
- PATCH request failed
- DELETE request failed
- generation request failed
- publish request failed
- rollback request failed
- project save failed
- project creation failed
- server validation failed
- authentication request failed
- network failure
- timeout
- unexpected server error
- rate limit
- permission error

The user must immediately receive feedback.

Example:

┌──────────────────────────────────────┐
│ ✕ Request failed │
│ Unable to save project. │
│ │
│ [View details] │
└──────────────────────────────────────┘

The toast must appear through the GLOBAL toast system.

Never render this error somewhere arbitrary inside the page.

---

# 3. NO RANDOM ERROR LOCATIONS

REMOVE patterns like:

````tsx
{error && (
  <div className="text-red-500">
    {error}
  </div>
)}


ERROR ROUTING RULE

Implement centralized error routing.
API Response
      │
      ▼
Error Normalizer
      │
      ├── Field-specific validation
      │          ↓
      │     Inline field error
      │
      ├── API/server error
      │          ↓
      │     Global toast
      │
      ├── Network error
      │          ↓
      │     Global toast
      │
      ├── Authentication error
      │          ↓
      │     Global toast / auth flow
      │
      └── Unknown error
                 ↓
            Global error toast

type AppError = {
  type:
    | "VALIDATION"
    | "API"
    | "NETWORK"
    | "AUTH"
    | "NOT_FOUND"
    | "FORBIDDEN"
    | "RATE_LIMIT"
    | "UNKNOWN";


┌──────────────────────────────────────┐
│ ✕ Project validation failed          │
│                                      │
│ 3 fields need attention.             │
│                                      │
│ [View validation errors]             │
└──────────────────────────────────────┘


TOAST RULES

There must be ONE global toast system.

All application-level notifications must use it.

Supported types:

SUCCESS

Examples:

"Project saved"

"Version v5 published"

"API generated successfully"

ERROR

Examples:

"Failed to save project"

"Generation failed"

"Unable to publish version"

WARNING

Examples:

"Customer API is out of sync"

"Hosted API expires tomorrow"

INFO

Examples:

"Generation started"

"New version is being prepared"

LOADING

Examples:

"Generating version..."

"Publishing version..."

Use the existing toast library if the application already has one.

If no proper toast system exists, establish one centralized implementation.

DO NOT introduce multiple toast libraries.

11. TOAST POSITION

Use one consistent global position.

Preferred:

bottom-right

or another professional developer-tool position if the existing application already establishes a better convention.

The position must be consistent throughout the entire application.

Do not place different toasts in:

top-left on one page
bottom-center on another
inside a card on another
below a form on another

One global notification system in setting page user can change the notification place bottom, left, right, top in possible every place.


ERROR TOAST EXAMPLE

For a server error:

┌────────────────────────────────────────┐
│ ✕  Unable to generate API              │
│    Project validation failed.          │
│                                        │
│    3 validation issues found.          │
│                                        │
│    [View details]                 ×    │
└────────────────────────────────────────┘

If the user clicks:

[View details]

show the structured errors in a clean dialog/panel.

Example:

Validation errors

entities[1].fields[1].name

Field name must start with a letter,
number, or underscore.

────────────────────────────────────

entities[2].name

Entity name is invalid.


DO NOT SHOW RAW BACKEND JSON BY DEFAULT

Never dump:

{
  "message": "...",
  "details": [...]
}

directly into the normal application UI.

Normalize it.

Show a human-readable message.

Provide technical details through:

[View details]

This is especially important for developer tooling.

Developers need the technical details, but they should still be presented cleanly.

14. DO NOT SHOW RAW BACKEND JSON BY DEFAULT

Never dump:

{
  "message": "...",
  "details": [...]
}

directly into the normal application UI.

Normalize it.

Show a human-readable message.

Provide technical details through:

[View details]

This is especially important for developer tooling.

Developers need the technical details, but they should still be presented cleanly.

15. ERROR DETAIL PANEL

For complex API errors, provide an expandable detail view.

Example:

Generation failed

Project validation failed.

3 issues found.

[View details]

Then:

Validation Details

1.
Entity
Customer

Field
email

Error
Invalid validation rule.

────────────────────────

2.
Entity
Order

Field
customerId

Error
Referenced entity does not exist.

Use the existing application's dialog/drawer pattern.

Do not create a unique error UI for every API.

16. API ERROR STATUS MAPPING

Normalize common HTTP status codes.

Example:

400
→ "Request could not be processed."

401
→ authentication flow / session notification

403
→ "You don't have permission to perform this action."

404
→ "The requested resource was not found."

409
→ "This resource has changed. Refresh and try again."

422
→ validation handling

429
→ "Too many requests. Please try again shortly."

500
→ "Something went wrong on the server."

502/503/504
→ "The service is temporarily unavailable."

IMPORTANT:

If the backend provides a useful human-readable message, prefer it over a generic message.

17. NETWORK ERRORS

If the request never reaches the server:

Show:

Connection failed

We couldn't reach the API.
Check your connection and try again.

via the global toast.

Do not render:

undefined
Network Error
AxiosError
fetch failed

directly to the user.

Technical error details can be available through:

[View details]

where appropriate.

18. SUCCESS FEEDBACK

Important successful actions should also use the global toast system.

Examples:

After creating:

"Project created"

After saving:

"Changes saved"

After generating:

"Version v5 generated successfully"

After publishing:

"Version v5 is now live"

After rollback:

"Rollback created as version v6"

After deleting:

"Project deleted"

This creates consistent feedback throughout the product.

19. LOADING → SUCCESS/ERROR LIFECYCLE

Actions should follow a predictable lifecycle.

Example:

User clicks:

[Generate]

↓

Button:

Generating...

↓

Global toast:

Generation started

↓

Worker completes:

Version v5 generated successfully

OR:

Generation failed
[View details]

Do not leave the user wondering whether the action actually happened.

20. DUPLICATE NOTIFICATION PREVENTION

Avoid duplicate notifications.

Bad:

API client:
"Generation failed"

Component:
"Generation failed"

Hook:
"Generation failed"

Result:

3 identical toasts.

Instead, define a clear responsibility.

Prefer:

API/client layer
→ throws normalized error

Feature/action layer
→ decides user notification

Global error boundary
→ catches unexpected UI errors

Use one notification per user action.

21. API CLIENT RULE

The API client should NOT automatically show a toast for every error if feature-level code needs to handle the error.

Prefer:

API client
    ↓
normalize error
    ↓
return/reject
    ↓
feature/action handler
    ↓
toast OR inline field error

This prevents duplicate toasts and allows field validation to be routed correctly.

22. FORM SUBMISSION RULE

For form submissions:

Field validation failure

Show inline.

Server validation with identifiable fields

Map to inline fields.

Server validation without identifiable fields

Show toast.

Network/server failure

Show toast.

Unexpected error

Show toast.

Example:

Create Project

Name
┌──────────────────────┐
│                      │
└──────────────────────┘
✕ Project name is required

This is correct.

Not:

Create Project

[Create]

Project creation failed

when the actual issue is simply that the Name field is empty.

23. VALIDATION PRIORITY

Use this priority:

Client-side field validation
Server field validation
Global API error
Network/system error
Unexpected error

Always present the most actionable information possible.

24. ERROR BOUNDARY

Implement or standardize a global React/application error boundary if one does not already exist.

Unexpected UI/runtime errors should produce a controlled user experience.

Example:

Something went wrong

An unexpected error occurred.

[Try again]

Do not expose raw stack traces in the normal interface.

Developer details can be logged through the existing observability system.

25. OBSERVABILITY

User-facing errors and developer-facing errors are different.

User-facing:

Toast / inline error.

Developer-facing:

Logs / Sentry / OpenTelemetry / server logs, depending on the existing architecture.

Do NOT show internal stack traces, database errors, Redis errors, or implementation details directly to normal users.

26. ERROR CORRELATION

When possible, preserve:

request ID
error code
status code
timestamp

for technical debugging.

Example:

Generation failed

Error ID: req_8f3...
[View details]

Do not expose sensitive information.

Do not make the technical ID the primary message.

27. TOAST ACCESSIBILITY

The toast system must support:

screen-reader announcements
keyboard accessibility
readable contrast
dismiss button
appropriate timing
persistent display for important errors

Important errors should not disappear before the user can reasonably read them.

28. TOAST ACTIONS

Where useful, provide actions.

Examples:

Project saved

[Undo]
Generation failed

[View details]
Session expired

[Sign in]

Do not add actions when they do not provide real value.

29. NEVER USE BROWSER ALERTS

Remove application usage of:

alert(...)
confirm(...)

for normal product interactions.

Use:

Toast
Dialog
Inline validation

depending on the situation.

30. NEVER USE RANDOM INLINE ERROR BLOCKS

Avoid patterns such as:

<form>
...
</form>

<div class="error">
  Something went wrong
</div>

unless that block is specifically an inline field/form-level validation state.

A form-level error can be valid when the error genuinely applies to the whole form.

Example:

Unable to save project because the project
definition is invalid.

But even then, use a standardized form error component, not a random <div>.

31. FORM-LEVEL ERROR

A form-level error is allowed only when the error genuinely applies to the entire form.

Example:

┌──────────────────────────────────────────┐
│ ⚠ Project configuration is invalid       │
│                                          │
│ 3 fields need attention.                 │
│                                          │
│ Please review the highlighted fields.    │
└──────────────────────────────────────────┘

This should be a standardized component.

Do not create custom styling on individual pages.

32. CURRENT IPS ERROR MUST BE FIXED

The current behavior shown in the application:

[ Generate ]

IPS validation failed

MUST NOT remain.

The detailed backend validation response should be correctly processed.

Expected behavior:

User clicks:

[Generate]

API returns:

IPS validation failed

with structured details.

Frontend:

Parse the response.
Normalize the error.
Map field-specific errors where possible.
Show inline field errors for mapped fields.
Show one global toast summarizing the failure.
Allow the user to inspect full details.
Do not render the old random "IPS validation failed" block.

Example:

Toast:

✕ Project validation failed

3 validation errors found.

[View details]

Fields:

Entity Name
┌────────────────────┐
│ asd                │
└────────────────────┘
✕ Entity name must start with a letter.
Field Name
┌────────────────────┐
│ sdsds dasds        │
└────────────────────┘
✕ Field name must be alphanumeric
  starting with a letter or underscore.
33. ERROR UX IS PART OF THE DESIGN SYSTEM

Treat error handling as a first-class design-system component.

The design system includes:

Button
Input
Dialog
Dropdown
Table
Badge
Toast
Loading
Empty State
Error State
Field Error
Form Error
Error Details

Error UX is NOT an afterthought.

Every new feature implemented in the application must use the same error system.

34. DEVELOPER IMPLEMENTATION RULE

Before adding any new API call, determine:

"What happens if this request fails?"

Every mutation must have a defined:

loading state
success feedback
error feedback

Example:

Create Project

Loading
↓
Success → success toast

Failure
↓
Validation → inline field errors
API/server → error toast
Network → error toast
Unknown → error toast

The same rule applies to:

save
generate
publish
rollback
delete
duplicate
update
import
export
regenerate
settings changes
project creation
entity creation
field creation
relationship creation
35. HIGH-PRIORITY ACCEPTANCE CRITERIA

This section is NON-NEGOTIABLE.

[ ] No API error is rendered in a random location.

[ ] Every API/server/network failure produces a global toast.

[ ] Field-specific validation errors appear inline next to the field.

[ ] Server validation errors with structured paths are mapped to fields when possible.

[ ] Unmappable server errors use a global toast.

[ ] Complex errors can expose detailed information through "View details".

[ ] Backend error messages are not unnecessarily discarded.

[ ] Multiple validation errors do not produce multiple duplicate toasts.

[ ] One user action produces at most one appropriate global error notification.

[ ] Success actions use the global toast system.

[ ] Loading → success/error lifecycle is consistent.

[ ] Toast design matches the InstantMockAPI black + green theme.

[ ] Error uses red semantic accent.

[ ] Warning uses amber semantic accent.

[ ] Success uses MongoDB-inspired green accent.

[ ] Toasts are accessible.

[ ] Browser alert/confirm is not used for normal application interactions.

[ ] Duplicate toast implementations are removed.

[ ] Random inline API error blocks are removed.

[ ] The current "IPS validation failed" random UI block is removed.

[ ] API error handling is centralized.

[ ] Error normalization is reusable across the entire application.

[ ] Unexpected runtime errors have a controlled fallback.

[ ] Internal stack traces are not shown to normal users.

[ ] Every new API mutation defines loading, success, and error behavior.

36. PRIORITY

Treat this requirement as:

P0 / HIGH PRIORITY

Do not consider the UI theme migration complete until this error/notification system is implemented.

This is not cosmetic styling.

This is core product UX.

A professional developer platform must clearly communicate:

what happened
whether the action succeeded
whether it failed
what the user needs to fix
where the problem is
whether the request is still processing

The user must never be left with a vague message in an arbitrary part of the screen.

FINAL RULE:

API ERROR
→ GLOBAL TOAST

FIELD VALIDATION
→ INLINE FIELD ERROR

FORM-WIDE VALIDATION
→ STANDARDIZED FORM ERROR + TOAST WHEN APPROPRIATE

SUCCESS
→ GLOBAL SUCCESS TOAST

LOADING
→ BUTTON/PROGRESS STATE + OPTIONAL INFO TOAST

UNEXPECTED ERROR
→ GLOBAL ERROR TOAST

NO RANDOM ERROR MESSAGE PLACEMENT.


### The resulting behavior should be very clear

```text
                     API REQUEST
                          │
                          ▼
                  ┌───────────────┐
                  │ Error Parser  │
                  └───────┬───────┘
                          │
             ┌────────────┼────────────┐
             │            │            │
             ▼            ▼            ▼
        Field Error    API Error    Network Error
             │            │            │
             ▼            ▼            ▼
        Inline Field     TOAST        TOAST
             │            │            │
             └────────────┼────────────┘
                          ▼
                   User understands
                     what happened

And for your specific screenshot, the important transformation is:

Current:

Generate

IPS validation failed

New:

Generate
   ↓
┌──────────────────────────────────┐
│ ✕ Project validation failed      │
│   3 validation errors found.     │
│                                  │
│   [View details]                 │
└──────────────────────────────────┘

Entity Name
[ asd                    ]
✕ Entity name must start with a letter

Field Name
[ sdsds dasds            ]
✕ Field name must be alphanumeric...

That is the right separation: the toast tells the user that the operation failed, while the inline errors tell them exactly what to fix. This should be enforced globally so Phase 2 and every future phase automatically follows the same behavior.
````
