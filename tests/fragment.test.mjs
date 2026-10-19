import test from 'node:test';
import assert from 'node:assert/strict';
import { engine } from './helpers/engine.mjs';

const nodes = value => JSON.parse(JSON.stringify(value.nodes));
const text = value => ({ type: 'text', value });
const cursor = level => ({ type: 'cursor', level });
async function fragment(context, source, args = {}, options) {
  const value = await context.processTemplate(source, args, options);
  assert.equal(value.constructor.name, 'SnippetFragment');
  return value;
}

test('templates parse once into immutable nested code and can be solved with new parameters', async () => {
  const ctx = engine();
  const source = '{{if $yes}}{{for $n}}x{{#index}}{{endfor}}{{else}}no{{endif}}';
  const template = ctx.parseSnippetTemplate(source);
  assert.equal(template.constructor.name, 'SnippetTemplate');
  assert.ok(Object.isFrozen(template));
  assert.ok(Object.isFrozen(template.nodes));
  assert.ok(Object.isFrozen(template.nodes[0].branches));
  assert.equal(template.nodes[0].branches[0].body.nodes[0].body.constructor.name, 'SnippetTemplate');
  const original = JSON.stringify(template);
  ctx.parseSnippetTemplate = () => { throw new Error('parsed code must not be parsed again'); };
  assert.deepEqual(nodes(await fragment(ctx, template, { yes: true, n: 2 })), [text('x'), cursor(0), text('x'), cursor(1)]);
  assert.deepEqual(nodes(await fragment(ctx, template, { yes: false, n: 5 })), [text('no')]);
  assert.equal(JSON.stringify(template), original);
});

test('control tags inside quoted expressions do not split surrounding blocks', async () => {
  const ctx = engine();
  const source = '{{if true}}{{"{{else}} {{endif}}"}}{{else}}bad{{endif}}' +
    '{{for 2}}{{"{{endfor}}"}}{{endfor}}' +
    '{{switch 1}}{{case 1}}{{"{{endcase}}"}}{{endcase}}{{endswitch}}';
  assert.deepEqual(nodes(await fragment(ctx, source)), [text('{{else}} {{endif}}{{endfor}}{{endfor}}{{endcase}}')]);
});

test('only source cursor tags create cursor nodes; expression and external strings stay text', async () => {
  const ctx = engine();
  const marker = '{{#1}}';
  ctx.showSnippetPrompt = async () => marker;
  ctx.navigator = { clipboard: { readText: async () => marker } };
  assert.deepEqual(nodes(await fragment(ctx, '{{"{{#1}}"}}{{$capture}}{{prompt()}}{{paste()}}{{#1}}{{cursor}}{{#(1+2)}}', { capture: marker })),
    [text(marker.repeat(4)), cursor(1), cursor(0), cursor(3)]);
  assert.deepEqual(nodes(await fragment(ctx, '{{"{{" + "#1}}"}}')), [text(marker)]);
});

test('snippet results stay fragments through parameters, assignments, concatenation and cursor shifts', async () => {
  const ctx = engine();
  const snippets = [
    { name: 'body', replacement: 'ab{{#1}}{{"{{#1}}"}}cd' },
    { name: 'echo', trigger: '/echo ${x}', replacement: '{{$x}}' },
    { name: 'wrapper', replacement: '{{@body()<2>}}' }
  ];
  const expected = [text('ab'), cursor(6), text('{{#1}}cd')];
  assert.deepEqual(nodes(await fragment(ctx, '{{set $f = @echo(@wrapper())<3>}}{{$f}}', {}, { snippets })), expected);
  assert.deepEqual(nodes(await fragment(ctx, '{{"[" + @body() + "]"}}', {}, { snippets })),
    [text('[ab'), cursor(1), text('{{#1}}cd]')]);
  assert.deepEqual(nodes(await fragment(ctx, '{{@body() * 2}}', {}, { snippets })),
    [text('ab'), cursor(1), text('{{#1}}cdab'), cursor(1), text('{{#1}}cd')]);
  assert.equal(String(await fragment(ctx, '{{type(@body())}}', {}, { snippets })), 'fragment');
});

