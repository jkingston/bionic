import { registerBionicProvider, createHttpJsonProvider } from 'bionic-pi/providers';

// Run a JSON service locally on port 8090, or configure your deployment's origin.
// Credentials are read by trusted host code after authorization, not by scripts.
export default function platform(pi) {
  registerBionicProvider(
    pi,
    createHttpJsonProvider({
      id: 'example.platform',
      origin: process.env.PLATFORM_ORIGIN ?? 'http://127.0.0.1:8090',
      allowInsecureHttp: !process.env.PLATFORM_ORIGIN,
      headers: () =>
        process.env.PLATFORM_TOKEN ? { Authorization: `Bearer ${process.env.PLATFORM_TOKEN}` } : {},
      operations: [
        {
          capability: {
            name: 'platform.health',
            version: 1,
            effect: 'read',
            description: 'Read service health from the deployment API.',
            inputSchema: {
              type: 'object',
              properties: { service: { type: 'string' } },
              required: ['service'],
              additionalProperties: false,
            },
            outputSchema: {
              type: 'object',
              properties: { status: { type: 'string' } },
              required: ['status'],
              additionalProperties: false,
            },
          },
          path: '/health',
          query: { service: 'service' },
          resource: { argument: 'service', scope: 'services' },
        },
      ],
    }),
  );
}
