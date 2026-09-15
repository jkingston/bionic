import { registerModule } from 'bionic-pi/pi';
import platform from './platform-module.mjs';
export default function extension(pi) {
  registerModule(pi, platform);
}
