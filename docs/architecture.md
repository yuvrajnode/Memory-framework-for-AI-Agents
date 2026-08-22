# Architecture

This document covers the reasoning behind the design. The README covers what
the framework does; this covers why it does it that way, and what the
alternatives were.

## Layering

```
                    MemoryEngine  (facade)
                          │
    ┌─────────┬───────────┼───────────┬──────────┐
    ▼         ▼           ▼           ▼          ▼
 Retriever  Decay   Consolidator   Graph    ContextPacker
    │         │           │           │
    └─────────┴─────┬─────┴───────────┘
                    ▼
               MemoryStore          EmbeddingProvider
        (in-memory / json / sqlite)  (hashing / openai)
```

Two extension points carry the whole design: `MemoryStore` and
`EmbeddingProvider`. Everything else is composition over those.

### Why the store contract is narrow

The store owns durability and hard filtering. It does **not** own scoring,
decay, or ranking. That split means a new backend implements CRUD plus a
predicate and inherits the entire retrieval stack unchanged.

The alternative — pushing scoring into the database, as a pgvector-backed
design would — is faster at scale but couples ranking to one engine's
capabilities. Since retention decay, MMR and signal blending are all things a
vector index cannot express anyway, the split costs less than it looks like it
should.

The consequence is enforced by a single conformance suite that every backend
runs. Swapping stores cannot change what a query returns; that is a test, not a
promise.

## Retrieval

### Why hybrid

Dense retrieval alone reliably misses the things agents look up by name: an
order id, a flag like `--no-cache`, a surname. Lexical alone misses paraphrase.
Neither is sufficient, so both run and are blended.

BM25 is built **per query** over the already-filtered candidate set. This is
unusual — most systems persist an inverted index — and it is deliberate:

- IDF reflects the corpus actually being searched, not the whole store, which
  matters when a query is scoped to one namespace or one memory kind.
- There is no second index to keep consistent with the store, so backends stay
  simple.
- Cost is bounded by the candidate pool, which is bounded by configuration.

Raw BM25 is unbounded, so scores are normalised by the best score in the result
set. The output is relative within one query — exactly what ranking needs — and
lands in `[0, 1]` so it can be blended.

### Why retention multiplies

The five signals are combined as a weighted mean, and the result is then
*multiplied* by the record's retention rather than having retention enter the
mean as a sixth signal.

If retention were just another weighted term, a strongly matching but stale
memory would still score respectably. Multiplying suppresses it in proportion
to how far it has faded. This is the mechanism that stops a store from
surfacing a finished task's scratch notes because they happen to share
vocabulary with a live query.

### Why the pool is bounded

Recall scores at most `candidatePool` records (default 400), taken newest
first. Cost is therefore linear in the pool, not in the store. A namespace can
grow from a hundred memories to a hundred thousand without recall latency
moving.

The tradeoff is that a very old, very relevant memory outside the pool is
missed. In practice that is mitigated by consolidation — anything important
enough to matter repeatedly gets distilled into a semantic record that keeps
getting rewritten forward.

## Forgetting

Retention is `0.5 ^ (age / halfLife)`, floored so nothing becomes permanently
unrecallable.

The important detail is that **age is measured from the last time a memory was
touched — created or recalled — not from creation**. Recall therefore
reinforces. That single choice is what makes the store self-curating: what an
agent keeps using stays warm, and what it never revisits cools until
maintenance reclaims it. No explicit relevance feedback loop is needed.

Half-lives are per kind, then stretched by two factors:

| Factor | Effect | Rationale |
|---|---|---|
| Importance | up to 2× at importance 1.0 | The caller's main lever over what persists |
| Usage | `1 + 0.6·ln(1 + accessCount)` | Spacing effect: early recalls matter far more than the fiftieth |

Base half-lives (working 2h, episodic 7d, semantic 120d, procedural 365d) map
onto how the kinds are actually used rather than onto anything from the
psychology literature.

## Consolidation

Clustering is single-link agglomerative via union-find. Single-link is the
right shape here because a conversation drifts across a topic — "prefers dark
mode" → "hates the light theme at night" → "set the editor to dark" — and
single-link chains those together without a cluster count chosen upfront. Its
usual weakness, chaining unrelated items through a long bridge, is bounded by a
maximum cluster size.

It is O(n²) in the candidate count. That is acceptable because consolidation
runs over a capped batch during maintenance, never on the request path.

**The extractive summariser is the default deliberately.** It scores sentences
by cross-passage term frequency and emits the highest-scoring ones in their
original order. The prose is unremarkable, but it can only ever restate text
that was already stored — so consolidation cannot hallucinate a fact into
long-term memory. For an unattended background process that permanently
rewrites what an agent believes, that safety property outweighs fluency. The
LLM-backed summariser is available and falls back to the extractive one on
provider failure.