test('str serializes cursor syntax as inert text and further calls cannot reactivate it', async () => {
  const ctx = engine();
  const snippets = [{ name: 'body', replacement: 'a{{cursor}}b' },
    { name: 'echo', trigger: '/e ${x}', replacement: '{{$x}}' }];
  assert.deepEqual(nodes(await fragment(ctx, '{{@echo(str(@body()))<4>}}', {}, { snippets })), [text('a{{#0}}b')]);
  assert.deepEqual(nodes(await fragment(ctx, '{{upper(str(@body()))}}', {}, { snippets })), [text('A{{#0}}B')]);
});

test('Unicode characters and cursors share one indexing, length and iteration unit', async () => {
  const ctx = engine();
  const value = await fragment(ctx, 'a😊{{#7}}한');
  const args = { f: value };
  assert.equal(ctx.evaluateExpression('len($f)', args), 4);
  assert.deepEqual(nodes(ctx.evaluateExpression('$f[1]', args)), [text('😊')]);
  assert.deepEqual(nodes(ctx.evaluateExpression('$f[2]', args)), [cursor(7)]);
  assert.deepEqual(nodes(ctx.evaluateExpression('$f[-1]', args)), [text('한')]);
  assert.equal(ctx.evaluateExpression('$f[4]', args), undefined);
  assert.equal(ctx.evaluateExpression('type($f[0])', args), 'fragment');
  assert.deepEqual(nodes(await fragment(ctx, '{{for $f}}{{value}}{{endfor}}', args)), nodes(value));
  assert.equal(String(await fragment(ctx, '{{for $f}}{{index}}:{{type(value)}};{{endfor}}', args)),
    '0:fragment;1:fragment;2:fragment;3:fragment;');
  const literal = await fragment(ctx, '{{for str($f)}}{{value}}{{endfor}}', args);
  assert.deepEqual(nodes(literal), [text('a😊{{#7}}한')]);
  assert.deepEqual(nodes(await fragment(ctx, '{{for $empty}}bad{{endfor}}', { empty: await fragment(ctx, '') })), []);
});

test('fragment loops preserve nested value/index scopes and respect break/continue', async () => {
  const ctx = engine();
  const value = await fragment(ctx, 'a{{#1}}b');
  const args = { f: value, index: 99 };
  assert.deepEqual(nodes(await fragment(ctx, '{{for $f}}{{if index == 0}}{{continue}}{{endif}}{{value}}{{break}}{{endfor}}', args)), [cursor(1)]);
  assert.equal(args.index, 99);
  assert.deepEqual(nodes(await fragment(ctx, '{{for $f}}{{for 1}}x{{endfor}}{{value}}{{endfor}}', args)),
    [text('xax'), cursor(1), text('xb')]);
});

test('text transforms preserve cursor nodes and return fragments, including empty output', async () => {
  const ctx = engine();
  const args = { f: await fragment(ctx, '  ab{{#2}}CD  ') };
  const evaluate = source => ctx.evaluateExpression(source, args);
  assert.deepEqual(nodes(evaluate('upper($f)')), [text('  AB'), cursor(2), text('CD  ')]);
  assert.deepEqual(nodes(evaluate('lower($f)')), [text('  ab'), cursor(2), text('cd  ')]);
  assert.deepEqual(nodes(evaluate('trim($f)')), [text('ab'), cursor(2), text('CD')]);
  args.leadingCursor = await fragment(ctx, '{{#2}}abc');
  assert.deepEqual(nodes(evaluate('capitalize($leadingCursor)')), [cursor(2), text('Abc')]);
  args.empty = await fragment(ctx, '   ');
  assert.deepEqual(nodes(evaluate('trim($empty)')), []);
  assert.equal(evaluate('type(trim($empty))'), 'fragment');
  assert.equal(evaluate('type(upper("abc"))'), 'string');
});

