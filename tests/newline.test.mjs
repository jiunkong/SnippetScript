import test from 'node:test';
import assert from 'node:assert/strict';
import { analyze, execute, FUNCTIONS } from '../dist/index.js';

for (const name of ['newline', 'nl']) {
  test(`${name} returns one LF as a string and composes inside compact and expressions`, async () => {
    const source = `{{compact}}
      A{{${name}()}}
      {{set $separator = ${name}()}}
      {{"B" + $separator + "C"}}
    {{endcompact}}`;
    const analysis = analyze(source);
    assert.deepEqual(analysis.diagnostics, []);
    assert.equal(String(await execute(analysis)), 'A\nB\nC');
    const signature = analysis.callSignatures.find(call => call.name === name);
    assert.equal(signature.overloads.length, 1);
    assert.deepEqual(signature.overloads[0].parameters, []);
    assert.deepEqual(signature.overloads[0].returnTypes, ['string']);
    assert.equal(FUNCTIONS[name].host, undefined);
  });

  test(`${name} rejects arguments before execution`, async () => {
    const analysis = analyze(`{{${name}(1)}}`);
    assert.ok(analysis.diagnostics.some(diagnostic => diagnostic.code === 'err_fn_no_args_allowed'));
    await assert.rejects(execute(analysis), error => error.messageKey === 'err_fn_no_args_allowed');
  });
}
