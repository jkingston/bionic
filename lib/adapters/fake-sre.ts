import {
  BionicError,
  type Capability,
  type CapabilityProvider,
  type Grant,
  type Json,
} from '../contracts.ts';
const str = { type: 'string', minLength: 1, maxLength: 100 };
const obj = (properties: Record<string, unknown>, required = Object.keys(properties)) => ({
  type: 'object',
  properties,
  required,
  additionalProperties: false,
});
const services: Record<string, Json> = {
  checkout: {
    name: 'checkout',
    status: 'degraded',
    latency_ms: 2400,
    error_rate: 0.18,
    version: 'v43',
    region: 'eu-west-1',
  },
  payments: {
    name: 'payments',
    status: 'healthy',
    latency_ms: 120,
    error_rate: 0.001,
    version: 'v12',
    region: 'us-east-1',
  },
  auth: {
    name: 'auth',
    status: 'healthy',
    latency_ms: 90,
    error_rate: 0.002,
    version: 'v7',
    region: 'us-east-1',
  },
};
const definitions: Capability[] = [
  {
    name: 'service.get',
    description: 'Get deterministic fake service health.',
    inputSchema: obj({ name: str }),
    outputSchema: obj({
      name: str,
      status: str,
      latency_ms: { type: 'number' },
      error_rate: { type: 'number' },
      version: str,
      region: str,
    }),
  },
  {
    name: 'service.dependencies',
    description: 'Get fake upstream dependencies.',
    inputSchema: obj({ name: str }),
    outputSchema: obj({ dependencies: { type: 'array', items: str } }),
  },
  {
    name: 'metrics.query',
    description: 'Get fake metric samples.',
    inputSchema: obj({ service: str, metric: { enum: ['latency_p99', 'error_rate'] } }),
    outputSchema: obj({
      service: str,
      metric: str,
      data_points: { type: 'array', items: obj({ ts: str, value: { type: 'number' } }) },
    }),
  },
  {
    name: 'logs.search',
    description: 'Find fake service logs by substring.',
    inputSchema: obj({ service: str, query: { type: 'string', maxLength: 500 } }),
    outputSchema: obj({ entries: { type: 'array', items: obj({ message: str }) } }),
  },
  {
    name: 'deployments.list',
    description: 'Get fake deployment history.',
    inputSchema: obj({ service: str }),
    outputSchema: obj({
      deployments: { type: 'array', items: obj({ version: str, status: str }) },
    }),
  },
].map((d) => ({ ...d, version: 1, effect: 'read' }));
export class FakeSreHost implements CapabilityProvider {
  definitions() {
    return structuredClone(definitions);
  }
  authorize(_name: string, args: Json, grant: Grant) {
    const a = args as Record<string, string>;
    if (!grant.services.includes(a.name ?? a.service)) {
      throw new BionicError('permission_required', 'Service not granted');
    }
  }
  async invoke(name: string, args: Json): Promise<Json> {
    const a = args as Record<string, string>;
    const service = a.name ?? a.service;
    const s = services[service] as Record<string, Json>;
    if (!s) {
      throw new BionicError('not_found', 'Unknown fake service');
    }
    switch (name) {
      case 'service.get':
        return structuredClone(s);
      case 'service.dependencies':
        return { dependencies: service === 'checkout' ? ['payments', 'auth'] : [] };
      case 'metrics.query':
        return {
          service,
          metric: a.metric,
          data_points: [
            {
              ts: '2024-01-14T15:00:00Z',
              value: s[a.metric === 'latency_p99' ? 'latency_ms' : 'error_rate'],
            },
          ],
        };
      case 'logs.search':
        return {
          entries: (service === 'checkout'
            ? ['upstream timeout: payments', 'upstream timeout: auth', 'deployment v43 activated']
            : ['heartbeat ok']
          )
            .filter((x) => x.includes(a.query))
            .map((message) => ({ message })),
        };
      case 'deployments.list':
        return {
          deployments:
            service === 'checkout'
              ? [
                  { version: 'v42', status: 'rolled_back' },
                  { version: 'v43', status: 'active' },
                ]
              : [{ version: s.version, status: 'active' }],
        };
      default:
        throw new BionicError('forbidden', 'Capability unavailable');
    }
  }
}