test('fragment slicing and edits select complete cursor nodes and Unicode characters', async () => {
  const ctx = engine();
  const args = { f: await fragment(ctx, 'ab{{#2}}😊d'), stop: await fragment(ctx, '{{#9}}') };
  const evaluate = source => ctx.evaluateExpression(source, args);
  assert.deepEqual(nodes(evaluate('substr($f, 2, 1)')), [cursor(2)]);
  assert.deepEqual(nodes(evaluate('substr($f, -2, 1)')), [text('😊')]);
  assert.deepEqual(nodes(evaluate('substr($f, 99)')), []);
  assert.deepEqual(nodes(evaluate('substr($f, 0, 0)')), []);
  assert.deepEqual(nodes(evaluate('removeAt($f, 2)')), [text('ab😊d')]);
  assert.deepEqual(nodes(evaluate('insertAt($f, 2, $stop)')), [text('ab'), cursor(9), cursor(2), text('😊d')]);
  assert.deepEqual(nodes(evaluate('insertAt($f, -1, "{{#3}}")')), [text('ab'), cursor(2), text('😊{{#3}}d')]);
  assert.deepEqual(nodes(evaluate('insertAt("ab", 1, $stop)')), [text('a'), cursor(9), text('b')]);
  assert.deepEqual(nodes(evaluate('removeAt($f, 99)')), nodes(args.f));
});

test('fragment matching distinguishes literal syntax from tags and joins preserve tags', async () => {
  const ctx = engine();
  const args = { f: await fragment(ctx, 'ab{{#2}}cd'), stop: await fragment(ctx, '{{#2}}') };
  const evaluate = source => ctx.evaluateExpression(source, args);
  assert.equal(evaluate('startswith($f, "ab")'), true);
  assert.equal(evaluate('startswith($f, "ab{{#2}}")'), false);
  assert.equal(evaluate('startswith($f, "ab" + $stop)'), true);
  assert.equal(evaluate('endswith($f, $stop + "cd")'), true);
  assert.equal(evaluate('endswith($f, "{{#2}}cd")'), false);
  assert.deepEqual(nodes(evaluate('replace($f, "{{#2}}", "X")')), nodes(args.f));
  assert.deepEqual(nodes(evaluate('replace($f, $stop, "X")')), [text('abXcd')]);
  assert.deepEqual(nodes(evaluate('replace("axb", "x", $stop)')), [text('a'), cursor(2), text('b')]);
  assert.deepEqual(nodes(evaluate('join(split($f, "b"), "|")')), [text('a|'), cursor(2), text('cd')]);
  assert.deepEqual(nodes(evaluate('join(split($f, ""), "")')), nodes(args.f));
  assert.deepEqual(nodes(evaluate('join(split($f, $stop), $stop)')), nodes(args.f));
  assert.deepEqual(nodes(evaluate('join(["a", "b"], $stop)')), [text('a'), cursor(2), text('b')]);
  assert.equal(evaluate('type(split($f, "")[2])'), 'fragment');
  assert.equal(evaluate('type(join(["a", "b"], "|"))'), 'string');
});

test('cached code is reused across calls and source edits invalidate only that snippet', async () => {
  const ctx = engine();
  const snippet = { name: 'helper', replacement: 'old{{#1}}' };
  const template = ctx.getSnippetTemplate(snippet);
  assert.equal(ctx.getSnippetTemplate(snippet), template);
  await fragment(ctx, '{{for 3}}{{@helper()}}{{endfor}}', {}, { snippets: [snippet] });
  assert.equal(ctx.prepareSnippetTemplate(snippet).analysis.template, template);
  snippet.replacement = 'new{{#2}}';
  assert.deepEqual(nodes(await fragment(ctx, snippet)), [text('new'), cursor(2)]);

  assert.notEqual(ctx.getSnippetTemplate(snippet), template);
  assert.deepEqual(nodes(await fragment(ctx, template)), [text('old'), cursor(1)]);
});

test('preparing invalid code leaves other snippets usable and errors retain source locations', async () => {
  const ctx = engine();
  const broken = { name: 'broken', replacement: 'ok\n{{if true}}unfinished' };
  ctx.prepareSnippetTemplate(broken);
  assert.deepEqual(nodes(await fragment(ctx, 'works')), [text('works')]);
  await assert.rejects(fragment(ctx, '{{@broken()}}', {}, { snippets: [broken] }), error => {
    assert.equal(error.messageKey, 'err_if_unclosed');
    assert.equal(error.snippetLocation.snippetName, 'broken');
    assert.equal(error.snippetLocation.line, 2);
    return true;
  });
  broken.replacement = 'fixed';
  assert.deepEqual(nodes(await fragment(ctx, '{{@broken()}}', {}, { snippets: [broken] })), [text('fixed')]);
});

