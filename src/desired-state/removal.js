import {fail} from '../contracts/parse.js';
import {contractDigest} from '../contracts/semantic.js';
import {observeTargets} from '../operations/state.js';
import {utf8} from '../source/inventory.js';
import {parseDesiredWorkspace} from './source.js';
import {includeRetiredTargets} from './retirement.js';

// Offline full-delivery removal. Historical ownership never grants deletion of
// repositories. User-wide compatibility remains shared, not workspace-owned.
export async function prepareDesiredRemoval(workspace,records,protectedPaths=[]) {
  if(records.pending && records.pending.value.intent!=='remove')fail('desired.finish-install-before-remove');
  const previous=(records.pending??records.installed)?.value;
  if(!previous)fail('desired.not-installed');
  if(previous.intent==='removed')return {alreadyRemoved:true};
  if(!previous.binding)fail('desired.removal-binding-required');
  const protectedRoots=new Set(protectedPaths);
  for(const repo of Object.values(previous.binding.layout.repositories))protectedRoots.add(repo.path);
  const [entry]=await observeTargets(workspace,['workspace.json']);
  if(entry.bytes!==null) {
    const descriptor=parseDesiredWorkspace(utf8(entry.bytes));
    for(const repo of Object.values(descriptor.layout.repositories))protectedRoots.add(repo.path);
  }
  const desired={scopes:[],entries:[]};
  const retired=includeRetiredTargets(previous,{settings:[]},desired,[...protectedRoots]);
  const settings=records.pending?previous.settings.map(s=>({target:s.target,pointer:s.pointer,operation:'remove'})):
    retired.settings.filter(s=>s.target!=='grok.user');
  const next=records.pending?.value??{...previous,intent:'remove',files:[],
    settings:settings.map(s=>({...s,valueHash:null})),
    operationHash:contractDigest({intent:'remove',previous,preserveGlobalSettings:true})};
  return {alreadyRemoved:false,next,desired:retired.desired,settings,
    protectedPaths:[...protectedRoots]};
}
