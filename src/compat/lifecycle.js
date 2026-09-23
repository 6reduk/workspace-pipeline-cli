import {contractDigest} from '../contracts/semantic.js';
import {fail,ContractError,parse} from '../contracts/parse.js';
export const usesClaudeCompatibility=providers=>providers?.includes('claude')&&!providers.includes('grok');
const selected=p=>usesClaudeCompatibility(p?.preview?.plan?.desired?.providers??
  (p?.kind==='prepared-switch'?p.preview?.phases?.find(s=>s.name==='install-new')?.preview?.plan?.desired?.providers:undefined));
export async function bindCompatibility(prepared,service){
  if(!service||!selected(prepared))return prepared;
  const body={kind:'prepared-with-claude-compatibility',workspace:prepared,compatibility:await service.inspect()};
  const result={...body,digest:contractDigest(body)};
  parse(JSON.stringify(result),'json'); // Still readable by the public preview reader.
  return result;
}
export async function unwrapCompatibility(prepared,service){
  if(prepared?.kind!=='prepared-with-claude-compatibility'){
    if(service&&selected(prepared))fail('grok-compat.preview-required');
    return {prepared,compatibility:null};
  }
  if(!service||Object.keys(prepared).sort().join(',')!=='compatibility,digest,kind,workspace'||!selected(prepared.workspace))fail('grok-compat.envelope');
  const {digest,...body}=prepared;if(digest!==contractDigest(body))fail('grok-compat.envelope');
  await service.check(prepared.compatibility);
  return {prepared:prepared.workspace,compatibility:prepared.compatibility};
}
export async function finishCompatibility(result,requirement,service){
  if(!requirement)return result;
  if(result.status!=='ready'||result.lockRelease!=='released'||result.outputError)return {...result,compatibility:{status:'not-applied',reason:'workspace-operation-incomplete'}};
  try{
    const compatibility=await service.apply(requirement);
    if(compatibility.status==='configured'&&service.verify&&result.workspace){
      compatibility.native=await service.verify(result.workspace);
      if(compatibility.native.status==='blocked')return {...result,workspaceStatus:result.status,status:'needs-compatibility',compatibility};
    }
    return {...result,compatibility};
  }
  catch(error){return {...result,workspaceStatus:result.status,status:'needs-compatibility',compatibility:{status:'failed',profile:requirement.profile,error:error instanceof ContractError?error.code:'grok-compat.io',next:'Run repair preview/apply; workspace changes are already committed. Inspect workspace-pipeline-backups and the global lock in this profile before retry after a process crash.'}};}
}
export async function doctorCompatibility(result,service){
  if(!service||!usesClaudeCompatibility(result.pipeline?.providers))return result;
  try{
    const compatibility=await service.inspect();
    if(compatibility.status==='configured'&&service.verify&&result.workspace)compatibility.native=await service.verify(result.workspace);
    const okay=['configured','not-present'].includes(compatibility.status)&&compatibility.native?.status!=='blocked';
    return {...result,compatibility,ready:result.ready&&okay,status:okay?result.status:'needs-compatibility',
      diagnostics:[...result.diagnostics,...okay?[]:[{code:compatibility.native?.status==='blocked'?'grok-compat.native-mismatch':'grok-compat.'+compatibility.status,subject:compatibility.path}]]};
  }catch(error){return {...result,ready:false,status:'needs-compatibility',compatibility:{status:'blocked'},diagnostics:[...result.diagnostics,{code:error instanceof ContractError?error.code:'grok-compat.io',subject:'Grok user profile'}]};}
}