test('fragment iteration is lazy so break does not materialize the remaining items', async () => {
  const ctx = engine();
  const f = await fragment(ctx, 'ab{{#1}}cd');
  ctx.audit = { visited: 0 };
  const iterate = ctx.SnippetFragment.prototype.iterate;
  ctx.SnippetFragment.prototype.iterate = function* (execution) {
    for (const unit of iterate.call(this, execution)) { ctx.audit.visited++; yield unit; }
  };
  try {
    assert.deepEqual(nodes(await fragment(ctx, '{{for $f}}{{value}}{{break}}{{endfor}}', { f })), [text('a')]);
    assert.equal(ctx.audit.visited, 1);
  } finally { ctx.SnippetFragment.prototype.iterate = iterate; }

});

test('fragment operations enforce the shared deadline while traversing items', async () => {
  for (const expression of ['len($f)', 'substr($f, 0)', 'startswith($f, "a")', 'replace($f, "z", "x")', 'split($f, "")', '$f * 100']) {
    const ctx = engine();
    const f = await fragment(ctx, 'abcdefghijklmnopqrstuvwxyz{{#1}}');
    let checks = 0;
    const execution = { check() { if (++checks > 10) throw ctx.createSnippetError('err_snippet_timeout'); } };
    assert.throws(() => ctx.evaluateExpression(expression, { f }, execution), error => error.messageKey === 'err_snippet_timeout', expression);
  }
});

test('empty fragments and false-like text keep existing condition and Boolean behavior', async () => {
  const ctx = engine();
  const empty = await fragment(ctx, '');
  const no = await fragment(ctx, 'false');
  const args = { empty, no };
  assert.equal(ctx.evaluateExpression('$empty || false', args), false);
  assert.equal(ctx.evaluateExpression('$empty && true', args), false);
  assert.equal(ctx.evaluateExpression('$no && true', args), true);
  assert.equal(String(await fragment(ctx, '{{if $empty}}bad{{elif $no}}bad{{else}}ok{{endif}}', args)), 'ok');
});

test('fragment equality compares typed nodes and template switch cases are immutable', async () => {
  const ctx = engine();
  const f = await fragment(ctx, 'a{{#1}}b');
  const same = await fragment(ctx, 'a{{#(1)}}b');
  const literal = await fragment(ctx, '{{"a{{#1}}b"}}');
  const args = { f, same, literal };
  assert.equal(ctx.evaluateExpression('$f == $same', args), true);
  assert.equal(ctx.evaluateExpression('$f != $literal', args), true);
  const template = ctx.parseSnippetTemplate('{{switch 1}}{{case 1}}yes{{endcase}}{{endswitch}}');
  assert.ok(Object.isFrozen(template.nodes[0].cases[0]));
});

test('isCursor recognizes exactly one actual cursor and rejects other values', async () => {
  const ctx = engine();
  const stop = await fragment(ctx, '{{#1}}');
  const args = {
    stop,
    alias: await fragment(ctx, '{{cursor}}'),
    dynamic: await fragment(ctx, '{{#(2+3)}}'),
    literal: await fragment(ctx, '{{"{{#1}}"}}'),
    empty: await fragment(ctx, ''),
    mixed: await fragment(ctx, 'x{{#1}}'),
    many: await fragment(ctx, '{{#1}}{{#2}}'),
    list: ctx.createList([stop]),
    range: ctx.createRange(1, 2)
  };
  for (const name of ['stop', 'alias', 'dynamic']) {
    assert.equal(ctx.evaluateExpression(`isCursor($${name})`, args), true, name);
  }
  for (const name of ['literal', 'empty', 'mixed', 'many', 'list', 'range']) {
    assert.equal(ctx.evaluateExpression(`isCursor($${name})`, args), false, name);
  }
  for (const source of ['"{{#1}}"', '"x"', '""', '42', 'true', 'null', 'undefined', 'str($stop)']) {
    assert.equal(ctx.evaluateExpression(`isCursor(${source})`, args), false, source);
  }
  assert.equal(ctx.evaluateExpression('type(isCursor($stop))', args), 'bool');
});

