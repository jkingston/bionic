import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { registerBionicProvider, createCatalogProvider } from '../lib/providers/index.ts';
export default function catalog(pi: ExtensionAPI) {
  registerBionicProvider(
    pi,
    createCatalogProvider(
      ['checkout', 'payments', 'auth'].map((id) => ({
        id,
        description: `Demo ${id} service`,
        data: { environment: 'demo' },
      })),
    ),
  );
}
