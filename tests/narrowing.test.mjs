import test from 'node:test';
import assert from 'node:assert/strict';
import { analyze, execute, evaluateExpression, parseExpression, Types, Type, ListType, UnionType, ListValue, fromNative, intersectTypes, excludeType } from '../dist/index.js';

const mixed = UnionType.of(Types.string, Types.number, Types.fragment);
const options = { variableTypes: { x: mixed } };
const reads = (analysis, name = 'x') => analysis.variableTypes.filter(variable => variable.name === name).map(variable => variable.type.format());
const valid = (source, options) => {
  const analysis = analyze(source, options);
  assert.deepEqual(analysis.diagnostics, [], source);
  return analysis;
};

test('is tests scalar, nullish, range and fragment types without coercing values', async () => {
  for (const [source, expected] of [
    ['"x" is string', true], ['1 is number', true], ['false is bool', true],
    ['null is null', true], ['undefined is undefined', true], ['(1~3) is range', true],
    ['"1" is number', false], ['1 is string', false], ['null is undefined', false],
    ['1 is any', true], ['1 is unknown', true], ['1 is never', false],
  ]) assert.equal(evaluateExpression(source).value, expected, source);
  assert.equal(String(await execute(valid('{{`x{{#1}}` is fragment}}'))), 'true');
  assert.equal(String(await execute(valid('{{"x{{#1}}" is fragment}}'))), 'false');
  assert.equal(evaluateExpression('type("x")').value, 'string');
});

test('type expressions support unions, groups, nested lists and list as list<any>', () => {
  for (const [source, expected] of [
    ['1 is string | number', true], ['false is (string | number)', false],
    ['[1,"a"] is list', true], ['[1,"a"] is list<any>', true],
    ['[] is list<string>', true], ['[] is list<never>', true], ['[1] is list<never>', false],
    ['[1,"a"] is list<string | number>', true], ['[1,"a"] is list<string>', false],
    ['[[1],[]] is list<list<number>>', true], ['[[1],["x"]] is list<list<number>>', false],
    ['[[1],["x"]] is list<list<number> | list<string>>', true],
    ['[[1],["x"]] is list<list<number>> | list<list<string>>', false],
    ['[1,"a"] is (list<string> | list<number>)', false],
    ['null is list', false], ['[null,undefined] is list<(null | undefined)>', true],
  ]) assert.equal(evaluateExpression(source).value, expected, source);
  const target = parseExpression('[] is list').target;
  assert.ok(target instanceof Type && target instanceof ListType);
  assert.ok(target.equals(new ListType(Types.any))); assert.ok(Object.isFrozen(target));
});

test('is precedence, boolean negation and token ranges share the expression parser', () => {
  for (const source of ['1 + 2 is number && "x" is string', '[] is list<string>==true', '[[1]] is list<list<number>>==true', '!(1 is string)', '1 is number ? true : false'])
    assert.equal(evaluateExpression(source).value, true, source);
  const source = '{{[] is list<(string | fragment)>}}';
  const analysis = valid(source);
  assert.deepEqual(analysis.tokens.filter(token => token.kind === 'type').map(token => source.slice(token.start, token.end)), ['list', 'string', 'fragment']);
  assert.ok(analysis.tokens.some(token => token.kind === 'operator' && source.slice(token.start, token.end) === 'is'));
  const union = parseExpression('$x is string | fragment').target;
  assert.ok(union instanceof UnionType);
});

test('invalid and unfinished type expressions report localized diagnostics at source ranges', () => {
  for (const expression of ['1 is', '1 is list<>', '1 is list<string', '1 is (string |)', '1 is list<string,number>', '1 is "string"', '1 is | string']) {
    const analysis = analyze(`{{${expression}}}`);
    assert.ok(analysis.diagnostics.some(diagnostic => diagnostic.code === 'err_type_syntax'), expression);
    assert.throws(() => evaluateExpression(expression), error => error.code === 'err_type_syntax', expression);
  }
  const source = '{{1 is mystery}}';
  const diagnostic = analyze(source).diagnostics.find(diagnostic => diagnostic.code === 'err_unknown_type');
  assert.ok(diagnostic); assert.equal(source.slice(diagnostic.range.start, diagnostic.range.end), 'mystery');
  assert.deepEqual(diagnostic.args, ['mystery']);
});

test('if, elif and else narrow their paths and merge the original possibilities afterward', () => {
  const source = '{{if $x is string}}{{upper($x)}}{{elif $x is number}}{{min($x,1)}}{{else}}{{hasCursor($x)}}{{endif}}{{type($x)}}';
  const analysis = valid(source, options);
  assert.deepEqual(reads(analysis), ['string | number | fragment', 'string', 'number | fragment', 'number', 'fragment', 'string | number | fragment']);
});