test('isCursor works with indexed items, iteration, snippet calls and shifted results', async () => {
  const ctx = engine();
  const f = await fragment(ctx, 'ab{{#1}}cd');
  assert.equal(ctx.evaluateExpression('isCursor($f[2])', { f }), true);
  assert.equal(ctx.evaluateExpression('isCursor($f[0])', { f }), false);
  assert.equal(ctx.evaluateExpression('isCursor($f[99])', { f }), false);
  assert.deepEqual(nodes(await fragment(ctx, '{{for $f}}{{if isCursor(value)}}{{continue}}{{endif}}{{value}}{{endfor}}', { f })), [text('abcd')]);
  const snippets = [{ name: 'stop', replacement: '{{cursor}}' }];
  assert.equal(String(await fragment(ctx, '{{isCursor(@stop()<5>)}}', {}, { snippets })), 'true');
  assert.equal(String(await fragment(ctx, '{{isCursor(str(@stop()))}}', {}, { snippets })), 'false');
});

test('isCursor requires exactly one argument and reports undefined variable errors', () => {
  const ctx = engine();
  for (const source of ['isCursor()', 'isCursor(1, 2)', 'isCursor(,1)', 'isCursor(1,)', 'isCursor(1,,2)']) {
    assert.throws(() => ctx.evaluateExpression(source, {}), error => error.messageKey === 'err_fn_one_arg_exact', source);
  }
  assert.throws(() => ctx.evaluateExpression('isCursor($missing)', {}), error => error.messageKey === 'err_undefined_variable');
});

test('hasCursor finds actual cursors in mixed fragments and rejects literal syntax', async () => {
  const ctx = engine();
  const args = {
    stop: await fragment(ctx, '{{#0}}'),
    mixed: await fragment(ctx, 'ab{{#2}}cd'),
    many: await fragment(ctx, '{{cursor}}{{#3}}'),
    empty: await fragment(ctx, ''),
    text: await fragment(ctx, 'abc'),
    literal: await fragment(ctx, '{{"{{#2}}"}}')
  };
  for (const name of ['stop', 'mixed', 'many']) assert.equal(ctx.evaluateExpression(`hasCursor($${name})`, args), true, name);
  for (const name of ['empty', 'text', 'literal']) assert.equal(ctx.evaluateExpression(`hasCursor($${name})`, args), false, name);
  for (const source of ['"{{#2}}"', '""', '1', 'true', 'null', 'undefined', '[$stop]', '1~3', 'str($mixed)']) {
    assert.equal(ctx.evaluateExpression(`hasCursor(${source})`, args), false, source);
  }
  assert.equal(ctx.evaluateExpression('isCursor($mixed)', args), false);
  assert.equal(ctx.evaluateExpression('type(hasCursor($mixed))', args), 'bool');
  const snippets = [{ name: 'body', replacement: 'ab{{#1}}cd' }];
  assert.equal(String(await fragment(ctx, '{{hasCursor(@body()<2>)}}', {}, { snippets })), 'true');
  assert.equal(String(await fragment(ctx, '{{hasCursor(str(@body()))}}', {}, { snippets })), 'false');
});

test('hasCursor validates its argument count and observes the execution deadline', async () => {
  const ctx = engine();
  for (const source of ['hasCursor()', 'hasCursor(1, 2)', 'hasCursor(,1)', 'hasCursor(1,)']) {
    assert.throws(() => ctx.evaluateExpression(source, {}), error => error.messageKey === 'err_fn_one_arg_exact', source);
  }
  const f = await fragment(ctx, 'ab{{#1}}');
  let checks = 0;
  const execution = { check() { if (++checks > 2) throw ctx.createSnippetError('err_snippet_timeout'); } };
  assert.throws(() => ctx.evaluateExpression('hasCursor($f)', { f }, execution), error => error.messageKey === 'err_snippet_timeout');
});

