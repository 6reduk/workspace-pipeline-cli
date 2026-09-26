import {isDeepStrictEqual} from 'node:util';
import {parseTOML,getStaticTOMLValue} from 'toml-eslint-parser';
import {fail,parse,MAX_INPUT_BYTES} from '../contracts/parse.js';
import {contractDigest} from '../contracts/semantic.js';
import {utf8} from '../source/inventory.js';
import {readTOMLField,reconcileTOMLFields,AGENT_CONTROL_KEYS} from '../operations/toml-fields.js';

const compat=['skills','rules','agents','mcps','hooks'];
const named=/^\/(agents|mcp_servers|mcpServers)\/[a-z][a-z0-9_-]{0,99}$/;
const object=v=>v!==null && typeof v==='object' && !Array.isArray(v);

// Named configuration destinations, never source-provided absolute filenames.
// No I/O. This module cannot change auth, models, trust, permissions or hooks.
export function compileDesiredSettings(target,bytes,operations) {
  if(bytes!==null && (!Buffer.isBuffer(bytes)||bytes.length>MAX_INPUT_BYTES))fail('desired.config-input');
  if(!Array.isArray(operations)||!operations.length||operations.length>1000)fail('desired.config-operations');
  const checked=parse(JSON.stringify(operations),'json');
  const pointers=[];
  for(const op of checked) {
    if(op.target!==target || !['set','remove'].includes(op.operation) ||
        Object.keys(op).some(k=>!['adapter','target','pointer','operation','value'].includes(k)) ||
        (op.operation==='set')!==Object.hasOwn(op,'value'))fail('desired.config-operation');
    const p=op.pointer;
    if(typeof p!=='string')fail('desired.config-scope');
    let allowed=false;
    if(target==='codex.workspace')allowed=named.test(p) && /^\/(agents|mcp_servers)\//.test(p) && !AGENT_CONTROL_KEYS.includes(p.split('/')[2]);
    if(target==='grok.workspace')allowed=named.test(p) && p.startsWith('/mcp_servers/');
    if(target==='claude.mcp')allowed=named.test(p) && p.startsWith('/mcpServers/');
    if(target==='claude.workspace')allowed=p==='/enabledMcpjsonServers';
    if(target==='grok.user')allowed=compat.some(k=>p==='/compat/claude/'+k);
    if(!allowed || p.split('/').some(k=>['__proto__','prototype','constructor'].includes(k)))fail('desired.config-scope');
    if(pointers.some(q=>p===q || p.startsWith(q+'/') || q.startsWith(p+'/')))fail('desired.field-overlap');
    pointers.push(p);
    if(op.operation==='set') {
      if(target==='grok.user' && typeof op.value!=='boolean')fail('desired.config-value');
      if(target==='claude.workspace' && (!Array.isArray(op.value)||op.value.some(v=>typeof v!=='string')||new Set(op.value).size!==op.value.length))fail('desired.config-value');
      if(named.test(p) && !object(op.value))fail('desired.config-value');
    }
  }
  if(target==='grok.user')return compatSettings(bytes,checked);
  if(['codex.workspace','grok.workspace'].includes(target)) {
    const requests=checked.map(op=>{
      const current=readTOMLField(bytes,op.pointer);
      return {pointer:op.pointer,present:op.operation==='set',...(op.operation==='set'?{value:op.value}:{}),
        managedHash:current.present?contractDigest(current.value):null};
    });
    // The old codec is reused only as a syntax-preserving editor. The observed
    // value is deliberately replaceable; its backup/conflict decisions are not
    // part of the new installation policy and are not returned.
    const result=reconcileTOMLFields(bytes,requests);
    return {bytes:result.bytes,changed:!result.bytes.equals(bytes??Buffer.alloc(0))};
  }
  const current=bytes===null?{}:parse(utf8(bytes),'json');
  if(!object(current))fail('desired.config-shape');
  const result=structuredClone(current);
  for(const op of checked) {
    const parts=op.pointer.slice(1).split('/');let parent=result;
    for(const key of parts.slice(0,-1)) {
      if(!Object.hasOwn(parent,key)) {
        if(op.operation==='remove'){parent=null;break;}
        parent[key]={};
      }
      if(!object(parent[key]))fail('desired.config-ancestor');
      parent=parent[key];
    }
    if(parent!==null) {
      if(op.operation==='remove')delete parent[parts.at(-1)];
      else parent[parts.at(-1)]=op.value;
    }
  }
  if(JSON.stringify(result)===JSON.stringify(current))return {bytes:bytes??Buffer.from('{}\n'),changed:false};
  return {bytes:Buffer.from(JSON.stringify(result,null,2)+'\n'),changed:true};
}

