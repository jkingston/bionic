import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { createCatalogModule } from '../lib/runtime/index.ts';
import { registerModule } from '../lib/pi/modules.ts';
export default function catalog(pi: ExtensionAPI) {
  registerModule(
    pi,
    createCatalogModule(
      ['checkout', 'payments', 'auth'].map((id) => ({
        id,
        description: `Demo ${id} service`,
        data: { environment: 'demo' },
      })),
    ),
  );
}
