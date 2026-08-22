import type { MemoryInput } from './types.js';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/**
 * A plausible slice of one agent's memory, backdated across three weeks.
 *
 * Real timestamps matter here: decay, recency and consolidation only become
 * visible when records actually differ in age, so an empty console would
 * demonstrate nothing. The set is built to make specific behaviours legible —
 * several near-duplicate observations about the same deployment preference
 * that consolidation can collapse, a procedural fix that should outrank the
 * episode that prompted it, and cold working memory that maintenance can
 * reclaim.
 */
export function seedMemories(now = Date.now()): MemoryInput[] {
  return [
    // --- durable facts about the people and the system ---
    {
      content:
        'Ada Okafor leads platform engineering and owns the deploy pipeline. Reach her at ada@northwind.dev.',
      kind: 'semantic',
      source: 'user',
      importance: 0.85,
      tags: ['people', 'ownership'],
      createdAt: now - 20 * DAY,
    },
    {
      content:
        'The production cluster is northwind-prod-eu1, running Kubernetes 1.29 on three availability zones.',
      kind: 'semantic',
      source: 'system',
      importance: 0.8,
      tags: ['infra'],
      createdAt: now - 19 * DAY,
    },
    {
      content:
        'Release windows are Tuesday and Thursday 14:00-16:00 UTC. Friday deploys need written sign-off from Ada.',
      kind: 'semantic',
      source: 'user',
      importance: 0.9,
      tags: ['policy', 'deploy'],
      createdAt: now - 18 * DAY,
    },
    {
      content:
        'The team uses trunk-based development. Feature branches live under 48 hours by convention.',
      kind: 'semantic',
      source: 'user',
      importance: 0.6,
      tags: ['process'],
      createdAt: now - 16 * DAY,
    },
    {
      content:
        'Postgres runs at version 16.2 behind PgBouncer in transaction pooling mode, capped at 400 connections.',
      kind: 'semantic',
      source: 'tool',
      importance: 0.7,
      tags: ['infra', 'database'],
      createdAt: now - 14 * DAY,
    },

    // --- near-duplicates that consolidation should collapse ---
    {
      content: 'Ada asked that migrations always run before the app rollout, never after.',
      kind: 'episodic',
      source: 'user',
      importance: 0.6,
      tags: ['deploy', 'database'],
      createdAt: now - 12 * DAY,
    },
    {
      content: 'Reminder from Ada: database migrations must run ahead of the app rollout.',
      kind: 'episodic',
      source: 'user',
      importance: 0.55,
      tags: ['deploy', 'database'],
      createdAt: now - 9 * DAY,
    },
    {
      content: 'Ada repeated that migrations run before the rollout, not after it.',
      kind: 'episodic',
      source: 'user',
      importance: 0.5,
      tags: ['deploy', 'database'],
      createdAt: now - 6 * DAY,
    },

    // --- procedures: the highest-leverage kind of memory ---
    {
      content:
        'To fix ENOSPC on a CI runner: run `docker system prune -af --volumes`, confirm with `df -h`, then re-run the job. If it recurs twice in a week, the runner disk needs resizing.',
      kind: 'procedural',
      source: 'agent',
      importance: 0.95,
      tags: ['ci', 'runbook'],
      createdAt: now - 11 * DAY,
    },
    {
      content:
        'Rollback procedure: `kubectl rollout undo deployment/api -n prod`, then verify /health returns 200 across all three zones before announcing recovery.',
      kind: 'procedural',
      source: 'agent',
      importance: 0.95,
      tags: ['runbook', 'deploy'],
      createdAt: now - 10 * DAY,
    },
    {
      content:
        'When PgBouncer saturates, do not raise max_connections first. Check for long-running transactions with pg_stat_activity, kill anything idle in transaction over five minutes, then reassess.',
      kind: 'procedural',
      source: 'agent',
      importance: 0.9,
      tags: ['runbook', 'database'],
      createdAt: now - 7 * DAY,
    },
    {
      content:
        'Staging seeds are refreshed with `make seed-staging`. It is destructive and must never be pointed at a production connection string.',
      kind: 'procedural',
      source: 'user',
      importance: 0.8,
      tags: ['runbook', 'staging'],
      createdAt: now - 5 * DAY,
    },

    // --- episodes: what actually happened ---
    {
      content:
        'Build #4821 failed with ENOSPC on runner-4. Disk was at 98% from stale docker layers.',
      kind: 'episodic',
      source: 'tool',
      importance: 0.5,
      tags: ['ci', 'incident'],
      createdAt: now - 11 * DAY - 2 * HOUR,
    },
    {
      content:
        'Incident INC-204: the 14:20 deploy raised p99 latency from 180ms to 2.4s. Rolled back within nine minutes.',
      kind: 'episodic',
      source: 'system',
      importance: 0.75,
      tags: ['incident', 'deploy'],
      createdAt: now - 8 * DAY,
    },
    {
      content:
        'Root cause of INC-204 was a missing index on orders.customer_id after the v2.4.0 migration.',
      kind: 'episodic',
      source: 'user',
      importance: 0.8,
      tags: ['incident', 'database'],
      createdAt: now - 8 * DAY + 3 * HOUR,
    },
    {
      content: 'Deployed api v2.4.1 with the orders index backfilled. p99 returned to 175ms.',
      kind: 'episodic',
      source: 'tool',
      importance: 0.6,
      tags: ['deploy'],
      createdAt: now - 7 * DAY,
    },
    {
      content:
        'Priya flagged that the staging seed job had been pointed at the wrong database for two days.',
      kind: 'episodic',
      source: 'user',
      importance: 0.65,
      tags: ['staging', 'incident'],
      createdAt: now - 4 * DAY,
    },
    {
      content: 'Nightly backup verification passed for the seventh consecutive night.',
      kind: 'episodic',
      source: 'tool',
      importance: 0.2,
      tags: ['backup'],
      createdAt: now - 2 * DAY,
    },
    {
      content:
        'Ada asked for a summary of every ENOSPC failure this month before the Thursday retro.',
      kind: 'episodic',
      source: 'user',
      importance: 0.7,
      tags: ['ci', 'request'],
      createdAt: now - 1 * DAY,
    },
    {
      content: 'Opened PR #612 to raise the CI runner disk from 40GB to 100GB.',
      kind: 'episodic',
      source: 'agent',
      importance: 0.6,
      tags: ['ci'],
      createdAt: now - 6 * HOUR,
    },

    // --- working memory: scoped to the task in flight, decays fast ---
    {
      content: 'Currently drafting the ENOSPC retro summary. Three incidents found so far.',
      kind: 'working',
      source: 'agent',
      importance: 0.5,
      tags: ['task'],
      createdAt: now - 40 * MINUTE,
    },
    {
      content: 'Waiting on Priya to confirm the staging connection string was rotated.',
      kind: 'working',
      source: 'agent',
      importance: 0.45,
      tags: ['task', 'blocked'],
      createdAt: now - 25 * MINUTE,
    },
    {
      content: 'Scratch note: check whether runner-2 shows the same disk growth curve as runner-4.',
      kind: 'working',
      source: 'agent',
      importance: 0.3,
      tags: ['task'],
      createdAt: now - 3 * DAY,
    },
  ];
}
