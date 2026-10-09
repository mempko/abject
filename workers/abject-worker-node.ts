/**
 * Worker thread entry for the desktop edition's Abject worker pool: every
 * constructor, the UI ones included.
 */

import { coreConstructors } from './core-constructors.js';
import { addUiConstructors } from './ui-constructors.js';
import { runAbjectWorker } from './worker-runtime.js';

runAbjectWorker(addUiConstructors(coreConstructors()));
