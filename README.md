<div align="center">

# Mnemos

**A memory framework for AI agents.**
Hybrid recall, principled forgetting, consolidation, and token-budgeted context assembly.

[![CI](https://github.com/yuvrajnode/Memory-framework-for-AI-Agents/actions/workflows/ci.yml/badge.svg)](https://github.com/yuvrajnode/Memory-framework-for-AI-Agents/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178c6.svg)
![Tests](https://img.shields.io/badge/tests-175%20passing-2e6b5a.svg)

</div>

---

## The problem

An agent with a context window and no memory starts every session from nothing.
An agent that appends everything to a vector store ends up worse: by week three
the same preference has been written fifty times, a scratch note from a
finished task outranks the live one because it happens to share vocabulary, and
retrieval quietly degrades into noise.

Storing memories is easy. Deciding what to keep, what to merge, what to let
fade, and which subset actually fits in the eight hundred tokens you have to
spend — that is the hard part, and it is what Mnemos is about.

## What it does

**Four kinds of memory, each with its own lifetime.** Episodic (what happened),
semantic (distilled fact), procedural (a learned routine), and working (scratch
state for the current task). They are not labels — they drive different decay
rates, different consolidation behaviour, and different eviction protection.

**Hybrid recall that shows its work.** Five signals — semantic cosine, BM25
lexical overlap, recency, importance, and reinforcement from prior recalls —
blended, then multiplied by the memory's retention. Every result carries a
per-signal breakdown, so you can tell whether a hit surfaced on merit or just
on recency.

**Forgetting as a first-class operation.** Retention follows an exponential
decay keyed to the last time a memory was *touched*, not created — so recall
reinforces, and the store curates itself. What an agent keeps using stays warm;
what it never revisits cools until maintenance reclaims it.

**Consolidation.** Clusters of related episodes are distilled into single
semantic facts that then decay on the far slower semantic half-life. Sources
are marked superseded rather than deleted, so the chain from a fact back to its
evidence survives.

**Context assembly, not just retrieval.** `buildContext()` returns the best set
of memories that *fits* a token budget, ordered so that truncation drops raw
episodes rather than the procedures that shape the response.

## Quick start

```bash
npm install
npm run build:core
npm run dev          # dashboard on http://localhost:5173
```

The dashboard runs the real engine in the browser and seeds itself with a
realistic three-week agent corpus, so there is nothing else to start.

### As a library

```ts
import { MemoryEngine } from '@mnemos/core';

const memory = new MemoryEngine();

await memory.remember({
  content: 'Ada asked that migrations always run before the app rollout.',
  kind: 'semantic',
  importance: 0.9,
  tags: ['deploy', 'database'],
});

// Ranked recall, with the reasoning attached.
const results = await memory.recall('what order do deploys go in?');
results[0].breakdown;
// { semantic: 0.71, lexical: 0.88, recency: 0.99,
//   importance: 0.9, usage: 0, retention: 1 }

// Or go straight to a prompt block that fits your budget.
const { text, included, dropped } = await memory.buildContext(
  'what order do deploys go in?',
  { budgetTokens: 400 },
);
```

`new MemoryEngine()` works with no configuration, no API key and no network —
it defaults to an in-memory store and a deterministic offline embedder. Swap
either without touching anything else:

```ts
import { MemoryEngine, SqliteStore, OpenAIEmbedder } from '@mnemos/core';

const memory = new MemoryEngine({
  store: new SqliteStore({ path: './data/mnemos.db' }),
  embedder: new OpenAIEmbedder({ apiKey: process.env.OPENAI_API_KEY! }),
});
```

### As a service

```bash
docker compose up --build          # API on :8080
curl localhost:8080/openapi.json
```

```bash
curl -X POST localhost:8080/v1/context \
  -H 'content-type: application/json' \
  -d '{"query":"how do I fix a runner out of disk?","budgetTokens":300}'
```

## How recall works

```
                   ┌─────────────────────────────────────────┐
   query ──────────▶            hard filters                  │
                   │  namespace · kind · tags · time · TTL    │
                   └────────────────────┬────────────────────┘
                                        ▼
                            bounded candidate pool
                              (newest N, default 400)
                                        │
                 ┌──────────────────────┼──────────────────────┐
                 ▼                      ▼                      ▼
          cosine similarity      BM25 over the pool      recency · importance
        (dense, paraphrases)   (exact names and ids)         · usage
                 └──────────────────────┼──────────────────────┘
                                        ▼
                             weighted blend ∈ [0,1]
                                        │
                                        ▼
                              × retention  (decay)
                                        │
                                        ▼
                            MMR rerank for diversity
                                        │
                                        ▼
                        token-budget packing → prompt block
```

Two decisions carry most of the weight:

**Retention multiplies, it does not merely rank.** A faded memory is suppressed
in proportion to how far it has decayed. This is what stops a year-old scratch
note from surfacing simply because it shares vocabulary with the query.

**The candidate pool is bounded.** Cost is linear in the pool, not in the store,
so recall latency stays flat as a namespace grows from a hundred memories to a
hundred thousand.

## Architecture

```
packages/core     the framework — zero runtime dependencies, isomorphic
  types           four memory kinds, provenance, salience, TTL
  embeddings      EmbeddingProvider + offline hashing and OpenAI providers
  store           MemoryStore + in-memory, JSON snapshot and SQLite backends
  retrieval       BM25, signal blending, MMR reranking
  pipeline        decay, clustering, consolidation, maintenance
  graph           entity extraction and associative linking
  context         token-budget packer
  engine.ts       the facade that wires it together

apps/server       Fastify REST API — OpenAPI, auth, rate limiting, health
apps/web          operator dashboard — Vite + React, no UI framework
```

The core has **no runtime dependencies** and no `node:` imports outside the two
Node-only stores, which is what lets `@mnemos/core/browser` run the entire
engine in a browser tab. The dashboard uses that: it probes for a configured
API and falls back to running the real framework client-side, so one build
serves both as an operator console and as a genuine static demo.

### Choosing a store

| Store | Use it when | Durability |
|---|---|---|
| `InMemoryStore` | tests, previews, short-lived sessions | none |
| `JsonFileStore` | single-node self-host, local development | atomic snapshots (temp-then-rename) |
| `SqliteStore` | production single-node, working set beyond memory | WAL, indexed, transactional |

All three run the same conformance suite, so swapping one cannot change what a
query returns.

### Choosing an embedder

`HashingEmbedder` is deterministic and offline: token, bigram and
character-trigram features projected through signed hashing with sublinear term
weighting. It is not a neural embedder and does not pretend to be — but it
captures lexical and morphological similarity well enough to develop, test and
demo the whole stack with no API key, and being deterministic makes retrieval
tests reproducible.

`OpenAIEmbedder` is the production path: batched, timeout-bounded, and retried
on rate limits.

## API

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/v1/memories` | Write one memory, or a batch |
| `GET` | `/v1/memories` | Browse, or rank with `?search=` |
| `GET` | `/v1/memories/:id` | Fetch one |
| `PATCH` | `/v1/memories/:id` | Edit — content changes re-embed |
| `DELETE` | `/v1/memories/:id` | Forget |
| `POST` | `/v1/recall` | Ranked recall with score breakdowns |
| `POST` | `/v1/context` | Recall and pack to a token budget |
| `GET` | `/v1/stats` | Namespace statistics |
| `GET` | `/v1/graph` | Association graph snapshot |
| `POST` | `/v1/consolidate` | Distil episode clusters into facts |
| `POST` | `/v1/maintenance` | Expire, evict and prune (`dryRun` supported) |
| `GET` | `/health` · `/ready` | Liveness (never touches the store) · readiness |

Full schema at `/openapi.json`. See [`docs/api.md`](docs/api.md).

## Configuration

| Variable | Default | Notes |
|---|---|---|
| `PORT` | `8080` | |
| `STORE` | `sqlite` | `memory` · `json` · `sqlite` |
| `DATA_DIR` | `./data` | |
| `EMBEDDER` | `hashing` | `openai` requires `OPENAI_API_KEY` |
| `EMBEDDING_DIMENSIONS` | `384` | `1536` for OpenAI defaults |
| `API_KEY` | unset | When set, all non-health routes require it |
| `CORS_ORIGINS` | `*` | Comma separated |
| `RATE_LIMIT_MAX` | `240` | Per `RATE_LIMIT_WINDOW_MS` |
| `MAINTENANCE_INTERVAL_MS` | `0` | Background consolidate + reclaim; `0` disables |

Invalid values fail at boot rather than being coerced — a bad deployment should
crash with a precise message, not serve traffic on a silently wrong default.

## Development

```bash
npm install
npm run build:core     # downstream packages resolve core from dist
npm test               # 175 tests
npm run typecheck      # strict, across all three packages
npm run dev            # dashboard
npm run dev:server     # API
```

## Deployment

| Target | Command |
|---|---|
| Docker | `docker compose up --build` |
| Render | `render.yaml` — container plus a persistent disk |
| Vercel / Netlify | `vercel.json` / `netlify.toml` — dashboard as a static site |

Point the dashboard at a live API with `VITE_API_URL`. Without one it runs the
engine in the browser, which is the intended behaviour for a public demo.

## Design notes

Some choices worth explaining, since they are the ones a reviewer would
question:

- **The extractive summariser is the default, not the LLM one.** It can only
  restate text that is already stored, so consolidation cannot hallucinate a
  detail and promote it into long-term memory. That safety property is worth
  more than prose quality for the default path.
- **Rule-based entity extraction.** A memory framework should not need a model
  just to index memories, and the high-value entities here — ticket ids, URLs,
  emails, version strings, proper nouns — are exactly what regexes handle
  reliably.
- **BM25 is rebuilt per query** over the filtered candidate set rather than
  persisted. IDF then reflects the corpus actually being searched, and there is
  no second index to keep consistent with the store.
- **No UI framework in the dashboard.** The design system is a few hundred
  lines of CSS custom properties. Charts and the force-directed graph layout
  are hand-written rather than pulled from d3 or a plotting library.

## License

MIT © [yuvrajnode](https://github.com/yuvrajnode)
