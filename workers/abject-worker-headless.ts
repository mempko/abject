/**
 * Worker thread entry for the headless edition's Abject worker pool: the
 * constructors that need no display, and nothing that draws.
 */

import { coreConstructors } from './core-constructors.js';
import { runAbjectWorker } from './worker-runtime.js';

runAbjectWorker(coreConstructors());
