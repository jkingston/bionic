import { registerBionicProvider } from 'bionic-pi/providers';

export default function hello(pi) {
  registerBionicProvider(pi, {
    protocolVersion: 1,
    id: 'example.local',
    provider: {
      definitions: () => [
        {
          name: 'local.hello',
          version: 1,
          effect: 'read',
          description: 'Read a greeting from the local deployment extension.',
          inputSchema: { type: 'object', additionalProperties: false },
          outputSchema: {
            type: 'object',
            properties: { message: { type: 'string' } },
            required: ['message'],
            additionalProperties: false,
          },
        },
      ],
      // No resource selector. Bionic still checks the local.hello capability grant.
      authorize() {},
      async invoke() {
        return { message: 'Hello from my local extension' };
      },
    },
  });
}
