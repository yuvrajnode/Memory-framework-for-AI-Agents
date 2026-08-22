import type { MemoryInput } from '../../src/types.js';

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

/**
 * A labelled corpus used by the retrieval quality tests.
 *
 * Each memory carries a stable `metadata.ref` so a query can name the record
 * it should retrieve without depending on generated ids or array order.
 */
export function evalCorpus(now = Date.now()): MemoryInput[] {
  return [
    {
      content:
        'To fix ENOSPC on a CI runner: run `docker system prune -af --volumes`, confirm with `df -h`, then re-run the job.',
      kind: 'procedural',
      importance: 0.95,
      tags: ['ci', 'runbook'],
      metadata: { ref: 'runbook-enospc' },
      createdAt: now - 11 * DAY,
    },
    {
      content:
        'Rollback procedure: `kubectl rollout undo deployment/api -n prod`, then verify /health returns 200 across all zones.',
      kind: 'procedural',
      importance: 0.95,
      tags: ['runbook'],
      metadata: { ref: 'runbook-rollback' },
      createdAt: now - 10 * DAY,
    },
    {
      content:
        'When PgBouncer saturates, do not raise max_connections. Check pg_stat_activity for long-running transactions first.',
      kind: 'procedural',
      importance: 0.9,
      tags: ['runbook', 'database'],
      metadata: { ref: 'runbook-pgbouncer' },
      createdAt: now - 7 * DAY,
    },
    {
      content:
        'Release windows are Tuesday and Thursday 14:00-16:00 UTC. Friday deploys need written sign-off from Ada.',
      kind: 'semantic',
      importance: 0.9,
      tags: ['policy'],
      metadata: { ref: 'policy-windows' },
      createdAt: now - 18 * DAY,
    },
    {
      content: 'Ada Okafor leads platform engineering and owns the deploy pipeline.',
      kind: 'semantic',
      importance: 0.85,
      tags: ['people'],
      metadata: { ref: 'people-ada' },
      createdAt: now - 20 * DAY,
    },
    {
      content:
        'Postgres runs at version 16.2 behind PgBouncer in transaction pooling mode, capped at 400 connections.',
      kind: 'semantic',
      importance: 0.7,
      tags: ['infra', 'database'],
      metadata: { ref: 'infra-postgres' },
      createdAt: now - 14 * DAY,
    },
    {
      content: 'Build #4821 failed with ENOSPC on runner-4. Disk was at 98% from stale docker layers.',
      kind: 'episodic',
      importance: 0.5,
      tags: ['ci'],
      metadata: { ref: 'event-build-4821' },
      createdAt: now - 11 * DAY,
    },
    {
      content:
        'Incident INC-204: the 14:20 deploy raised p99 latency from 180ms to 2.4s. Rolled back within nine minutes.',
      kind: 'episodic',
      importance: 0.75,
      tags: ['incident'],
      metadata: { ref: 'event-inc-204' },
      createdAt: now - 8 * DAY,
    },
    {
      content:
        'Root cause of INC-204 was a missing index on orders.customer_id after the v2.4.0 migration.',
      kind: 'episodic',
      importance: 0.8,
      tags: ['incident'],
      metadata: { ref: 'event-inc-204-cause' },
      createdAt: now - 8 * DAY + 3 * HOUR,
    },
    {
      content: 'Nightly backup verification passed for the seventh consecutive night.',
      kind: 'episodic',
      importance: 0.2,
      tags: ['backup'],
      metadata: { ref: 'event-backup' },
      createdAt: now - 2 * DAY,
    },
    {
      content: 'Waiting on Priya to confirm the staging connection string was rotated.',
      kind: 'working',
      importance: 0.45,
      tags: ['task'],
      metadata: { ref: 'task-priya' },
      createdAt: now - 25 * 60 * 1000,
    },
    {
      content: 'Currently drafting the ENOSPC retro summary. Three incidents found so far.',
      kind: 'working',
      importance: 0.5,
      tags: ['task'],
      metadata: { ref: 'task-retro' },
      createdAt: now - 40 * 60 * 1000,
    },
  ];
}

/** Query → the `ref` a correct system should rank first. */
export const EVAL_QUERIES: { query: string; expected: string }[] = [
  { query: 'how do I fix a runner that ran out of disk?', expected: 'runbook-enospc' },
  { query: 'how do I undo a bad release?', expected: 'runbook-rollback' },
  { query: 'connection pool is saturated', expected: 'runbook-pgbouncer' },
  { query: 'when are we allowed to deploy?', expected: 'policy-windows' },
  { query: 'who owns the deploy pipeline?', expected: 'people-ada' },
  { query: 'what caused the latency incident?', expected: 'event-inc-204-cause' },
  { query: 'INC-204', expected: 'event-inc-204' },
  { query: 'runner-4', expected: 'event-build-4821' },
  { query: 'what am I blocked on right now?', expected: 'task-priya' },
  { query: 'what postgres version do we run?', expected: 'infra-postgres' },
  { query: 'orders.customer_id', expected: 'event-inc-204-cause' },
  { query: 'nightly backups', expected: 'event-backup' },
];