## Maintenance

Three passes, in increasing order of aggression:

1. **TTL expiry** — an explicit promise the caller made. Always honoured, even
   for otherwise protected kinds.
2. **Retention staleness** — the memory has gone cold.
3. **Capacity pressure** — the namespace is simply over its cap.

They are separate rather than one combined score because they answer different
questions, and an operator needs to see which one reclaimed a record. Capacity
eviction ranks by `retention × (0.25 + importance)` rather than by age, so it
sheds what is both cold and unimportant instead of blindly dropping the oldest
thing.

Procedural memories and anything above 0.9 importance are exempt from passes 2
and 3.

## The graph

Vector recall answers "what resembles this query". A graph answers "what else
came up around this", which is how an agent follows a thread from a symptom
back to a fix it found three sessions ago.

Edges are built from two independent signals because they fail in different
places:

- **Dense similarity** misses two notes that share only an order id.
- **Entity overlap** misses two paraphrases with no proper nouns at all.

Edge ids are derived from the ordered endpoint pair, so re-linking a record
updates the existing edge rather than duplicating it.

Entity extraction is rule-based. A memory framework should not require a model
just to index memories, and the high-value entities in agent memory —
identifiers, URLs, emails, version strings, proper nouns — are exactly what
regular expressions handle reliably. Capitalisation alone is weak evidence, so
an entity must be multi-word, recurring, or machine-readable in shape before it
is treated as distinctive.

## Context assembly

Recall returning "the best twelve memories" is not useful to a runtime with 800
tokens to spend. It needs the best set that *fits*.

Packing is greedy over ranked results, with two deliberate choices:

- Sections are emitted in **behavioural order** — procedures, facts, task
  state, episodes — so that when truncation bites, it drops raw episodes rather
  than the procedures that shape the response.
- A memory that does not fit is **skipped, not terminal**, so one long record
  cannot starve every shorter one behind it.

Token counts are estimated (≈4 characters per token, floored at one per word)
rather than tokenised, to avoid a tokenizer dependency in an isomorphic
package. The estimate runs slightly conservative, which is the correct
direction to be wrong in.

## Isomorphism

The core imports no `node:` builtins outside `JsonFileStore` and `SqliteStore`.
Content fingerprints use four seeded FNV-1a passes rather than SHA-256, and
randomness goes through WebCrypto.

The fingerprint is explicitly **non-cryptographic**. It is a deduplication key
that needs speed, stability and a good avalanche — not collision resistance
against an adversary.

This is what makes `@mnemos/core/browser` possible, and therefore what makes
the dashboard a real static demo rather than a mock: the ranking a visitor sees
is the actual implementation.

## Measuring ranking quality

Retrieval is an aggregate property, so it is measured rather than asserted.
`test/fixtures/corpus.ts` holds a labelled corpus — twelve memories across all
four kinds, each tagged with a stable `ref`, plus twelve queries naming the
record that should rank first. `test/retrieval-quality.test.ts` runs it and
pins top-1 accuracy, MRR, top-5 recall, exact-identifier lookup, and the
margin between the correct answer and the best wrong one.

That harness is what found the two ranking defects fixed in this repository:
`cosineScore` mapping unrelated text to 0.5 rather than 0, and default weights
that had been guessed rather than searched. The thresholds sit below the
measured values on purpose — they are there to catch regressions, not to
freeze the current numbers.

A twelve-query benchmark is small, and it is worth being explicit about what
that means: it is enough to catch a change that breaks ranking, and not enough
to justify deleting a feature. The grid search's optimum sets the importance
weight to zero; the shipped defaults do not, because a benchmark this size is
not evidence that the caller's main lever over persistence should be removed.

## Known limits

Worth stating plainly:

- **Single-node.** `SqliteStore` and `JsonFileStore` assume one writer. A
  multi-instance deployment needs a Postgres or similar backend, which the
  `MemoryStore` contract accommodates but this repository does not ship.
- **Brute-force vector search.** Cosine is computed across the candidate pool.
  That is fine to roughly 10⁴–10⁵ records per namespace; beyond that the pool
  needs an ANN index in front of it.
- **Consolidation is unsupervised.** Clustering can merge two facts that are
  lexically similar but semantically distinct. The superseded-not-deleted
  policy means this is recoverable, but it is not prevented.
- **The hashing embedder is not semantic.** It captures lexical and
  morphological similarity. Genuine paraphrase without shared vocabulary needs
  a real embedding model.