test('includes searches partial fragments without confusing literal syntax and actual cursors', async () => {
  const ctx = engine();
  const args = {
    f: await fragment(ctx, 'ab{{#1}}😊cd'),
    stop: await fragment(ctx, '{{#1}}'),
    otherStop: await fragment(ctx, '{{#2}}'),
    partial: await fragment(ctx, 'b{{#1}}😊'),
    plain: await fragment(ctx, 'ab😊cd'),
    literal: await fragment(ctx, '{{"ab{{#1}}😊cd"}}'),
    empty: await fragment(ctx, '')
  };
  for (const [source, expected] of [
    ['includes($f, $partial)', true], ['includes($f, $stop)', true], ['includes($f, $otherStop)', false],
    ['includes($f, "ab")', true], ['includes($f, "😊cd")', true], ['includes($f, "bc")', false],
    ['includes($f, "b{{#1}}😊")', false], ['includes($literal, $partial)', false],
    ['includes($literal, "b{{#1}}😊")', true], ['includes($f, $plain)', false],
    ['includes($f, "")', true], ['includes($f, $empty)', true], ['includes($empty, "")', true],
    ['includes($empty, $stop)', false], ['includes("ab{{#1}}😊cd", $partial)', false],
    ['includes([$f], $f)', true], ['includes([$f], str($f))', false],
    ['includes([$stop], $otherStop)', false], ['type(includes($f, $stop))', 'bool']
  ]) assert.equal(ctx.evaluateExpression(source, args), expected, source);
  const copy = await fragment(ctx, 'ab{{#1}}😊cd');
  assert.equal(ctx.evaluateExpression('includes([$f], $copy)', { ...args, copy }), true);
  const snippets = [{ name: 'body', replacement: 'ab{{#1}}cd' }];
  assert.equal(String(await fragment(ctx, '{{includes(@body(), "ab")}}', {}, { snippets })), 'true');
});

test('includes respects the deadline while searching lists and fragments', async () => {
  const ctx = engine();
  const f = await fragment(ctx, 'abcdefghijklmnopqrstuvwxyz{{#1}}');
  for (const source of ['includes($f, "z")', 'includes([1,2,3,4,5,6,7,8,9], 99)']) {
    let checks = 0;
    const execution = { check() { if (++checks > 10) throw ctx.createSnippetError('err_snippet_timeout'); } };
    assert.throws(() => ctx.evaluateExpression(source, { f }, execution), error => error.messageKey === 'err_snippet_timeout', source);
  }
});

test('backtick literals create fragments while quoted cursor syntax remains text', async () => {
  const ctx = engine();
  assert.deepEqual(nodes(await fragment(ctx, '{{`ab{{#1}}cd`}}')), [text('ab'), cursor(1), text('cd')]);
  assert.equal(String(await fragment(ctx, '{{type(`text`)}} / {{type(``)}} / {{type("text")}}')), 'fragment / fragment / string');
  assert.deepEqual(nodes(await fragment(ctx, '{{``}}')), []);
  assert.equal(String(await fragment(ctx, '{{len(`ab{{#1}}cd`)}} / {{isCursor(`{{cursor}}`)}} / {{hasCursor(`ab{{#1}}cd`)}}')), '5 / true / true');
  assert.deepEqual(nodes(await fragment(ctx, '{{"`ab{{#1}}cd`"}}')), [text('`ab{{#1}}cd`')]);
  assert.deepEqual(nodes(await fragment(ctx, '{{str(`ab{{#1}}cd`)}}')), [text('ab{{#1}}cd')]);
});

test('fragment literals compose with indexing, lists, arithmetic and typed matching', async () => {
  const ctx = engine();
  assert.deepEqual(nodes(await fragment(ctx, '{{`ab{{#1}}cd`[2]}}')), [cursor(1)]);
  assert.deepEqual(nodes(await fragment(ctx, '{{`a{{#1}}` * 2 + "b"}}')), [text('a'), cursor(1), text('a'), cursor(1), text('b')]);
  assert.deepEqual(nodes(await fragment(ctx, '{{join([`a{{#1}}`, `b{{#2}}`], ",")}}')), [text('a'), cursor(1), text(',b'), cursor(2)]);
  assert.equal(String(await fragment(ctx, '{{includes(`ab{{#1}}cd`, `b{{#1}}c`)}} / {{includes(`ab{{#1}}cd`, "b{{#1}}c")}}')), 'true / false');
  assert.deepEqual(nodes(await fragment(ctx, '{{replace(`a{{#1}}b`, `{{#1}}`, `{{#2}}`)}}')), [text('a'), cursor(2), text('b')]);
  assert.deepEqual(nodes(await fragment(ctx, '{{for `a{{#1}}😊`}}{{value}}{{endfor}}')), [text('a'), cursor(1), text('😊')]);
});

