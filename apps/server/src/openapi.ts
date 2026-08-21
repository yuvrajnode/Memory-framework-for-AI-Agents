/** Hand-written OpenAPI document, served at /openapi.json. */
export const openapiDocument = {
  openapi: '3.0.3',
  info: {
    title: 'Mnemos API',
    version: '0.1.0',
    description:
      'Memory for AI agents: write memories, recall them with hybrid ranking, and ' +
      'assemble a token-budgeted context block.',
    license: { name: 'MIT' },
  },
  servers: [{ url: '/', description: 'This server' }],
  tags: [
    { name: 'memories', description: 'Reading and writing memories' },
    { name: 'recall', description: 'Ranked retrieval and context assembly' },
    { name: 'admin', description: 'Namespace statistics and maintenance' },
  ],
  components: {
    securitySchemes: {
      apiKey: { type: 'apiKey', in: 'header', name: 'x-api-key' },
    },
    schemas: {
      Memory: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          namespace: { type: 'string' },
          kind: { type: 'string', enum: ['episodic', 'semantic', 'procedural', 'working'] },
          source: { type: 'string', enum: ['user', 'agent', 'tool', 'system', 'import'] },
          content: { type: 'string' },
          tags: { type: 'array', items: { type: 'string' } },
          metadata: { type: 'object', additionalProperties: true },
          importance: { type: 'number', minimum: 0, maximum: 1 },
          retention: { type: 'number', minimum: 0, maximum: 1 },
          createdAt: { type: 'integer', format: 'int64' },
          lastAccessedAt: { type: 'integer', format: 'int64' },
          accessCount: { type: 'integer' },
        },
      },
      MemoryInput: {
        type: 'object',
        required: ['content'],
        properties: {
          content: { type: 'string', maxLength: 20000 },
          kind: { type: 'string', enum: ['episodic', 'semantic', 'procedural', 'working'] },
          source: { type: 'string', enum: ['user', 'agent', 'tool', 'system', 'import'] },
          namespace: { type: 'string' },
          agentId: { type: 'string' },
          tags: { type: 'array', items: { type: 'string' } },
          metadata: { type: 'object', additionalProperties: true },
          importance: { type: 'number', minimum: 0, maximum: 1 },
          ttlMs: { type: 'integer', minimum: 1 },
        },
      },
      ScoreBreakdown: {
        type: 'object',
        properties: {
          semantic: { type: 'number' },
          lexical: { type: 'number' },
          recency: { type: 'number' },
          importance: { type: 'number' },
          usage: { type: 'number' },
          retention: { type: 'number' },
        },
      },
      Error: {
        type: 'object',
        properties: {
          error: { type: 'string' },
          code: { type: 'string' },
          message: { type: 'string' },
        },
      },
    },
  },
  paths: {
    '/health': {
      get: {
        tags: ['admin'],
        summary: 'Liveness probe. Never touches the store.',
        responses: { '200': { description: 'Process is up' } },
      },
    },
    '/ready': {
      get: {
        tags: ['admin'],
        summary: 'Readiness probe. Exercises the store.',
        responses: {
          '200': { description: 'Ready to serve' },
          '503': { description: 'Store unreachable' },
        },
      },
    },
    '/v1/memories': {
      post: {
        tags: ['memories'],
        summary: 'Write one memory, or a batch via { memories: [...] }',
        requestBody: {
          required: true,
          content: {
            'application/json': { schema: { $ref: '#/components/schemas/MemoryInput' } },
          },
        },
        responses: {
          '201': { description: 'Memory created' },
          '200': { description: 'Merged into an existing memory' },
          '400': {
            description: 'Invalid payload',
            content: {
              'application/json': { schema: { $ref: '#/components/schemas/Error' } },
            },
          },
        },
      },
      get: {
        tags: ['memories'],
        summary: 'Browse memories. Pass ?search= to rank instead of list.',
        parameters: [
          { name: 'namespace', in: 'query', schema: { type: 'string' } },
          { name: 'kind', in: 'query', schema: { type: 'string' }, description: 'Comma separated' },
          { name: 'tags', in: 'query', schema: { type: 'string' }, description: 'All must match' },
          { name: 'search', in: 'query', schema: { type: 'string' } },
          { name: 'limit', in: 'query', schema: { type: 'integer', maximum: 500 } },
          { name: 'offset', in: 'query', schema: { type: 'integer' } },
          { name: 'orderBy', in: 'query', schema: { type: 'string' } },
        ],
        responses: { '200': { description: 'A page of memories' } },
      },
      delete: {
        tags: ['admin'],
        summary: 'Clear a namespace. Requires ?confirm=true.',
        parameters: [
          { name: 'namespace', in: 'query', schema: { type: 'string' } },
          { name: 'confirm', in: 'query', required: true, schema: { type: 'string' } },
        ],
        responses: { '200': { description: 'Namespace cleared' } },
      },
    },
    '/v1/memories/{id}': {
      get: {
        tags: ['memories'],
        summary: 'Fetch one memory',
        parameters: [
          { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'namespace', in: 'query', schema: { type: 'string' } },
          { name: 'includeEmbeddings', in: 'query', schema: { type: 'boolean' } },
        ],
        responses: { '200': { description: 'The memory' }, '404': { description: 'Not found' } },
      },
      patch: {
        tags: ['memories'],
        summary: 'Update content, importance, tags or kind. Content changes re-embed.',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        responses: { '200': { description: 'Updated' }, '404': { description: 'Not found' } },
      },
      delete: {
        tags: ['memories'],
        summary: 'Forget a memory',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        responses: { '204': { description: 'Deleted' }, '404': { description: 'Not found' } },
      },
    },
    '/v1/recall': {
      post: {
        tags: ['recall'],
        summary: 'Hybrid ranked retrieval with a per-signal score breakdown',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['query'],
                properties: {
                  query: { type: 'string' },
                  namespace: { type: 'string' },
                  limit: { type: 'integer', minimum: 1, maximum: 500 },
                  diversity: { type: 'number', minimum: 0, maximum: 1 },
                  minScore: { type: 'number', minimum: 0, maximum: 1 },
                  weights: { type: 'object', additionalProperties: { type: 'number' } },
                  filter: { type: 'object', additionalProperties: true },
                },
              },
            },
          },
        },
        responses: { '200': { description: 'Ranked results' } },
      },
    },
    '/v1/context': {
      post: {
        tags: ['recall'],
        summary: 'Recall and pack into a token-budgeted prompt block',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['query'],
                properties: {
                  query: { type: 'string' },
                  budgetTokens: { type: 'integer', minimum: 1 },
                  namespace: { type: 'string' },
                },
              },
            },
          },
        },
        responses: { '200': { description: 'Assembled context block' } },
      },
    },
    '/v1/stats': {
      get: {
        tags: ['admin'],
        summary: 'Aggregate counters for a namespace',
        parameters: [{ name: 'namespace', in: 'query', schema: { type: 'string' } }],
        responses: { '200': { description: 'Statistics' } },
      },
    },
    '/v1/namespaces': {
      get: {
        tags: ['admin'],
        summary: 'List namespaces with record counts',
        responses: { '200': { description: 'Namespaces' } },
      },
    },
    '/v1/graph': {
      get: {
        tags: ['admin'],
        summary: 'Associative graph snapshot for visualisation',
        parameters: [
          { name: 'namespace', in: 'query', schema: { type: 'string' } },
          { name: 'limit', in: 'query', schema: { type: 'integer', maximum: 500 } },
        ],
        responses: { '200': { description: 'Nodes and edges' } },
      },
    },
    '/v1/consolidate': {
      post: {
        tags: ['admin'],
        summary: 'Distil clusters of related episodes into semantic facts',
        responses: { '200': { description: 'Consolidation summary' } },
      },
    },
    '/v1/maintenance': {
      post: {
        tags: ['admin'],
        summary: 'Expire, evict and prune. Supports dryRun.',
        responses: { '200': { description: 'Maintenance report' } },
      },
    },
  },
} as const;
