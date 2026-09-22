import { codexAdapter, claudeAdapter } from './native.js';
import { sharedAdapter } from './shared.js';
import { kimiAdapter } from './kimi.js';
import { grokAdapter } from './grok.js';

// Compiled CLI code only. No registry/module names may be supplied by a package.
export const providerRegistry = Object.freeze({
  adapters: Object.freeze({ codex: codexAdapter, claude: claudeAdapter, kimi: kimiAdapter, grok: grokAdapter }),
  sharedAdapter
});