test('logical and, or and negation narrow short-circuit operands and both branch paths', () => {
  const and = valid('{{$x is string && upper($x)}}', options);
  assert.deepEqual(reads(and), ['string | number | fragment', 'string']);
  const or = valid('{{!($x is string) || upper($x)}}', options);
  assert.deepEqual(reads(or), ['string | number | fragment', 'string']);
  const branches = valid('{{if $x is string || $x is fragment}}{{copy($x)}}{{else}}{{min($x,1)}}{{endif}}', options);
  assert.deepEqual(reads(branches), ['string | number | fragment', 'number | fragment', 'string | fragment', 'number']);
  const negated = valid('{{if !($x is string)}}{{type($x)}}{{else}}{{upper($x)}}{{endif}}', options);
  assert.deepEqual(reads(negated), ['string | number | fragment', 'number | fragment', 'string']);
});

test('conditional expressions narrow their arms and do not infer unreachable calls', async () => {
  valid('{{$x is string ? upper($x) : ($x is number ? min($x,1) : hasCursor($x))}}', options);
  const source = '{{if $x is string}}{{min($x,1)}}{{else}}{{min($x,1)}}{{endif}}';
  valid(source, { variableTypes: { x: Types.number } });
  assert.equal(String(await execute(valid('{{set $x=1}}{{if $x is string}}{{min($x,1)}}{{else}}{{min($x,1)}}{{endif}}'))), '1');
});

test('assignments replace narrowed types and merged branch assignments reach later reads', () => {
  const reassigned = analyze('{{if $x is string}}{{set $x=2}}{{upper($x)}}{{endif}}', options);
  assert.ok(reassigned.diagnostics.some(diagnostic => diagnostic.code === 'err_argument_type'));
  assert.deepEqual(reads(reassigned), ['string | number | fragment', 'number', 'number']);
  const merged = valid('{{if $x is string}}{{set $x=true}}{{endif}}{{type($x)}}', options);
  assert.equal(reads(merged).at(-1), 'number | bool | fragment');
});

test('list guards narrow nested elements, accept emptiness and keep partial negative overlaps', () => {
  const analysis = valid('{{if $items is list<string>}}{{join($items,",")}}{{endif}}', { variableTypes: { items: Types.unknown } });
  assert.deepEqual(reads(analysis, 'items'), ['unknown', 'list<string>']);
  assert.ok(analysis.callSignatures.find(call => call.name === 'join').overloads.every(overload => overload.returnType === Types.string));
  const partial = valid('{{if $x is list<string>}}{{type($x)}}{{else}}{{type($x)}}{{endif}}', { variableTypes: { x: UnionType.of(new ListType(UnionType.of(Types.string,Types.number)), Types.number) } });
  assert.deepEqual(reads(partial), ['number | list<string | number>', 'list<string>', 'number | list<string | number>']);
  assert.equal(intersectTypes(new ListType(Types.string), new ListType(Types.number)).format(), 'list<never>');
  assert.equal(excludeType(Types.unknown, Types.string), Types.unknown);
});

test('loop values narrow separately from $value and nested loops restore the outer value', async () => {
  const source = '{{set $value=1}}{{for ["x",2]}}{{if value is string}}{{upper(value)}}{{else}}{{min(value,1)}}{{endif}}{{for [true]}}{{type(value)}}{{endfor}}{{type(value)}}{{endfor}}{{type($value)}}';
  const analysis = valid(source);
  assert.equal(String(await execute(analysis)), 'Xboolstring1boolnumbernumber');
  const valueTypes = reads(analysis, 'value');
  assert.ok(valueTypes.includes('string')); assert.ok(valueTypes.includes('number')); assert.ok(valueTypes.includes('bool'));
});

test('is evaluates an operand once and preserves lazy host calls', async () => {
  let calls = 0;
  const host = { invoke() { calls++; return fromNative('x'); } };
  assert.equal(String(await execute(valid('{{paste() is string}}'), { host })), 'true');
  assert.equal(calls, 1);
  assert.equal(String(await execute(valid('{{false && paste() is string}}/{{true || paste() is string}}'), { host })), 'false/true');
  assert.equal(calls, 1);
});

test('nested type checks preserve shared shapes and execution cancellation checks', () => {
  let value = fromNative(1), target = Types.number;
  for (let i = 0; i < 25; i++) { value = new ListValue([value, value]); target = new ListType(UnionType.of(target, Types.string)); }
  let checks = 0;
  assert.ok(target.accepts(value.descriptor, { check() { checks++; } }));
  assert.ok(checks < 200, 'shared descriptions must not expand exponentially');
  assert.throws(() => target.accepts(value.descriptor, { check() { throw new Error('cancelled'); } }), /cancelled/);
});
