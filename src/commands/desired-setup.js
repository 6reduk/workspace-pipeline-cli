import path from 'node:path';
import {fail} from '../contracts/parse.js';
import {parseDesiredWorkspace} from '../desired-state/source.js';

const valued=new Set(['--workspace','--source','--ref','--subdirectory','--adapters','--repository','--documentation']);
const switches=new Set(['--yes','--backup','--json','--preview']);
export function desiredArguments(args) {
  const values=new Map(),seen=new Set(),repositories=[];
  for(let i=1;i<args.length;i++) {
    const flag=args[i];
    if(!valued.has(flag)&&!switches.has(flag))fail('cli.arguments');
    if(seen.has(flag)&&flag!=='--repository')fail('cli.arguments');
    seen.add(flag);
    if(valued.has(flag)) {
      const value=args[++i];if(!value||value.startsWith('--'))fail('cli.arguments');
      if(flag==='--repository')repositories.push(value);else values.set(flag,value);
    }
  }
  return {values,seen,repositories};
}

// User argv only; source manifests cannot execute code or choose arbitrary homes.
export function initialDescriptor(workspace,parsed,{cwd=process.cwd()}={}) {
  const {values,repositories}=parsed,source=values.get('--source');
  if(!source||!values.has('--adapters'))fail('desired.setup-source-and-adapters-required');
  const pipeline={type:'git',ref:values.get('--ref')??'HEAD',subdirectory:values.get('--subdirectory')??'.'};
  if(/^(https|ssh):\/\//.test(source))Object.assign(pipeline,{transport:'remote',url:source});
  else {
    if(source.includes('://'))fail('source.url');
    const relative=path.relative(workspace,path.resolve(cwd,source));
    if(path.isAbsolute(relative))fail('desired.local-source-different-volume');
    Object.assign(pipeline,{transport:'local',path:relative.split(path.sep).join('/')||'.'});
  }
  function pair(value) {
    const at=value.indexOf('=');
    if(at<1||at===value.length-1)fail('desired.layout-argument');
    return [value.slice(0,at),value.slice(at+1)];
  }
  const entries=(repositories.length?repositories:['game=project']).map(pair);
  if(new Set(entries.map(([id])=>id)).size!==entries.length)fail('desired.layout-argument');
  const repos=Object.fromEntries(entries.map(([id,p])=>[id,{path:p,role:'code'}]));
  if(entries.length>1&&!values.has('--documentation'))fail('desired.documentation-required');
  const [repository,docPath]=pair(values.get('--documentation')??entries[0][0]+'=docs');
  const descriptor={schemaVersion:2,pipeline,adapters:values.get('--adapters').split(','),
    layout:{kind:entries.length===1?'single-repo':'multi-repo',repositories:repos,documentation:{repository,path:docPath}}};
  return parseDesiredWorkspace(JSON.stringify(descriptor));
}
