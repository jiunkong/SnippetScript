import test from 'node:test';
import assert from 'node:assert/strict';
import { analyze, execute } from '../dist/index.js';

const output = async (source, options = {}) => {
    const analysis = analyze(source, { library: options.library });
    assert.deepEqual(analysis.diagnostics.filter(d => d.severity === 'error'), []);
    return String(await execute(analysis, options));
};

for (const newline of ['\n', '\r\n', '\r']) {
    test(`compact strips source newlines and horizontal indentation (${JSON.stringify(newline)})`, async () => {
        const source = ['before', '{{compact}}', '  Hello, world!', '\tAgain.', '  {{endcompact}}', 'after'].join(newline);
        assert.equal(await output(source), `before${newline}Hello, world!Again.${newline}after`);
        assert.equal(await output(`{{compact}}  same line \t spaces  ${newline}\t next{{endcompact}}`), '  same line \t spaces  next');
    });
}

test('compact retains normal whitespace outside the block and compacts blank lines', async () => {
    assert.equal(await output(' A\n  {{compact}}\n \t\n\tB C\n\n{{endcompact}}\n  D '), ' A\n  B C\n  D ');
    assert.equal(await output('A{{compact}}{{endcompact}}B'), 'AB');
});

test('compact is transparent to assignments, nested conditionals, loops and loop control', async () => {
    const source = `{{compact}}
      {{set $result = ''}}
      {{for 4}}
        {{if index == 1}}{{continue}}{{endif}}
        {{if index == 3}}{{break}}{{endif}}
        {{set $result += str(index)}}
      {{endfor}}
      Result: {{$result}}
    {{endcompact}}/{{$result}}`;
    assert.equal(await output(source), 'Result: 02/02');
    assert.equal(await output('{{for 2}}{{compact}}\n  {{index}}\n{{endcompact}}{{endfor}}'), '01');
    assert.equal(await output('{{compact}}\n{{switch "x"}}{{case "x"}}\n  X\n{{endcase}}{{default}}\n  Y\n{{enddefault}}{{endswitch}}\n{{endcompact}}'), 'X');
});

test('nested compact blocks share formatting and variable scope without changing the outer text', async () => {
    assert.equal(await output('{{compact}}\n A{{compact}}\n  {{set $x = "B"}}{{$x}}\n{{endcompact}}\n C\n{{endcompact}}\n{{$x}}'), 'ABC\nB');
    const analysis = analyze('{{if true}}{{compact}}{{set $inner=1}}{{endcompact}}{{endif}}{{$inner}}');
    assert.ok(analysis.diagnostics.some(d => d.code === 'err_undefined_variable'));
});

test('compact preserves newlines from evaluated strings, fragment literals and snippet calls', async () => {
    const library = [{ name: 'helper', trigger: '', replacement: 'helper\n  text{{#2}}' }];
    const source = '{{compact}}\n  {{"string\\n  text"}}\n  {{`fragment\n  text{{#1}}`}}\n  {{@helper()}}\n  {{#0}}\n{{endcompact}}';
    assert.equal(await output(source, { library }), 'string\n  textfragment\n  text{{#1}}helper\n  text{{#2}}{{#0}}');
    assert.equal(await output('{{`{{compact}}\n A\n B\n{{endcompact}}`}}'), 'AB');
});

test('compact markers are keywords and diagnostics retain original UTF-16 source ranges', () => {
    const source = '😀{{compact}}\r\n\t{{set $x = 1}}\r\n  {{$missing}}\r\n{{endcompact}}';
    const analysis = analyze(source);
    assert.deepEqual(analysis.tokens.filter(t => t.kind === 'keyword').map(t => source.slice(t.start, t.end)), ['compact', 'set', 'endcompact']);
    const diagnostic = analysis.diagnostics.find(d => d.code === 'err_undefined_variable');
    assert.equal(source.slice(diagnostic.range.start, diagnostic.range.end), '$missing');
    assert.equal(diagnostic.range.start, source.indexOf('$missing'));
    const reference = analysis.variableTypes.find(v => source.slice(v.range.start, v.range.end) === '$x');
    assert.deepEqual(reference.types, ['number']);
});

for (const [source, code, marker] of [
    ['{{endcompact}}', 'err_endcompact_no_compact', '{{endcompact}}'],
    ['{{compact}}text', 'err_compact_unclosed', '{{compact}}'],
    ['{{compact true}}', 'err_template_syntax', '{{compact true}}'],
    ['{{compact}}{{endcompact true}}', 'err_template_syntax', '{{endcompact true}}'],
    ['{{compact}}{{if true}}{{endcompact}}', 'err_endcompact_no_compact', '{{endcompact}}'],
    ['{{compact}}{{for 2}}{{endif}}{{endfor}}{{endcompact}}', 'err_endif_no_if', '{{endif}}'],
]) {
    test(`compact rejects malformed nesting or arguments: ${source}`, async () => {
        const analysis = analyze(source);
        const diagnostic = analysis.diagnostics.find(d => d.code === code);
        assert.ok(diagnostic);
        assert.equal(source.slice(diagnostic.range.start, diagnostic.range.end), marker);
        await assert.rejects(execute(analysis));
    });
}

test('compact text regions cover original literal source without nested layers or tag contents', () => {
    const source = 'outside{{compact}}\\\r\n  A{{if true}}\n  B{{endif}}{{compact}}\n C{{endcompact}}\n{{endcompact}}outside';
    const analysis = analyze(source);
    assert.deepEqual(analysis.diagnostics, []);
    const regions = analysis.regions.filter(region => region.kind === 'compactText');
    assert.deepEqual(regions.map(region => source.slice(region.start, region.end)), ['\\\r\n  A', '\n  B', '\n C', '\n']);
    for (let i = 1; i < regions.length; i++) assert.ok(regions[i - 1].end <= regions[i].start);
    assert.ok(regions.every(region => Object.isFrozen(region)));
});

test('unfinished compact text retains source coverage even if continuation normalization removes it all', () => {
    const source = '{{compact}}\\\n  ';
    const analysis = analyze(source);
    assert.deepEqual(analysis.regions.filter(region => region.kind === 'compactText'), [
        { start: '{{compact}}'.length, end: source.length, kind: 'compactText' }
    ]);
    assert.ok(analysis.diagnostics.some(diagnostic => diagnostic.code === 'err_compact_unclosed'));
    // An unfinished tag owns the remaining source, including continuations.
    const unfinishedTag = analyze('{{compact}}{{"unfinished\\\n  ');
    assert.deepEqual(unfinishedTag.regions.filter(region => region.kind === 'compactText'), []);
});
