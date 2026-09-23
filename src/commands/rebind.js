import {absoluteRoot,resolveChild} from '../workspace/paths.js';
import {fail} from '../contracts/parse.js';
import {contractDigest} from '../contracts/semantic.js';
import {readRecord,readState,previewRebind,resolveApprovedRebind} from '../operations/state.js';
import {assertNoRepositoryPending} from '../operations/repository-pending.js';
import {inspectHistory} from '../operations/history.js';

export function parseRebind(args) {
  const result={command:'rebind'},seen=new Set();
  for(let i=1;i<args.length;i++) {
    const flag=args[i];
    if(!['--workspace','--manifest','--json'].includes(flag) || seen.has(flag))fail('cli.arguments');
    seen.add(flag);
    if(flag==='--json')continue;
    const value=args[++i];if(!value || value.startsWith('--'))fail('cli.arguments');
    result[flag==='--workspace'?'workspace':'manifestPath']=absoluteRoot(value);
  }
  if(!result.workspace || !result.manifestPath)fail('cli.arguments');
  return result;
}

async function current(wrapper) {
  await assertNoRepositoryPending(wrapper);
  const history=await inspectHistory(wrapper);
  if(!history.complete || history.diagnostics.length)fail('lifecycle.history');
  return (await readState(resolveChild(wrapper,'.pipeline/state.json'))).value;
}

// Read manifests and installed history only. Never acquire Git, update state,
// move the supplied manifest, or manufacture source/apply approval here.
export async function runRebind(command,stdout) {
  const previous=await current(command.workspace);
  const proposal=await previewRebind({wrapper:command.workspace,previous,manifestPath:command.manifestPath});
  if(proposal.previousWorkspace!==proposal.workspace)fail('rebind.workspace-move');
  await stdout(JSON.stringify(proposal)+'\n');
  return 0;
}

// Called only for the explicit update --accept-rebind flag. The resulting
// prepared update still needs a separate --apply --preview approval.
export async function acceptedRebind(wrapper,filename) {
  const proposal=(await readRecord(filename)).value;
  if(proposal?.kind!=='rebind-preview' || typeof proposal?.proposed?.origin?.path!=='string')fail('rebind.proposal');
  const manifestPath=absoluteRoot(proposal.proposed.origin.path);
  const previous=await current(wrapper);
  const approval={decision:'approve',proposalDigest:contractDigest(proposal)};
  await resolveApprovedRebind({wrapper,previous,manifestPath,proposal,approval});
  return {manifestPath,rebind:{proposal,approval}};
}
