import {parseTOML, getStaticTOMLValue} from 'toml-eslint-parser';
import {isDeepStrictEqual} from 'node:util';
import {fail, MAX_INPUT_BYTES} from '../contracts/parse.js';
import {utf8} from '../source/inventory.js';
import {reconcileFields,requestShape} from './ownership.js';

export const AGENT_CONTROL_KEYS=Object.freeze(['enabled','max_threads','max_depth','max_concurrent_threads_per_session',
  'default_subagent_model','default_subagent_reasoning_effort','job_max_runtime_seconds','interrupt_message']);

// Only complete named Codex agent/MCP entries. No model, permission, auth or
// trust setting may be addressed through this editor. No I/O or authorization.
function parts(pointer) {
  if(typeof pointer!=='string' || !/^\/(agents|mcp_servers)\/[a-z][a-z0-9_-]{0,99}$/.test(pointer))fail('toml.scope');
  const result=pointer.slice(1).split('/');
  if(['__proto__','prototype','constructor'].includes(result[1]))fail('toml.scope');
  if(result[0]==='agents' && AGENT_CONTROL_KEYS.includes(result[1]))fail('toml.scope');
  return result;
}
const prefix=(a,b)=>a.length<=b.length && a.every((x,i)=>x===b[i]);
const keys=key=>key.keys.map(k=>k.type==='TOMLBare'?k.name:k.value);

function document(bytes) {
  if(bytes!==null && !Buffer.isBuffer(bytes))fail('toml.input');
  if(bytes!==null && bytes.length>MAX_INPUT_BYTES)fail('toml.size');
  const text=bytes===null?'':utf8(bytes);
  let ast;try{ast=parseTOML(text,{tomlVersion:'1.0'});}catch{fail('toml.syntax');}
  let count=0;
  function inspect(node,depth=0) {
    if(++count>50000 || depth>64)fail('toml.complexity');
    if(node.type==='TOMLKey' && keys(node).some(k=>['__proto__','prototype','constructor'].includes(k)))fail('toml.key');
    // Deliberately omit parent/tokens/comments, which contain cycles or duplicate nodes.
    for(const key of ['body','key','value','elements','keys']) {
      const value=node[key];
      for(const child of Array.isArray(value)?value:[value])if(child && typeof child==='object' && typeof child.type==='string')inspect(child,depth+1);
    }
  }
  inspect(ast);
  let value;try{value=getStaticTOMLValue(ast);}catch{fail('toml.syntax');}
  return {text,ast,value};
}

function selected(value,pointer) {
  const [root,name]=parts(pointer);
  if(!Object.hasOwn(value,root))return {present:false};
  const parent=value[root];
  if(parent===null || typeof parent!=='object' || Array.isArray(parent) || parent instanceof Date)fail('toml.ancestor');
  if(!Object.hasOwn(parent,name))return {present:false};
  const entry=parent[name];
  if(entry===null || typeof entry!=='object' || Array.isArray(entry) || entry instanceof Date)fail('toml.entry');
  // Reuse the JSON-domain validator without admitting dates/NaN/unsafe integers
  // into owned hashes. Foreign TOML values are never serialized or normalized.
  const checked=reconcileFields({},[{pointer,present:true,value:entry}]);
  return {present:true,value:checked.value[root][name]};
}

export function readTOMLField(bytes,pointer) {
  return selected(document(bytes).value,pointer);
}

function literal(value) {
  if(typeof value==='string')return JSON.stringify(value).replace(/\u007f/g,'\\u007f');
  if(typeof value==='boolean' || (typeof value==='number' && Number.isFinite(value) && (!Number.isInteger(value)||Number.isSafeInteger(value))))return String(value);
  if(Array.isArray(value))return '['+value.map(literal).join(', ')+']';
  if(value && typeof value==='object')return '{ '+Object.keys(value).sort().map(k=>JSON.stringify(k)+' = '+literal(value[k])).join(', ')+' }';
  fail('toml.value'); // TOML has no null; no coercion to string/empty value.
}

// Select source spans by parsed semantic keys, never regex matching source text.
// Inline ancestor tables cannot be split without editing foreign bytes: refuse.
function deletionRanges(ast,target) {
  const ranges=[];
  const visitPair=(node,base)=>{
    const key=[...base,...keys(node.key)];
    if(prefix(target,key))ranges.push(node.range);
    else if(prefix(key,target))fail('toml.inline-ancestor');
  };
  for(const node of ast.body[0].body) {
    if(node.type==='TOMLKeyValue')visitPair(node,[]);
    else if(node.type==='TOMLTable') {
      const key=node.resolvedKey;
      if(key.some(k=>typeof k!=='string') && prefix(key.filter(k=>typeof k==='string'),target))fail('toml.array-ancestor');
      if(prefix(target,key)) {
        if(node.kind!=='standard')fail('toml.array-ancestor');
        const end=ast.tokens.find(t=>t.range[0]>=node.key.range[1] && t.value===']');
        if(!end)fail('toml.syntax');
        ranges.push([node.range[0],end.range[1]]);
        for(const pair of node.body)ranges.push(pair.range);
      }else for(const pair of node.body)visitPair(pair,key);
    }
  }
  return ranges;
}