test('fragment literals evaluate template expressions and blocks using the current variables', async () => {
  const ctx = engine();
  const source = '{{set $x = 2, $f = `{{if $x > 1}}{{for $x}}{{$name}}{{#index}}{{endfor}}{{else}}no{{endif}}`}}{{$f}}';
  assert.deepEqual(nodes(await fragment(ctx, source, { name: 'N' })), [text('N'), cursor(0), text('N'), cursor(1)]);
  assert.equal(String(await fragment(ctx, '{{set $x = 1, $f = `{{set $x = 9}}{{$x}}`}}{{$f}}:{{$x}}')), '9:1');
  assert.deepEqual(nodes(await fragment(ctx, '{{for 2}}{{`{{index}}:{{value}};`}}{{endfor}}')), [text('0:0;1:1;')]);
  assert.deepEqual(nodes(await fragment(ctx, '{{`{{"{{#1}}"}}`}}')), [text('{{#1}}')]);
});

test('nested literals and calls inside literals preserve tags and isolate their source', async () => {
  const ctx = engine();
  const snippets = [{ name: 'echo', trigger: '/e ${value}', replacement: '{{$value}}' }];
  assert.deepEqual(nodes(await fragment(ctx, '{{@echo(`a{{#1}}, (b)`) <2>}}', {}, { snippets })), [text('a'), cursor(3), text(', (b)')]);
  assert.deepEqual(nodes(await fragment(ctx, '{{`a{{upper(`b{{#1}}c`)}}d`}}')), [text('aB'), cursor(1), text('Cd')]);
  assert.deepEqual(nodes(await fragment(ctx, '{{`{{@echo(`x{{#2}}y`)}}`}}', {}, { snippets })), [text('x'), cursor(2), text('y')]);
  assert.deepEqual(nodes(await fragment(ctx, '{{`plain @Missing() prompt("ignored")`}}')), [text('plain @Missing() prompt("ignored")')]);
});

test('fragment literal escapes, multiline content and quoted delimiters keep their meaning', async () => {
  const ctx = engine();
  assert.deepEqual(nodes(await fragment(ctx, '{{`a\\`b\\\\c`}}')), [text('a`b\\c')]);
  assert.deepEqual(nodes(await fragment(ctx, '{{`first\n{{#1}}last`}}')), [text('first\n'), cursor(1), text('last')]);
  assert.deepEqual(nodes(await fragment(ctx, '{{`a{{"}} , ( [ `"}}b`}}')), [text('a}} , ( [ `b')]);
  assert.deepEqual(nodes(await fragment(ctx, '{{`<b>&"\'{{#1}}</b>`}}')), [text('<b>&"\''), cursor(1), text('</b>')]);
});

test('fragment literals are compiled once and reused during repeated solves', async () => {
  const ctx = engine();
  const template = ctx.parseSnippetTemplate('{{for 3}}{{`x{{#index}}`}}{{endfor}}');
  assert.equal(template.nodes[0].body.nodes[0].expression.template.constructor.name, 'SnippetTemplate');
  ctx.parseSnippetTemplate = () => { throw new Error('literal code must not be reparsed during execution'); };
  assert.deepEqual(nodes(await fragment(ctx, template)), [text('x'), cursor(0), text('x'), cursor(1), text('x'), cursor(2)]);
});

test('literal prompt cancellation and timeouts propagate to the enclosing expansion', async () => {
  const ctx = engine();
  ctx.showSnippetPrompt = async () => '';
  await assert.rejects(fragment(ctx, '{{`{{prompt()}}`}}'), { name: 'SnippetPromptCancelled' });
  let clock = 0;
  ctx.performance = { now: () => clock };
  ctx.showSnippetToast = () => { clock += 101; };
  await assert.rejects(fragment(ctx, '{{`{{toast("work", "red")}}`}}', {}, { maxExecutionMs: 100 }), error => error.messageKey === 'err_snippet_timeout');
});

