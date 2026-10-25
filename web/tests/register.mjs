// SPDX-License-Identifier: GPL-2.0-only
// Lets Node run the UI's TypeScript modules directly (its type stripping), resolving the
// extension-less imports Vite allows: `npm test`.
import { register } from 'node:module';

register('./resolve-ts.mjs', import.meta.url);
