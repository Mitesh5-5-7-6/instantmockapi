# 18 · AI Roadmap

← [17 · Coding Standard](./17-coding-standard.md) · [Master Index](./README.md)

The AI features that carry InstantMockAPI from a generation *tool* to a backend *intelligence layer*. These are V3+ (doc 16); this document details them. Throughout, "the inference service" means a pluggable LLM/model service — the architecture is **vendor-neutral** and doesn't depend on any specific provider.

---

## 1. The Architectural Insight That Makes This Cheap

Every AI feature below produces or enriches **one thing: the Internal Project Schema (IPS)**. Because the IPS is the single source of truth and every generator reads only from it (doc 09), AI slots in at the *front* of the pipeline as **another parser adapter** — and everything downstream (workers, hosting, export, versioning) is unchanged.

```
Natural language / Figma / screenshot / PDF
            │
            ▼
   AI inference service  ──►  IPS draft  ──►  (existing) Review → Generate → Workers A–G
            │
      user confirms/edits in the same Review screen
```

No new generation path, no fork in the worker DAG (doc 10) — AI is upstream of the IPS, not woven through the engine. This is the same seam noted in doc 06, §11 and doc 09, §2.

## 2. AI Requirement Understanding (natural language → IPS)

- **What:** a developer types or pastes a plain-language description ("a customer has many orders; each order has line items with quantity and price") and the inference service returns an **IPS draft** — entities, fields, types, and suggested validation.
- **Fit:** implemented as `ai-adapter`, a peer of `json-adapter`/`swagger-adapter` (doc 09, §2). Output must be a valid IPS or a structured, reviewable result.
- **Guardrails:** the result always lands in the **Review screen** for confirmation/editing before any generation — AI proposes, the user disposes. Nesting depth cap and IPS validation still apply (doc 13, §3).

## 3. AI Relationship Detection

- **What:** analyze the entities in an IPS and **infer relationships** — foreign keys, 1-1 / 1-N / N-N — that a human would otherwise wire by hand.
- **Fit:** enriches an existing IPS with relationship metadata; it **bootstraps the V2 relationship model** (doc 16). Requires the V2 relationship keys to exist in the IPS to write into.
- **Guardrails:** detected relationships are **suggestions surfaced in Review** with a clear diff ("InstantMockAPI thinks `order.customerId` → `customer`") — accepted, edited, or dismissed per relation.

## 4. AI Validation Suggestions

- **What:** from field names/semantics, propose **Layer 2 validation rules** (e.g., `email` → email + max length; `price` → decimal ≥ 0; `slug` → regex) beyond the deterministic Layer 1 auto-detection InstantMockAPI already does (doc 04, §F5).
- **Fit:** writes suggested rules into the IPS validation model; every validator generator then emits them like any other rule — no generator change needed.
- **Guardrails:** suggestions are opt-in per field in Review; the user's explicit rules always win over AI proposals.

## 5. AI Backend Assistant

- **What:** a conversational assistant grounded in a project's IPS that answers questions like "what does `POST /orders` expect?", "which fields are required?", or "what changed between v2 and v3?".
- **Fit:** reads the IPS + version snapshots + Artifact Registry (docs 07, 09) as context; it's a **read/explain layer**, not a new generator.
- **Guardrails:** answers are derived from the project's actual IPS/versions, keeping them accurate; it never silently mutates the project — any change it proposes routes back through Review.

## 6. New Input Modes

Each new input is simply **another way to produce an IPS draft**, then the normal flow resumes.

| Input | What it does | Adapter |
|---|---|---|
| **Figma import** | Read a design's forms/fields/components → infer entities and fields | `figma-adapter` |
| **Screenshot / OCR** | Extract fields from an image of a form or table | `ocr-adapter` |
| **PDF requirements** | Parse a requirements document into entities + rules | `pdf-adapter` |

All three converge on the same **Review → Generate** path; none touches the worker engine.

## 7. Reach: Extension, CLI, Desktop

Not AI per se, but part of the V3 expansion — the IPS becomes a **portable artifact** carried between tools:

- **VS Code extension:** generate/regenerate assets and pull the hosted mock URL without leaving the editor.
- **CLI:** scriptable generation (`InstantMockAPI generate`) for CI and power users, operating on the same IPS + config.
- **Desktop app:** local-first project management around the same platform.

Each is a **client of the existing platform API** (doc 08) plus the IPS contract — reusing the engine rather than reimplementing it.

## 8. Principles for AI Features

| Principle | Why |
|---|---|
| **AI produces IPS, nothing else** | Keeps the entire downstream pipeline unchanged; AI is upstream of the single source of truth |
| **Human-in-the-loop at Review** | AI proposes an IPS/enrichment; the user confirms before compute is spent — trust before generation (doc 01) |
| **Deterministic core stays deterministic** | Generators remain pure and testable (doc 15); AI's non-determinism is quarantined to the parsing/suggestion stage |
| **Vendor-neutral inference** | The model service is pluggable; no architectural lock-in to a provider |
| **Additive** | Every AI capability is a new adapter or a read/suggest layer — never a reshaping of the worker DAG (doc 10) |

## 9. Dependencies & Sequencing

- **Requirement understanding** and **new input modes** depend only on the parser-adapter seam that already exists in V1 — they can ship without engine changes.
- **Relationship detection** depends on **V2 relationships** existing in the IPS to write into.
- **Validation suggestions** and the **backend assistant** depend on the IPS/versions/Registry already in place (V1).
- **Reach (extension/CLI/desktop)** depends only on the stable platform API + IPS contract.

---

Back to [Master Index](./README.md)
