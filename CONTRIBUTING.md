# Contributing

## Setup

```bash
npm install
npm run build:core   # everything downstream resolves @mnemos/core from dist
npm test
```

## Before opening a pull request

```bash
npm run typecheck    # strict, all three packages
npm test             # the full suite
npm run build        # core, server and dashboard
```

CI runs the same three, then builds the container image and smoke-tests the
running service end to end.

## Conventions

- **TypeScript is strict**, including `noUncheckedIndexedAccess`. Do not
  loosen it locally to get something past the compiler.
- **Comments explain why, not what.** The code says what it does; a comment
  earns its place by explaining a tradeoff, a non-obvious constraint, or a
  decision a reader would otherwise want to reverse.
- **Commits follow Conventional Commits** (`feat:`, `fix:`, `refactor:`,
  `test:`, `docs:`, `build:`, `chore:`), scoped by package where it helps.

## Adding a store backend

Implement `MemoryStore` from `packages/core/src/store/types.ts`, then add it to
the shared conformance suite in `packages/core/test/store.test.ts`:

```ts
behavesLikeAStore('YourStore', async () => new YourStore({ … }));
```

That suite is the contract. Use `matchesFilter` and `applyQueryOptions` for
anything your backend cannot express natively — filtering semantics must be
identical across backends, and the suite exists to enforce that rather than
trust it.

## Adding an embedding provider

Implement `EmbeddingProvider`: a stable `id`, a fixed `dimensions`, and a
batched `embed` whose output aligns index-for-index with its input. Providers
that reach the network should batch, bound their timeout, and retry only
idempotent failures.

## Tests

Vitest, in `packages/core/test`. Test observable behaviour rather than
internals, and prefer a test that would catch a real regression over one that
merely raises the coverage number. When fixing a bug, add the test that would
have caught it.
