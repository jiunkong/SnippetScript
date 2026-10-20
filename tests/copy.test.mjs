import test from 'node:test';
import assert from 'node:assert/strict';
import { analyze, execute, SnippetFragment } from '../dist/index.js';

test('copy signatures and variable inference report undefined for strings and fragments', () => {
  const analysis = analyze('{{set $result=copy("text")}}{{$result}}{{copy(`a{{#1}}`)}}');
  assert.deepEqual(analysis.diagnostics, []);
  for (const signature of analysis.callSignatures.filter(call => call.name === 'copy')) {
    for (const overload of signature.overloads) assert.deepEqual(overload.returnTypes, ['undefined']);
  }
  for (const variable of analysis.variableTypes.filter(variable => variable.name === 'result')) {
    assert.deepEqual(variable.types, ['undefined']);
  }
});

test('copy normalizes successful host responses to undefined and inserts no text', async () => {
  const calls = [];
  const analysis = analyze('A{{set $result=copy("text")}}{{type($result)}}/{{$result}}/{{type(copy(`a{{#1}}`))}}B');
  const result = await execute(analysis, { host: { invoke(request) {
    calls.push(request);
    // Older hosts may still return a string; the language owns return semantics.
    return 'old host result';
  } } });
  assert.equal(String(result), 'Aundefined//undefinedB');
  assert.equal(calls.length, 2);
  assert.equal(calls[0].args[0].value, 'text');
  assert.ok(calls[1].args[0] instanceof SnippetFragment);
  assert.equal(calls[1].args[0].toString(), 'a{{#1}}');
});

test('copy failures still throw and invalid arguments never reach the host', async () => {
  await assert.rejects(execute(analyze('{{copy("text")}}'), { host: { invoke() {
    throw new Error('Clipboard denied');
  } } }), error => error.code === 'err_clipboard_copy_failed');
  for (const source of ['{{copy()}}', '{{copy(1)}}', '{{copy("a","b")}}']) {
    await assert.rejects(execute(analyze(source), { host: { invoke() {
      assert.fail('invalid copy arguments must be rejected before clipboard access');
    } } }));
  }
});
