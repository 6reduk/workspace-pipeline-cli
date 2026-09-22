import { posix } from 'node:path';
import { parseTOML } from 'toml-eslint-parser';
import { fail, parse, MAX_INPUT_BYTES } from '../contracts/parse.js';
import { portablePath } from '../contracts/semantic.js';
import { sourceText, snapshotFilePath } from './source.js';
import { legacyEntryReplay } from './common-entry.js';

const capabilities = Object.freeze(['skills', 'agents', 'mcp', 'entry-instructions']);
const safeName = name => typeof name === 'string' && /^[a-z][a-z0-9-]{0,62}$/.test(name) &&
  !['constructor', 'prototype', 'default'].includes(name);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
function shape(value, required, optional = []) {
  if (!object(value) || required.some(key => !Object.hasOwn(value, key)) ||
      Object.keys(value).some(key => ![...required, ...optional].includes(key))) fail('provider.format');
}
function text(value, limit = MAX_INPUT_BYTES) {
  if (typeof value !== 'string' || !value.trim() || Buffer.byteLength(value) > limit || /\u0000/.test(value)) fail('provider.format');
  return value;
}
function metadata(value) {
  shape(value, ['name', 'description']);
  if (!safeName(value.name)) fail('provider.name');
  text(value.description, 1024);
  return value;
}
function markdown(input) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)([\s\S]*)$/.exec(input);
  if (!match) fail('provider.frontmatter');
  const meta = metadata(parse(match[1])); text(match[2]);
  return { ...meta, body: match[2] };
}
function tree(context, prefix) {
  portablePath(prefix);
  const entries = [...context.files.keys()].filter(name => name.startsWith(prefix + '/')).sort();
  if (!entries.length) fail('provider.source-missing');
  return entries;
}
const file = (owner, path, content) => ({ owner, path, kind: 'file', bytes: Buffer.from(content) });
function route(context, source, destination) {
  const target = posix.relative(posix.dirname(destination), snapshotFilePath(context, source));
  return `Read [the complete pipeline instruction](<${target}>) before acting.\n` +
    'Resolve its relative links from that source file, not from this routing file or the shell working directory.\n' +
    'The source is a resource location, not the project root. Use the wrapper AGENTS.md for project routing.\n' +
    'Follow its gates and scope; this routing file grants no approval.\n';
}
const providerRoot = id => {
  const root = { codex: '.agents', claude: '.claude', kimi: '.kimi-code', grok: '.grok' }[id];
  if (typeof root !== 'string') fail('provider.unsupported');
  return root;
};
export function skills(context, id, prefix) {
  const entries = tree(context, prefix), roots = new Map();
  for (const source of entries) {
    const relative = source.slice(prefix.length + 1), parts = relative.split('/');
    if (!safeName(parts[0]) || parts.length < 2) fail('provider.skill-tree');
    roots.set(parts[0], `${prefix}/${parts[0]}/SKILL.md`);
  }
  return [...roots].map(([name, source]) => {
    const meta = markdown(sourceText(context, source));
    if (meta.name !== name) fail('provider.name');
    const destination = `${providerRoot(id)}/skills/${name}/SKILL.md`;
    return file(id, destination, `---\nname: ${name}\ndescription: ${JSON.stringify(meta.description)}\n---\n\n` + route(context, source, destination));
  });
}
export function agents(context, id, prefix) {
  const requests = [], fields = [];
  for (const source of tree(context, prefix)) {
    const relative = source.slice(prefix.length + 1), extension = id === 'codex' ? '.toml' : '.md';
    if (relative.includes('/') || !relative.endsWith(extension)) fail('provider.agent-tree');
    const name = relative.slice(0, -extension.length), input = sourceText(context, source);
    let meta;
    if (id === 'codex') {
      if (Buffer.byteLength(input) > MAX_INPUT_BYTES) fail('provider.format');
      let ast;
      try { ast = parseTOML(input, { tomlVersion: '1.0' }); }
      catch { fail('provider.agent-toml'); }
      const value = Object.create(null), pairs = ast.body[0].body;
      if (pairs.length !== 3) fail('provider.format');
      for (const pair of pairs) {
        if (pair.type !== 'TOMLKeyValue' || pair.key.keys.length !== 1 || pair.value.type !== 'TOMLValue' || pair.value.kind !== 'string') fail('provider.format');
        const key = pair.key.keys[0].name ?? pair.key.keys[0].value;
        if (!['name', 'description', 'developer_instructions'].includes(key) || Object.hasOwn(value, key)) fail('provider.format');
        value[key] = pair.value.value;
      }
      shape(value, ['name', 'description', 'developer_instructions']);
      meta = metadata({ name: value.name, description: value.description });
      text(value.developer_instructions);
      if (meta.name !== name || name === 'enabled') fail('provider.name');
      const destination = `.codex/agents/${name}.toml`;
      // TOML basic strings use JSON-compatible escaping for accepted text.
      const instructions = route(context, source, destination) + '\n' + value.developer_instructions;
      if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(instructions)) fail('provider.format');
      requests.push(file(id, destination, `developer_instructions = ${JSON.stringify(instructions)}\n`));
      fields.push({ pointer: `/agents/${name}`, present: true,
        value: { description: meta.description, config_file: `agents/${name}.toml` } });
    } else {
      meta = markdown(input);
      if (meta.name !== name) fail('provider.name');
      if (id === 'kimi' && ['agent', 'coder', 'explore', 'plan'].includes(name)) fail('provider.name');
      if (id === 'grok' && ['general-purpose', 'explore', 'plan'].includes(name)) fail('provider.name');
      const destination = `${providerRoot(id)}/agents/${name}.md`;
      requests.push(file(id, destination, `---\nname: ${name}\ndescription: ${JSON.stringify(meta.description)}\n---\n\n` + route(context, source, destination)));
    }
  }
  return { requests, fields };
}
export function mcp(context, id, source) {
  const config = parse(sourceText(context, source), 'json'); shape(config, ['mcpServers']);
  if (!object(config.mcpServers) || !Object.keys(config.mcpServers).length) fail('provider.mcp');
  return Object.entries(config.mcpServers).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([name, server]) => {
    if (!safeName(name)) fail('provider.name');
    let value;
    if (server?.type === 'stdio') {
      shape(server, ['type', 'command'], ['args', 'env']); text(server.command, 4096);
      if (server.args !== undefined && (!Array.isArray(server.args) || server.args.some(arg => typeof arg !== 'string' || arg.includes('\0')))) fail('provider.mcp');
      if (server.env !== undefined && (!object(server.env) || Object.entries(server.env).some(([key, v]) =>
        !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || typeof v !== 'string' || v.includes('\0')))) fail('provider.mcp');
      const { type, ...stdio } = server; value = ['codex', 'kimi', 'grok'].includes(id) ? stdio : server;
    } else if (server?.type === 'http') {
      shape(server, ['type', 'url']);
      text(server.url, 8192);
      let url; try { url = new URL(server.url); } catch { fail('provider.mcp'); }
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash) fail('provider.mcp');
      value = ['codex', 'kimi', 'grok'].includes(id) ? { url: server.url } : server;
    } else fail('provider.mcp');
    return { pointer: `/${['codex', 'grok'].includes(id) ? 'mcp_servers' : 'mcpServers'}/${name}`, present: true, value };
  });
}
function render(context, id) {
  const declaration = context.pipeline.providers[id];
  if (!declaration || declaration.requires.some(capability => !capabilities.includes(capability))) fail('provider.unsupported');
  const requests = [], fields = [];
  if (declaration.skills !== null) requests.push(...skills(context, id, declaration.skills));
  if (declaration.agents !== null) {
    const rendered = agents(context, id, declaration.agents); requests.push(...rendered.requests); fields.push(...rendered.fields);
  }
  if (declaration.mcp !== null) {
    const entries = mcp(context, id, declaration.mcp);
    if (id === 'codex') fields.push(...entries);
    else requests.push({ owner: id, path: '.mcp.json', kind: 'json-fields', fields: entries });
  }
  if (id === 'codex' && fields.length) requests.push({ owner: id, path: '.codex/config.toml', kind: 'toml-fields', fields });
  if (declaration.entryInstructions !== null) text(sourceText(context, declaration.entryInstructions));
  // Codex reads common AGENTS.md; provider entry pointers are appended there.
  if (id === 'claude' && !context.layout.bundles && legacyEntryReplay(context)) requests.push(file(id, 'CLAUDE.md', '@AGENTS.md\n' +
    (declaration.entryInstructions === null ? '' : '\n' + route(context, declaration.entryInstructions, 'CLAUDE.md'))));
  return requests;
}
function adapter(id) {
  return Object.freeze({ id, version: id === 'claude' ? '2' : '1', capabilities,
    async validate(context) { render(context, id); return { valid: true, runtime: 'not-run' }; },
    async plan(context) { return render(context, id); } });
}
export const codexAdapter = adapter('codex');
export const claudeAdapter = adapter('claude');
