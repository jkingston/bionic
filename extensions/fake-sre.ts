import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { createFakeSreModule } from '../lib/runtime/index.ts';
import { registerModule } from '../lib/pi/modules.ts';
export default function extension(pi: ExtensionAPI) {
  registerModule(pi, createFakeSreModule());
}
