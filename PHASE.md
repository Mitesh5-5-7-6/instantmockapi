PHASE 0
Canonical Project Definition
│
▼
PHASE 1 ← WE ARE HERE
Edit + Dependency Graph
│
├── Entity editing
├── Field editing
├── Validation editing
├── Relationship editing
├── API configuration editing
├── Dependency graph
├── Change detection
└── Impact analysis
│
▼
PHASE 2
Versioning + Visual Diff
│
├── Version creation
├── Version history
├── Before/after comparison
├── Rollback
└── Selective regeneration
│
▼
PHASE 3
Authentication
│
├── SignUp
├── SignIn
├── Access token
├── Refresh token
├── Cookie auth
├── Public API
└── Protected API
│
▼
PHASE 4
Technical Notes + Blueprint
│
├── Technical Notes
├── AI-ready documentation
├── Blueprint export
└── Blueprint import
│
▼
PHASE 5
Admin + Plans + Analytics
│
▼
PHASE 6
V1 production architecture

Cold-start latency: after inactivity, the first request may take significantly
longer while the backend instance wakes and initializes. Warm requests should be
fast. After further inactivity it can happen again, so from a caller's side it
reads as intermittent rather than as a slow first load.

                         ┌──────────────────────┐
                         │       Vercel         │
                         │   Next.js / React    │
                         │      Frontend        │
                         └──────────┬───────────┘
                                    │
                                    ▼
                         ┌──────────────────────┐
                         │    API / Backend     │
                         │        Render        │
                         │                      │
                         │ Auth                 │
                         │ Projects             │
                         │ Versions             │
                         │ Blueprints           │
                         │ Project configuration│
                         │ Hosted API routing   │
                         └───────┬────────┬─────┘
                                 │        │
                       ┌─────────┘        └─────────┐
                       ▼                            ▼
              ┌────────────────┐          ┌────────────────┐
              │    MongoDB     │          │ Upstash Redis  │
              │     Atlas      │          │                │
              │                │          │ Cache          │
              │ Source of      │          │ BullMQ Queue   │
              │ Truth          │          │ Rate Limiting  │
              └────────────────┘          │ Temporary Data │
                                          └───────┬────────┘
                                                  │
                                                  │ BullMQ
                                                  ▼
                                        ┌──────────────────┐
                                        │      Worker      │
                                        │      Render      │
                                        │                  │
                                        │ Generation       │
                                        │ Mock data        │
                                        │ OpenAPI          │
                                        │ Postman          │
                                        │ Code generation  │
                                        │ Artifact build   │
                                        └────────┬─────────┘
                                                 │
                                                 ▼
                                        ┌──────────────────┐
                                        │ Cloudflare R2 /  │
                                        │ S3 Object Store  │
                                        │                  │
                                        │ Generated ZIPs   │
                                        │ Large artifacts  │
                                        └──────────────────┘
                                          target, not V1 —
                                          V1 keeps these in
                                          MongoDB GridFS

MongoDB is the source of truth. Redis is disposable infrastructure.

See INFRASTRUCTURE.md for the whole of it: the cold-start sequence, where
artifacts actually live, the connection lifecycle, the per-request cost of a
hosted API, what the request log records, and the scaling path.
