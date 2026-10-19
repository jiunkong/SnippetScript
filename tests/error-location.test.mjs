import test from 'node:test';
import assert from 'node:assert/strict';
import { engine } from './helpers/engine.mjs';

async function expectLocation(context, template, marker, options = {}, name = '') {
  const offset = template.lastIndexOf(marker);
  const lines = template.slice(0, offset).split(/\r\n|\r|\n/);
  await assert.rejects(context.processTemplate(template, {}, options), error => {
    assert.equal(error.snippetLocation.offset, offset, template);
    assert.equal(error.snippetLocation.line, lines.length, template);
    assert.equal(error.snippetLocation.column, Array.from(lines.at(-1)).length + 1, template);
    assert.equal(error.snippetLocation.snippetName, name);
    return true;
  });
}

test('runtime error positions refer to original lines and Unicode columns after line continuations', async () => {
  const ctx = engine();
  for (const newline of ['\n', '\r\n', '\r']) {
    const template = ['{{set $x = 1}}\\', '  {{set $x += 1}}\\', '  😊{{2[0]}}'].join(newline);
    await expectLocation(ctx, template, '{{2[0]}}');
  }
  const snippet = { name: 'main', replacement: 'hello\n   {{$missing}}' };
  await expectLocation(ctx, snippet.replacement, '{{$missing}}', { stack: [snippet] }, 'main');
});

test('nested loops and selected if/elif/else bodies preserve offsets even for repeated text', async () => {
  const ctx = engine();
  const templates = [
    '{{for 2}}\n  {{if true}}\n    {{$missing}}\n  {{endif}}{{endfor}}',
    '{{if false}}{{$missing}}{{else}}\n   {{$missing}}{{endif}}',
    '{{if false}}ok{{elif true}}\n   {{$missing}}{{endif}}',
    '{{for 2}}\\\n  {{if true}}\\\n    {{for 2}}\\\n      {{$missing}}{{endfor}}{{endif}}{{endfor}}'
  ];
  for (const template of templates) await expectLocation(ctx, template, '{{$missing}}');
  await expectLocation(ctx, '{{if false}}ok\n{{elif $missing}}bad{{endif}}', '{{elif $missing}}');
});

test('switch case/default bodies and failing case expressions retain their original locations', async () => {
  const ctx = engine();
  for (const template of [
    '{{switch 2}}\n{{case 1}}{{$missing}}{{endcase}}\n{{case 2}}\n  {{$missing}}{{endcase}}{{endswitch}}',
    '{{switch 2}}\n{{case 1}}ok{{endcase}}\n{{default}}\n  {{$missing}}{{enddefault}}{{endswitch}}',
    '{{for 1}}\n{{switch 2}}\n{{case 2}}{{if true}}\n  {{$missing}}{{endif}}{{endcase}}{{endswitch}}{{endfor}}'
  ]) await expectLocation(ctx, template, '{{$missing}}');
  await expectLocation(ctx, '{{switch 2}}\n{{case $missing}}bad{{endcase}}{{endswitch}}', '{{case $missing}}');
});

test('structural errors point to their failing tag or unmatched opening tag', async () => {
  const ctx = engine();
  for (const [template, marker] of [
    ['first\n  {{"unterminated}}', '{{"'], ['first\n  {{}}', '{{}}'],
    ['first\n  {{if true}}body', '{{if true}}'], ['first\n  {{endif}}', '{{endif}}'],
    ['first\n  {{break}}', '{{break}}'], ['first\n  {{$missing', '{{$missing']
  ]) await expectLocation(ctx, template, marker);
});

test('callee locations survive propagation; failed arguments and lookup remain at the caller', async () => {
  const ctx = engine();
  const helper = { name: 'helper', trigger: '/h ${item}', replacement: 'first\n{{for 2}}\n  {{2[0]}}{{endfor}}' };
  const caller = { name: 'caller', replacement: 'caller\n{{@helper("x")}}' };
  await assert.rejects(ctx.processTemplate(caller.replacement, {}, { stack: [caller], snippets: [helper] }), error => {
    assert.equal(error.snippetLocation.snippetName, 'helper');
    assert.equal(error.snippetLocation.line, 3);
    assert.equal(error.snippetLocation.column, 3);
    assert.equal(error.snippetLocation.offset, helper.replacement.indexOf('{{2[0]}}'));
    return true;
  });
  await expectLocation(ctx, 'caller\n  {{@helper($missing)}}', '{{@helper', { stack: [caller], snippets: [helper] }, 'caller');
  await expectLocation(ctx, 'caller\n  {{@unknown()}}', '{{@unknown', { stack: [caller], snippets: [helper] }, 'caller');
});

test('fragment literal errors point into the enclosing source, including nested and escaped literals', async () => {
  const ctx = engine();
  for (const source of [
    'first\n{{`abc\n  {{$missing}}`}}',
    '{{set $f = `a\\`b\n  {{$missing}}`}}',
    '{{`outer {{`inner\n  {{$missing}}`}}`}}',
    '{{for 1}}\\\n  {{`hello\n  {{$missing}}`}}{{endfor}}'
  ]) await expectLocation(ctx, source, '{{$missing}}');
  await expectLocation(ctx, '{{`text {{if true}}bad`}}', '{{if true}}');
});
