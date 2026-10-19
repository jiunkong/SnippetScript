import test from 'node:test';
import assert from 'node:assert/strict';
import * as context from '../dist/index.js';

test('multiplication repeats strings in either order and preserves numeric multiplication', () => {
  for (const [expression, expected] of [
    ['"ab" * 3', 'ababab'], ['3 * "ab"', 'ababab'],
    ['"12" * 3', '121212'], ['"ab" * 0', ''], ['0 * "ab"', ''],
    ['"" * 4', ''], ['"한😀" * 2', '한😀한😀'],
    ['"ab" * 1', 'ab'], ['"a" * (1 + 2)', 'aaa'],
    ['"a" * 2 * 3', 'aaaaaa'], ['"a" + "b" * 2', 'abb'],
    ['$text * $count', 'xyxy'], ['6 * 3', 18], ['1.5 * 2', 3], ['-2 * 3', -6]
  ]) assert.equal(context.evaluateExpression(expression, { text: 'xy', count: 2 }), expected, expression);
});

test('string repetition rejects invalid counts and reports oversized results', () => {
  for (const count of ['(-1)', '1.5', '"3"', 'true', 'null', 'undefined', '(1/0)', '(0/0)', '9007199254740992']) {
    for (const expression of [`"ab" * ${count}`, `${count} * "ab"`]) {
      assert.throws(() => context.evaluateExpression(expression, {}), error => error.messageKey === 'err_string_repeat_count', expression);
    }
  }
  assert.throws(() => context.evaluateExpression('"ab" * 9007199254740991', {}), error => error.messageKey === 'err_string_repeat_size');
});

test('startswith and endswith compare strings and accept variables', () => {
  const args = { text: 'Snippet++', prefix: 'Sni', suffix: '++' };

  assert.equal(context.evaluateExpression('startswith($text, $prefix)', args), true);
  assert.equal(context.evaluateExpression('startswith($text, "sni")', args), false);
  assert.equal(context.evaluateExpression('endswith($text, $suffix)', args), true);
  assert.equal(context.evaluateExpression('endswith($text, "++!")', args), false);
  assert.equal(context.evaluateExpression("startswith(substr($text, 0, 3), 'Sni')", args), true);
});

test('range expressions produce reusable integer range values', () => {
  for (const [expression, args, start, end] of [
    ['2~5', {}, 2, 5], ['-3 ~ -1', {}, -3, -1], ['5~2', {}, 5, 2],
    ['$a + 1 ~ $b * 2', { a: 1, b: 3 }, 2, 6],
    ['(1 + 1) ~ max(4, 5)', {}, 2, 5],
    ['true ? 2~5 : 8~9', {}, 2, 5]
  ]) {
    const range = context.evaluateExpression(expression, args);
    assert.equal(context.isRange(range), true);
    assert.equal(range.start, start);
    assert.equal(range.end, end);
    assert.equal(String(range), `${start}~${end}`);
    assert.equal(context.evaluateExpression('$range', { range }), range);
  }
  assert.equal(context.evaluateExpression('"2~5"', {}), '2~5');
  for (const expression of ['2~', '~5', '1~2~3', '1.5~3', '1~(1/0)', '1~9007199254740992']) {
    assert.throws(() => context.evaluateExpression(expression, {}), /range/i);
  }
});

test('random samples range values and retains literal choices containing tildes', () => {
  let sample = 0;
  const environment = { ...context.defaultEnvironment, random: () => sample };
  const ctx = { ...context, evaluateExpression: (source, args) => context.evaluateExpression(source, args, undefined, environment) };
  const range = ctx.evaluateExpression('2~5', {});
  assert.equal(ctx.evaluateExpression('random($r)', { r: range }), 2);
  sample = 0.999;
  assert.equal(ctx.evaluateExpression('random($r)', { r: range }), 5);
  assert.equal(ctx.evaluateExpression('random(5~2)', {}), 5);
  assert.equal(ctx.evaluateExpression('random((1+1)~(2+3))', {}), 5);
  assert.equal(ctx.evaluateExpression('random("a~b")', {}), 'a~b');
  assert.equal(ctx.evaluateExpression('random(2~5, "literal")', {}), 'literal');
});

test('type identifies values without coercion and preserves range, null and undefined', () => {
  for (const [expression, expected] of [
    ['type("42")', 'string'], ['type("")', 'string'], ['type(42)', 'number'],
    ['type(0)', 'number'], ['type(-1.5)', 'number'], ['type(true)', 'bool'],
    ['type(false)', 'bool'], ['type(2~5)', 'range'], ['type((5~2))', 'range'],
    ['type(null)', 'null'], ['type(undefined)', 'undefined'], ['type((undefined))', 'undefined'],
    ['type(num("42"))', 'number'], ['type(2 < 3)', 'bool'], ['type(type(42))', 'string'],
    ['type($captured)', 'string'], ['type($optional)', 'undefined'], ['type($empty)', 'null']
  ]) assert.equal(context.evaluateExpression(expression, { captured: '42', optional: undefined, empty: null }), expected, expression);
  assert.throws(() => context.evaluateExpression('type($missing)', {}), error => error.messageKey === 'err_undefined_variable');
  for (const expression of ['type()', 'type(1, 2)', 'type(,1)', 'type(1,)']) {
    assert.throws(() => context.evaluateExpression(expression, {}), error => error.messageKey === 'err_fn_one_arg_exact', expression);
  }
});

test('bool converts values using the existing if condition rules and type reports bool', () => {
  for (const [source, expected] of [
    ['false', false], ['true', true], ['0', false], ['-0', false], ['42', true], ['-2', true],
    ['(0/0)', false], ['(1/0)', true], ['null', false], ['undefined', false],
    ['""', false], ['"false"', false], ['"0"', false], ['"true"', true],
    ['"False"', true], ['"0.0"', true], ['" "', true], ['" false "', true],
    ['[]', true], ['[0]', true], ['1~2', true]
  ]) {
    const value = context.evaluateExpression(`bool(${source})`, {});
    assert.equal(value, expected, source);
    assert.equal(value, context.evaluateCondition(source, {}), source);
    assert.equal(context.evaluateExpression(`type(bool(${source}))`, {}), 'bool', source);
  }
  for (const source of ['type(true)', 'type(false)', 'type(1 < 2)', 'type(true && false)', 'type(bool(0))']) {
    assert.equal(context.evaluateExpression(source, {}), 'bool', source);
  }
});

test('bool requires exactly one argument and preserves undefined variable errors', () => {
  for (const source of ['bool()', 'bool(1,2)', 'bool(,1)', 'bool(1,)', 'bool(1,,2)']) {
    assert.throws(() => context.evaluateExpression(source, {}), error => error.messageKey === 'err_fn_one_arg_exact', source);
  }
  assert.throws(() => context.evaluateExpression('bool($missing)', {}), error => error.messageKey === 'err_undefined_variable');
});
