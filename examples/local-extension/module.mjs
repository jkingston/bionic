export default {
  id: 'example.local',
  capabilities: [
    {
      name: 'local.hello',
      version: 1,
      effect: 'read',
      description: 'Read a greeting from this runtime module.',
      inputSchema: { type: 'object', additionalProperties: false },
      outputSchema: {
        type: 'object',
        properties: { message: { type: 'string' } },
        required: ['message'],
        additionalProperties: false,
      },
    },
  ],
  async invoke() {
    return { message: 'Hello from my runtime module' };
  },
};
