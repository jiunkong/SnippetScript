import test from 'node:test';
import assert from 'node:assert/strict';
import { analyze, execute, FUNCTIONS } from '../dist/index.js';

test('newline returns one LF as a string and composes inside compact and expressions', async () => {
  const source = '{{compact}}\n  A{{newline()}}\n  {{set $separator = newline()}}\n  {{"B" + $separator + "C"}}\n{{endcompact}}';
  const analysis = analyze(source);
  assert.deepEqual(analysis.diagnostics, []);
  assert.equal(String(await execute(analysis)), 'A\nB\nC');
  const signature = analysis.callSignatures.find(call => call.name === 'newline');
  assert.equal(signature.overloads.length, 1);
  assert.deepEqual(signature.overloads[0].parameters, []);
  assert.deepEqual(signature.overloads[0].returnTypes, ['string']);
  assert.equal(FUNCTIONS.newline.host, undefined);
});

test('newline rejects arguments before execution', async () => {
  const analysis = analyze('{{newline(1)}}');
  assert.ok(analysis.diagnostics.some(diagnostic => diagnostic.code === 'err_fn_no_args_allowed'));
  await assert.rejects(execute(analysis), error => error.messageKey === 'err_fn_no_args_allowed');
});
