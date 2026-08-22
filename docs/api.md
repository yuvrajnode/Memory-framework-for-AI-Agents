# HTTP API

Base URL defaults to `http://localhost:8080`. The machine-readable schema is
served at `/openapi.json`.

## Authentication

Optional. Set `API_KEY` on the server and every route except `/health`,
`/ready`, `/` and `/openapi.json` requires it:

```bash
curl -H 'x-api-key: your-key' localhost:8080/v1/stats
# or
curl -H 'authorization: Bearer your-key' localhost:8080/v1/stats
```

Keys are compared in constant time.

## Errors

Every failure returns the same shape:

```json
{
  "error": "ValidationError",
  "code": "VALIDATION_ERROR",
  "message": "content must not be empty",
  "details": { "length": 0 }
}
```

| Code | Status | Meaning |
|---|---|---|
| `VALIDATION_ERROR` | 400 | The payload was rejected |
| `CONFIRMATION_REQUIRED` | 400 | A destructive route needs `?confirm=true` |
| `UNAUTHORIZED` | 401 | Missing or wrong API key |
| `NOT_FOUND` | 404 | No such memory |
| `ROUTE_NOT_FOUND` | 404 | No such route |
| `RATE_LIMITED` | 429 | Too many requests |
| `EMBEDDING_ERROR` | 502 | The embedding provider failed |
| `STORE_ERROR` | 503 | The backing store is unreachable |
| `INTERNAL_ERROR` | 500 | Unhandled — details go to the log, not the response |

---

## Write a memory

`POST /v1/memories`

```json
{
  "content": "Ada asked that migrations always run before the app rollout.",
  "kind": "semantic",
  "source": "user",
  "importance": 0.9,
  "tags": ["deploy", "database"],
  "namespace": "team-platform",
  "metadata": { "channel": "slack" },
  "ttlMs": 604800000
}
```

Only `content` is required. Defaults: `kind` `episodic`, `source` `agent`,
`importance` `0.5`, `namespace` from `DEFAULT_NAMESPACE`.

Returns **201** with the stored record, or **200** with
`"deduplicated": true` when the write merged into an existing memory. Exact
restatements are caught by fingerprint; near restatements by token overlap. A
merge strengthens the existing record's importance rather than creating a
second copy.

### Batch

```json
{ "memories": [ { "content": "…" }, { "content": "…" } ] }
```

Up to 500 per request. Returns a count plus how many deduplicated.

---

## Browse and search

`GET /v1/memories`

| Parameter | Notes |
|---|---|
| `namespace` | |
| `kind` | Comma separated |
| `source` | Comma separated |
| `tags` | Comma separated — **all** must match |
| `anyTags` | Comma separated — **any** may match |
| `minImportance` | |
| `search` | Runs the full recall pipeline, not a substring match |
| `limit` | 1–500, default 50 |
| `offset` | |
| `orderBy` | `createdAt` · `updatedAt` · `lastAccessedAt` · `importance` · `accessCount` |
| `direction` | `asc` · `desc` |

Embeddings are omitted from responses — they are most of a record's bytes and
useless to a client. Pass `?includeEmbeddings=true` on the single-record route
to opt back in.

With `search`, each result additionally carries `score` and `breakdown`.

---

## Recall

`POST /v1/recall`

```json
{
  "query": "how do I fix a runner that ran out of disk?",
  "namespace": "team-platform",
  "limit": 8,
  "diversity": 0.25,
  "minScore": 0.15,
  "weights": { "semantic": 1, "lexical": 0.6, "recency": 0.2 },
  "filter": { "kinds": ["procedural", "semantic"] },
  "reinforce": true
}
```

```json
{
  "query": "how do I fix a runner that ran out of disk?",
  "took": 3,
  "count": 3,
  "results": [
    {
      "memory": { "id": "mem_...", "kind": "procedural", "content": "…", "retention": 0.99 },
      "score": 0.661,
      "breakdown": {
        "semantic": 0.67, "lexical": 1, "recency": 0.08,
        "importance": 0.95, "usage": 0, "retention": 0.99
      }
    }
  ]
}
```

`diversity` in `[0, 1]` controls MMR reranking: `0` is plain top-k, around
`0.3` gives noticeably broader coverage. `reinforce: false` reads without
resetting the decay clock — use it for operator tooling, so inspecting a store
does not change it.

---

## Context assembly

`POST /v1/context`

```json
{ "query": "what is blocking the release?", "budgetTokens": 400 }
```

```json
{
  "text": "# Relevant memory\n\n## Learned procedures\n- …",
  "estimatedTokens": 312,
  "budgetTokens": 400,
  "utilization": 0.78,
  "included": [{ "id": "mem_...", "kind": "procedural", "score": 0.66 }],
  "droppedCount": 4
}
```

`text` is ready to drop into a system prompt. `droppedCount` tells you when the
budget is the binding constraint.

---

## Maintenance

`POST /v1/consolidate`

```json
{ "namespace": "team-platform", "similarityThreshold": 0.82, "minClusterSize": 3 }
```

Returns the clusters found, the facts created, and how many sources were
superseded.

`POST /v1/maintenance`

```json
{ "namespace": "team-platform", "dryRun": true, "maxRecords": 5000 }
```

Returns a report naming the records claimed by each pass — `expired`,
`evictedStale`, `evictedCapacity`, `prunedSuperseded`. **Start with
`dryRun: true`.**

`DELETE /v1/memories?namespace=x&confirm=true`

Irreversible. The `confirm` parameter is required.

---

## Observability

- `GET /health` — liveness. Never touches the store, so a slow disk cannot get
  a healthy container restarted.
- `GET /ready` — readiness. Exercises the store and reports the active backend
  and embedder.
- `GET /v1/stats` — totals, composition by kind and source, mean importance and
  retention, link count, approximate token footprint.
- `GET /v1/graph` — nodes and edges for visualisation.

Both probes are exempt from rate limiting.