function normalizeEmptyRoots(value) {
  for(const root of ['agents','mcp_servers'])if(value[root] && !Array.isArray(value[root]) && Object.keys(value[root]).length===0)delete value[root];
  return value;
}

// Reset-only editor: never widen the ordinary ownership editor's pointer scope.
// Keep agent runtime/model controls; clear named definitions and MCP declarations.
export function clearResetTOMLSections(bytes,roots) {
  if(!Array.isArray(roots) || roots.some(r=>!['agents','mcp_servers'].includes(r)))fail('toml.scope');
  if(bytes===null)return null;
  const before=document(bytes),expected=structuredClone(before.value),ranges=[];
  for(const root of roots){
    if(!Object.hasOwn(before.value,root))continue;
    if(root==='agents'){
      const entries=before.value[root];
      if(!entries || typeof entries!=='object' || Array.isArray(entries) || entries instanceof Date)fail('toml.ancestor');
      for(const name of Object.keys(entries).filter(n=>!AGENT_CONTROL_KEYS.includes(n))){
        // Unknown non-table settings are not named agent definitions. Preserve
        // their original bytes rather than guessing future harness controls.
        const entry=entries[name];
        if(!entry || typeof entry!=='object' || Array.isArray(entry) || entry instanceof Date)continue;
        ranges.push(...deletionRanges(before.ast,[root,name]));delete expected[root][name];
      }
    }else{ranges.push(...deletionRanges(before.ast,[root]));delete expected[root];}
  }
  let result=before.text;
  const ordered=ranges.map(([s,e])=>[s,e+(before.text.startsWith('\r\n',e)?2:before.text[e]==='\n'?1:0)]).sort((a,b)=>b[0]-a[0]);
  for(let i=0;i<ordered.length;i++){
    const [s,e]=ordered[i];if(i && e>ordered[i-1][0])fail('toml.overlap');
    result=result.slice(0,s)+result.slice(e);
  }
  const output=Buffer.from(result);
  if(!isDeepStrictEqual(normalizeEmptyRoots(document(output).value),normalizeEmptyRoots(expected)))fail('toml.postcondition');
  return output;
}

export function reconcileTOMLFields(bytes,requests) {
  const before=document(bytes),projected=Object.create(null);
  if(!Array.isArray(requests) || !requests.length || requests.length>1000)fail('toml.requests');
  for(const request of requests) {
    requestShape(request,['pointer','present'],['value','managedHash','takeover'],'toml.requests');
    const [root,name]=parts(request?.pointer),found=selected(before.value,request.pointer);
    if(found.present){projected[root]??=Object.create(null);projected[root][name]=found.value;}
  }
  const reconciled=reconcileFields(projected,requests),ranges=[],additions=[],expected=structuredClone(before.value);
  const newline=before.text.includes('\r\n')?'\r\n':'\n';
  for(const decision of reconciled.decisions) {
    if(decision.action==='preserve')continue;
    const target=parts(decision.pointer),[root,name]=target;
    ranges.push(...deletionRanges(before.ast,target));
    const found=selected(reconciled.value,decision.pointer);
    if(found.present) {
      expected[root]??={};expected[root][name]=JSON.parse(JSON.stringify(found.value));
      additions.push('['+target.map(k=>JSON.stringify(k)).join('.')+']'+newline+
        Object.keys(found.value).sort().map(k=>JSON.stringify(k)+' = '+literal(found.value[k])+newline).join(''));
    }else if(expected[root])delete expected[root][name];
  }
  let result=before.text;
  // Consume only the immediate line ending of an owned statement. Never trim
  // whitespace/comments or blank lines outside its AST range.
  const ordered=ranges.map(([start,end])=>[start,end+(before.text.startsWith('\r\n',end)?2:before.text[end]==='\n'?1:0)]).sort((a,b)=>b[0]-a[0]);
  for(let i=0;i<ordered.length;i++) {
    const [start,end]=ordered[i];
    if(i && end>ordered[i-1][0])fail('toml.overlap');
    result=result.slice(0,start)+result.slice(end);
  }
  if(additions.length)result+=(result && !result.endsWith('\n')?newline:'')+additions.join('');
  const output=Buffer.from(result),after=document(output);
  // Compare full semantics, including foreign Date/NaN/Infinity values. Only
  // empty implicit root tables may disappear after their last owned child.
  if(!isDeepStrictEqual(normalizeEmptyRoots(after.value),normalizeEmptyRoots(expected)))fail('toml.postcondition');
  return {bytes:output,decisions:reconciled.decisions};
}
