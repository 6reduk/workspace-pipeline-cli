// Only native skill routing files of still-selected providers are eligible.
// No config, root instruction, agent, unknown file or removed provider cleanup.
// Eligibility alone is not deletion authority: replay, before hashes and preview
// approval remain mandatory in the plan/apply lifecycle.
const roots={codex:'.agents',claude:'.claude',grok:'.grok',kimi:'.kimi-code'};
export function retiredSkillOwnership(previous,selection,requests=selection.owned??[]) {
  const paths=new Set(requests.map(r=>r.path));
  return (previous?.active?.owned??[]).filter(o=>{
    const root=roots[o.owner],prefix=root+'/skills/';
    if(!root || o.kind!=='file' || !selection.providers.includes(o.owner) ||
      paths.has(o.path) || !o.path.startsWith(prefix))return false;
    return /^[a-z][a-z0-9-]{0,62}\/SKILL\.md$/.test(o.path.slice(prefix.length));
  });
}