test('fragment converts strings to structured output and preserves existing fragments unchanged', async () => {
  const ctx = engine();
  assert.deepEqual(nodes(await fragment(ctx, '{{fragment("ab{{#1}}cd")}}')), [text('ab'), cursor(1), text('cd')]);
  assert.equal(String(await fragment(ctx, '{{type(fragment(""))}} / {{len(fragment(""))}}')), 'fragment / 0');
  const f = await fragment(ctx, 'ab{{#1}}{{"{{#2}}"}}cd');
  let value;
  await ctx.SnippetScript.execute(ctx.analyze('{{copy(fragment($f))}}', { variables: ['f'] }), { variables: { f }, host: { invoke(request) { value = request.args[0]; return ''; } } });
  assert.equal(value, f, 'already structured fragments must not be serialized and reparsed');
  assert.deepEqual(nodes(await fragment(ctx, '{{fragment($f)}}', { f })), nodes(f));
  assert.deepEqual(nodes(await fragment(ctx, '{{fragment(str(`a{{#1}}b`))}}')), [text('a'), cursor(1), text('b')]);
  assert.deepEqual(nodes(await fragment(ctx, '{{fragment(null)}}{{fragment(undefined)}}{{fragment(42)}}')), [text('42')]);
});

test('fragment solves body syntax with the current variables and keeps changes local', async () => {
  const ctx = engine();
  const args = { source: '{{set $x = 3}}{{for $x}}{{$name}}{{#index}}{{endfor}}', x: 1, name: 'N' };
  assert.deepEqual(nodes(await fragment(ctx, '{{fragment($source)}}:{{$x}}', args)),
    [text('N'), cursor(0), text('N'), cursor(1), text('N'), cursor(2), text(':1')]);
  assert.equal(args.x, 1);
  const snippets = [{ name: 'echo', trigger: '/e ${x}', replacement: '{{$x}}' }];
  assert.deepEqual(nodes(await fragment(ctx, '{{@echo(fragment($source))<2>}}', { source: 'a{{#1}}b' }, { snippets })),
    [text('a'), cursor(3), text('b')]);
  assert.deepEqual(nodes(await fragment(ctx, '{{upper(fragment("a{{#1}}b"))}}')), [text('A'), cursor(1), text('B')]);
});

test('fragment validates arguments and shares cancellation and timeout with the caller', async () => {
  const ctx = engine();
  for (const source of ['{{fragment()}}', '{{fragment(1,2)}}', '{{fragment(,1)}}', '{{fragment(1,)}}']) {
    await assert.rejects(fragment(ctx, source), error => ['err_fn_one_arg_exact', 'err_function_arguments'].includes(error.messageKey), source);
  }
  await assert.rejects(fragment(ctx, '{{fragment($source)}}', { source: '{{if true}}broken' }), error => error.messageKey === 'err_if_unclosed');
  ctx.showSnippetPrompt = async () => '';
  await assert.rejects(fragment(ctx, '{{fragment($source)}}', { source: '{{prompt()}}' }), { name: 'SnippetPromptCancelled' });
  let clock = 0;
  ctx.performance = { now: () => clock };
  ctx.showSnippetToast = () => { clock += 101; };
  await assert.rejects(fragment(ctx, '{{fragment($source)}}', { source: '{{toast("work", "red")}}' }, { maxExecutionMs: 100 }),
    error => error.messageKey === 'err_snippet_timeout');
});

test('bool handles fragments, stored values and snippet call results with the same rules as if', async () => {
  const ctx = engine();
  for (const [source, expected] of [['', false], ['false', false], ['0', false], ['yes', true], ['{{#1}}', true], ['false{{#1}}', true]]) {
    const f = await fragment(ctx, source);
    assert.equal(ctx.evaluateExpression('bool($f)', { f }), expected, source);
    assert.equal(String(await fragment(ctx, '{{bool($f)}}', { f })), String(expected), source);
  }
  assert.equal(String(await fragment(ctx, '{{bool(``)}} / {{bool(`{{#1}}`)}} / {{type(bool(`yes`))}}')), 'false / true / bool');
  const snippets = [{ name: 'value', trigger: '/v ${x}', replacement: '{{$x}}' }];
  assert.equal(String(await fragment(ctx, '{{set $flag = bool(@value("false"))}}{{type($flag)}}:{{$flag}}', {}, { snippets })), 'bool:false');
});
