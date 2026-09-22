// Canonicalize the CI-only scratch location; never relax production path guards.
import {realpath,mkdtemp,appendFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {inspectDirectory} from '../src/workspace/paths.js';
if(process.env.GITHUB_ACTIONS!=='true'||!process.env.GITHUB_ENV)throw Error('GitHub Actions only');
const original=tmpdir(),canonical=await realpath(original);
const scratch=await mkdtemp(path.join(canonical,'wpc-ci-'));
await inspectDirectory(scratch);
if(/[\r\n]/.test(scratch))throw Error('Unsafe CI scratch');
await appendFile(process.env.GITHUB_ENV,`TMP=${scratch}\nTEMP=${scratch}\nTMPDIR=${scratch}\n`);
console.log(JSON.stringify({original,canonical,scratch}));
