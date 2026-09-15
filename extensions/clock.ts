import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { registerBionicProvider, createClockProvider } from '../lib/providers/index.ts';
export default function clock(pi: ExtensionAPI) {
  registerBionicProvider(pi, createClockProvider());
}