function compatSettings(bytes,operations) {
  const text=bytes===null?'':utf8(bytes);
  let ast,value;try{ast=parseTOML(text,{tomlVersion:'1.0'});value=getStaticTOMLValue(ast);}catch{fail('desired.config-syntax');}
  if(value.compat!==undefined && !object(value.compat))fail('desired.config-ancestor');
  if(value.compat?.claude!==undefined && !object(value.compat.claude))fail('desired.config-ancestor');
  const expected=structuredClone(value),edits=[],seen=new Set(),nl=text.includes('\r\n')?'\r\n':'\n';
  const changes=operations.filter(op=>{
    const k=op.pointer.split('/').at(-1),exists=Object.hasOwn(value.compat?.claude??{},k);
    if(op.operation==='remove'){if(exists)delete expected.compat.claude[k];return exists;}
    expected.compat??={};expected.compat.claude??={};expected.compat.claude[k]=op.value;
    return !exists || value.compat.claude[k]!==op.value;
  });
  if(!changes.length)return {bytes:bytes??Buffer.alloc(0),changed:false};
  function pair(node,base) {
    const keys=[...base,...node.key.keys.map(k=>k.name??k.value)];
    for(const op of changes) {
      const wanted=op.pointer.slice(1).split('/');
      if(keys.length<wanted.length && keys.every((k,i)=>k===wanted[i]))fail('desired.config-inline-ancestor');
      if(keys.length===wanted.length && keys.every((k,i)=>k===wanted[i])) {
        seen.add(op.pointer);
        edits.push(op.operation==='remove'?[...node.range,'']:[...node.value.range,String(op.value)]);
      }
    }
  }
  let table=null,parentTable=null;
  for(const node of ast.body[0].body) {
    if(node.type==='TOMLKeyValue')pair(node,[]);
    else if(node.type==='TOMLTable') {
      if(node.resolvedKey.join('.')==='compat.claude')table=node;
      if(node.resolvedKey.length===1 && node.resolvedKey[0]==='compat')parentTable=node;
      for(const child of node.body)pair(child,node.resolvedKey);
    }
  }
  const additions=changes.filter(op=>op.operation==='set'&&!seen.has(op.pointer));
  if(additions.length) {
    const selected=table??parentTable;
    if(selected) {
      if(selected.kind!=='standard')fail('desired.config-ancestor');
      const end=text.indexOf('\n',selected.key.range[1]),pos=end<0?text.length:end+1;
      edits.push([pos,pos,(end<0?nl:'')+additions.map(op=>(table?'':'claude.')+
        op.pointer.split('/').at(-1)+' = '+String(op.value)+nl).join('')]);
    } else edits.push([0,0,additions.map(op=>op.pointer.slice(1).split('/').join('.')+' = '+String(op.value)+nl).join('')]);
  }
  let output=text;
  for(const [start,end,replacement] of edits.sort((a,b)=>b[0]-a[0]))output=output.slice(0,start)+replacement+output.slice(end);
  let after;try{after=getStaticTOMLValue(parseTOML(output,{tomlVersion:'1.0'}));}catch{fail('desired.config-postcondition');}
  function normalize(v){if(v.compat?.claude && !Object.keys(v.compat.claude).length)delete v.compat.claude;if(v.compat && !Object.keys(v.compat).length)delete v.compat;return v;}
  if(!isDeepStrictEqual(normalize(after),normalize(expected)))fail('desired.config-postcondition');
  const bom=bytes?.subarray(0,3).equals(Buffer.from([0xef,0xbb,0xbf]));
  return {bytes:Buffer.from((bom?'\uFEFF':'')+output),changed:true};
}
