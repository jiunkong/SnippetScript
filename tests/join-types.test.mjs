import test from 'node:test';
import assert from 'node:assert/strict';
import { analyze, evaluateExpression, execute, FUNCTIONS, ListType, Types, UnionType } from '../dist/index.js';

function resultType(expression, options = {}) {
  const analysis = analyze(`{{set $result=${expression}}}{{$result}}`, options);
  assert.deepEqual(analysis.diagnostics, []);
  return { analysis, type: analysis.variableTypes.filter(variable => variable.name === 'result').at(-1).type };
}

test('join keeps known string and empty lists precise without element-presence constraints', () => {
  for (const expression of ['join(["a", "b"], ",")', 'join([], ",")', 'join(split("a,b", ","), "|")']) {
    const { analysis, type } = resultType(expression);
    assert.equal(type, Types.string, expression);
    for (const overload of analysis.callSignatures.find(call => call.name === 'join').overloads)
      assert.equal(overload.returnType, Types.string, expression);
  }
});

test('join conservatively returns a union for possible fragment elements with a string separator', () => {
  const text = UnionType.of(Types.string, Types.fragment);
  for (const element of [text, Types.fragment]) {
    const { analysis, type } = resultType('join($items, ",")', { variableTypes: { items: new ListType(element) } });
    assert.ok(type.equals(text));
    assert.ok(analysis.callSignatures.find(call => call.name === 'join').overloads.some(overload => overload.returnType.equals(text)));
  }
  assert.ok(resultType('join(["a", `b{{#1}}`], ",")').type.equals(text));
  assert.ok(FUNCTIONS.join.overloads[2].returnType.equals(text));
});

test('join does not assume a fragment survives a branch or removal', () => {
  const expressions = [
    'join($flag ? [`x{{#1}}`] : [], ",")',
    'join(removeAt([`x{{#1}}`], 0), ",")',
  ];
  for (const expression of expressions) {
    const { type } = resultType(expression, { variableTypes: { flag: Types.bool } });
    assert.equal(type.format(), 'string | fragment', expression);
  }
});

test('a fragment separator always gives join a fragment, even for an empty list', async () => {
  for (const expression of ['join([], `{{#1}}`)', 'join(["a", "b"], `{{#1}}`)', 'join([`a{{#2}}`], `{{#1}}`)']) {
    const { analysis, type } = resultType(expression);
    assert.equal(type, Types.fragment, expression);
    assert.ok(analysis.callSignatures.find(call => call.name === 'join').overloads.every(overload => overload.returnType === Types.fragment));
    assert.equal(String(await execute(analyze(`{{type(${expression})}}`))), 'fragment');
  }
});

test('join still validates actual elements and preserves fragment cursors', async () => {
  assert.equal(evaluateExpression('join([], ",")').value, '');
  assert.equal(evaluateExpression('join(["a", "b"], ",")').value, 'a,b');
  assert.equal(String(await execute(analyze('{{join(["a", `b{{#2}}`], ",")}}'))), 'a,b{{#2}}');
  const analysis = analyze('{{join([1], ",")}}');
  assert.ok(analysis.diagnostics.some(diagnostic => diagnostic.severity === 'error' && diagnostic.code === 'err_argument_type'));
  assert.throws(() => evaluateExpression('join([1], ",")'), error => error.code === 'err_argument_type');
  const branch = analyze('{{join($flag ? [`x{{#1}}`] : [], ",")}}', { variableTypes: { flag: Types.bool } });
  assert.equal(String(await execute(branch, { variables: { flag: false } })), '');
  assert.equal(String(await execute(branch, { variables: { flag: true } })), 'x{{#1}}');
});
