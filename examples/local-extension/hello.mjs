import { registerModule } from 'bionic-pi/pi';
import hello from './module.mjs';
export default function extension(pi) {
  registerModule(pi, hello);
}
