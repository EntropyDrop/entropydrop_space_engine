import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SPACE_SCRIPT_API_V2,
  renderAgentApiReference,
  renderApiReferenceHtml,
  renderApiReferenceMarkdown,
  validateScriptApiContract
} from '../src/contraption/ScriptApiContract.ts';

test('entityAPI V2 contract is valid and renders every supported view', () => {
  assert.deepEqual(validateScriptApiContract(), []);

  const html = renderApiReferenceHtml();
  const markdown = renderApiReferenceMarkdown();
  const agent = renderAgentApiReference();
  for (const required of [
    'self.applyForce',
    'self.body.setMass',
    'self.constraints.create',
    'ctx.world.voxels.set',
    'ctx.selection.createChild',
    'ctx.groundDistance'
  ]) {
    assert.ok(html.includes(required), `in-game reference must contain ${required}`);
    assert.ok(markdown.includes(required), `Markdown reference must contain ${required}`);
    assert.ok(agent.includes(required), `Agent reference must contain ${required}`);
  }
  assert.ok(markdown.includes('GENERATED from src/contraption/ScriptApiContract.ts'));
  assert.equal(agent.includes('Ctrl/Cmd+Enter'), false, 'editor-only tips should not consume Agent context');
});

test('canonical runtime surfaces have unique stable keys', () => {
  assert.equal(SPACE_SCRIPT_API_V2.version, 2);
  for (const [surface, keys] of Object.entries(SPACE_SCRIPT_API_V2.runtimeSurfaces)) {
    assert.equal(new Set(keys).size, keys.length, `${surface} contains duplicate keys`);
    assert.ok(keys.length > 0, `${surface} cannot be empty`);
  }
});

test('entityAPI documentation identifies both APIs and uses the selected backend links', () => {
  const links = { spaceApiUrl: 'https://space.example.test/space/agent/spaceAPI.md', entityApiUrl: 'https://space.example.test/space/agent/entityAPI.md' };
  for (const rendered of [renderApiReferenceHtml(undefined, links), renderApiReferenceMarkdown(undefined, links), renderAgentApiReference(undefined, links)]) {
    assert.ok(rendered.includes(links.spaceApiUrl));
    assert.ok(rendered.includes(links.entityApiUrl));
    assert.ok(rendered.includes('entity runtime executes it'));
    assert.ok(!rendered.includes('Space Script API V2'));
  }
  const escaped = renderApiReferenceHtml(undefined, { ...links, spaceApiUrl: 'https://space.example.test/?a="b"&c=d' });
  assert.ok(escaped.includes('?a=&quot;b&quot;&amp;c=d'));
});
