// S9: public installed CLI only; all writes are confined to a new Temp tree.
import assert from 'node:assert/strict';
import {execFileSync,spawnSync} from 'node:child_process';
import {mkdtemp,mkdir,readFile,writeFile,readdir,rename} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
const repository=fileURLToPath(new URL('../',import.meta.url));
const root=await mkdtemp(path.join(tmpdir(),'wpc-s9-pilot-'));
const hash=b=>createHash('sha256').update(b).digest('hex');
const env=Object.fromEntries(Object.entries(process.env).filter(([k])=>!/^GIT_/i.test(k)));
Object.assign(env,{GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null',npm_config_offline:'true',npm_config_ignore_scripts:'true',npm_config_audit:'false',npm_config_fund:'false'});
const report={root,platform:process.platform,node:process.version,status:'running',cases:[],runtime:'not-run',network:'offline'};
const exec=(file,args,cwd)=>execFileSync(file,args,{cwd,env,encoding:'utf8',windowsHide:true,timeout:180000,maxBuffer:8*1024*1024});
try{
  assert.ok(process.env.npm_execpath,'Run through npm run test:packed:pilot');
  const npm=args=>exec(process.execPath,[process.env.npm_execpath,...args],repository);
  // Linux container has no writable host cache. Install exact locked dependencies
  // as local tarballs; no registry resolution or network is required.
  const dependencyTarballs=[];
  if(process.platform==='linux'){
    env.npm_config_cache=path.join(root,'npm-cache');
    const lock=JSON.parse(await readFile(path.join(repository,'package-lock.json'),'utf8'));
    const destination=path.join(root,'dependencies');await mkdir(destination);
    for(const [relative,entry]of Object.entries(lock.packages))if(relative){
      assert.ok(relative.startsWith('node_modules/')&&!relative.includes('..'));
      const source=path.join(repository,relative),metadata=JSON.parse(await readFile(path.join(source,'package.json'),'utf8'));
      assert.equal(metadata.version,entry.version);
      const [pack]=JSON.parse(npm(['pack',source,'--offline','--ignore-scripts','--json','--pack-destination',destination]));
      dependencyTarballs.push(path.join(destination,pack.filename));
    }
    report.dependencySeed='exact locked installed packages repacked as explicit local tarballs';
  }
  const [packed]=JSON.parse(npm(['pack','--offline','--ignore-scripts','--json','--pack-destination',root]));
  const tarball=path.join(root,packed.filename),consumer=path.join(root,'consumer');await mkdir(consumer);
  npm(['install','--prefix',consumer,'--offline','--ignore-scripts','--no-audit','--no-fund',tarball,...dependencyTarballs]);
  const installed=path.join(consumer,'node_modules/@6reduk/workspace-pipeline'),cli=path.join(installed,'src/cli.js');
  for(const f of packed.files)assert.equal(hash(await readFile(path.join(installed,f.path))),hash(await readFile(path.join(repository,f.path))),f.path);
  report.package={sha256:hash(await readFile(tarball)),files:packed.files.length};
  async function tree(dir){const result={};for(const entry of await readdir(dir,{withFileTypes:true})){
    const p=path.join(dir,entry.name);assert.ok(!entry.isSymbolicLink());
    if(entry.isDirectory())for(const [k,v]of Object.entries(await tree(p)))result[entry.name+'/'+k]=v;
    else result[entry.name]=hash(await readFile(p));
  }return result;}
  for(const layoutKind of ['single-repo','multi-repo'])for(const order of [['codex','claude'],['claude','codex']]){
    const caseRoot=path.join(root,layoutKind+'-'+order.join('-'));await mkdir(caseRoot);
    const wrapper=path.join(caseRoot,'a'),sibling=path.join(caseRoot,'b'),source=path.join(caseRoot,'source');
    for(const p of [wrapper,sibling,source])await mkdir(p);
    await writeFile(path.join(sibling,'user.txt'),'untouched sibling');const siblingBefore=await tree(sibling);
    const decl={skills:'skills',agents:null,mcp:null,entryInstructions:null,requires:[]};
    const files={'pipeline.json':JSON.stringify({schemaVersion:1,id:'pilot',version:'1.0.0',resources:'resources',inventory:'inventory.json',agentsDocument:{mode:'default'},providers:{codex:decl,claude:decl}}),
      'resources/process.md':'Only explicitly authorized work.','skills/pilot-review/SKILL.md':'---\nname: pilot-review\ndescription: Read-only pilot\n---\nRead ../../resources/process.md.\n'};
    for(const [name,body]of Object.entries(files)){const p=path.join(source,name);await mkdir(path.dirname(p),{recursive:true});await writeFile(p,body);}
    await writeFile(path.join(source,'inventory.json'),JSON.stringify(Object.fromEntries(Object.entries(files).map(([p,b])=>[p,'sha256:'+hash(Buffer.from(b))]))));
    for(const args of [['init','--initial-branch=main','--template='],['add','--all'],['-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','-m','pilot']])
      exec('git',['-C',source,'-c','core.hooksPath=/dev/null','-c','commit.gpgsign=false',...args],caseRoot);
    const layout=layoutKind==='single-repo'?{kind:layoutKind,repositories:{game:{path:'project',role:'code'}},documentation:{repository:'game',path:'docs'}}:
      {kind:layoutKind,repositories:{service:{path:'service',role:'code'},knowledge:{path:'knowledge',role:'documentation'}},documentation:{repository:'knowledge',path:'docs'}};
    const manifest={schemaVersion:1,pipeline:{type:'git',transport:'local',path:'../source',ref:'main',subdirectory:'.'},providers:[order[0]],layout};
    const manifestPath=path.join(wrapper,'workspace.json');await writeFile(manifestPath,JSON.stringify(manifest));
    const run=(args,expected=0)=>{
      const result=spawnSync(process.execPath,[cli,...args],{cwd:consumer,env,encoding:'utf8',windowsHide:true,timeout:180000,maxBuffer:8*1024*1024});
      assert.equal(result.status,expected,JSON.stringify({args,status:result.status,error:result.error?.code,stderr:result.stderr}));
      return JSON.parse(result.stdout);
    };
    let sequence=0;
    async function apply(command,extra=[]){
      const before=await tree(wrapper),preview=run([command,'--workspace',wrapper,...extra]);
      assert.deepEqual(await tree(wrapper),before,'preview mutated wrapper');
      const p=path.join(caseRoot,'preview-'+(++sequence)+'.json');await writeFile(p,JSON.stringify(preview));
      return run([command,'--workspace',wrapper,'--apply','--preview',p]);
    }
    assert.equal((await apply('setup',['--manifest',manifestPath])).status,'ready');
    const skill=p=>path.join(wrapper,p==='codex'?'.agents':'.claude','skills/pilot-review/SKILL.md');
    const firstBytes=await readFile(skill(order[0])),common=await readFile(path.join(wrapper,'AGENTS.md'));
    await assert.rejects(readFile(skill(order[1])),e=>e.code==='ENOENT');
    manifest.providers=order;await writeFile(manifestPath,JSON.stringify(manifest));
    assert.equal((await apply('update',['--manifest',manifestPath])).status,'ready');
    assert.deepEqual(await readFile(skill(order[0])),firstBytes);assert.deepEqual(await readFile(path.join(wrapper,'AGENTS.md')),common);
    const secondBytes=await readFile(skill(order[1]));assert.ok(secondBytes.length);
    assert.ok(common.toString().includes(layoutKind==='single-repo'?'project/docs':'knowledge/docs'));
    await rename(source,path.join(caseRoot,'source-unavailable'));
    await rename(manifestPath,path.join(caseRoot,'manifest-unavailable.json'));
    await rename(skill(order[0]),path.join(caseRoot,'saved-skill.md'));
    assert.equal(run(['doctor','--workspace',wrapper],1).ready,false);
    await apply('repair');assert.deepEqual(await readFile(skill(order[0])),firstBytes);
    assert.equal(run(['doctor','--workspace',wrapper]).ready,true);
    await apply('remove',['--providers',order[0]]);
    assert.deepEqual(await readFile(skill(order[1])),secondBytes);assert.deepEqual(await readFile(path.join(wrapper,'AGENTS.md')),common);
    assert.equal(run(['doctor','--workspace',wrapper]).ready,true);
    await apply('remove');await assert.rejects(readFile(path.join(wrapper,'AGENTS.md')),e=>e.code==='ENOENT');
    assert.deepEqual(await tree(sibling),siblingBefore);
    report.cases.push({layout:layoutKind,order,status:'pass',sourceAndManifestAbsent:true});
    console.log(JSON.stringify({progress:report.cases.at(-1)}));
  }
  report.status='pass';
}catch(e){report.status='fail';report.error={message:e.message};process.exitCode=1;}
finally{await writeFile(path.join(root,'report.json'),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report,null,2));}
