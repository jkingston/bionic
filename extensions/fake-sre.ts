import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { registerBionicProvider } from '../lib/providers/index.ts';
import { FakeSreHost } from '../lib/adapters/fake-sre.ts';
export default function sre(pi: ExtensionAPI) {
  registerBionicProvider(pi, {
    protocolVersion: 1,
    id: 'bionic.fake-sre',
    provider: new FakeSreHost(),
  });
}
