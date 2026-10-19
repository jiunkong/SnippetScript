import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  analyze, analyzeTrigger, execute, processTemplate, prepareSnippetTemplate,
  SnippetFragment, SnippetTemplate, SnippetError, defaultEnvironment,
} from '../dist/index.js';
const output = async (source, options = {}) => String(await execute(analyze(source, { checkVariables: false }), options));

test('analysis owns an immutable expression AST used directly for repeatable execution', async () => {
  const analysis = analyze('{{set $a=2}}{{for $a}}{{upper("x")}}{{#index}}{{endfor}}');
  assert.deepEqual(analysis.diagnostics, []);
  const expression = analysis.template.nodes[1].body.nodes[0].expression;
  assert.equal(expression.kind, 'call');
  assert.equal(typeof expression.args[0], 'object');
  assert.ok(Object.isFrozen(expression.args));
  assert.ok(Object.isFrozen(analysis.template.nodes[1].body.nodes));
  assert.throws(() => { expression.name = 'lower'; }, TypeError);
  assert.equal(String(await execute(analysis)), 'X{{#0}}X{{#1}}');
  assert.equal(String(await execute(analysis)), 'X{{#0}}X{{#1}}');
  assert.equal(analysis.template.nodes[1].body.nodes[0].expression, expression);
});

test('token categories carry source ranges without presentation or string/number categories', () => {
  const source = 'outside true {{true}} {{false}} {{null}} {{"true false null"}} {{42}}';
  const analysis = analyze(source);
  assert.deepEqual(analysis.tokens.filter(token => ['bool','null'].includes(token.kind)).map(token => [token.kind,source.slice(token.start,token.end)]), [['bool','true'],['bool','false'],['null','null']]);
  for(const token of analysis.tokens) {
    assert.deepEqual(Object.keys(token).sort(), ['end','kind','start']);
    assert.ok(token.start >= 0 && token.end <= source.length);
  }
});

test('analyzer recovers after a bad tag and retains later tokens and references', () => {
  const source = '{{1+}} text {{upper("x")}} {{@"hello world"()}}';
  const analysis = analyze(source, { library:[{id:'helper',name:'hello world',trigger:''}] });
  assert.equal(analysis.diagnostics[0].severity, 'error');
  assert.equal(analysis.diagnostics[0].code, 'err_missing_operand');
  assert.ok(analysis.tokens.some(token => token.kind === 'function' && source.slice(token.start,token.end) === 'upper('));
  assert.equal(analysis.references[0].targetId, 'helper');
  assert.equal(source.slice(analysis.references[0].start,analysis.references[0].end), '@"hello world"');
});

test('diagnostics use original UTF-16 ranges inside escaped nested fragments', () => {
  const source = '😀\\\n  {{`a\\`b {{`{{$missing}}`}}`}}';
  const analysis = analyze(source);
  const diagnostic = analysis.diagnostics.find(item => item.code === 'err_undefined_variable');
  assert.equal(source.slice(diagnostic.range.start,diagnostic.range.end), '$missing');
  assert.equal(diagnostic.range.start,source.indexOf('$missing'));
});

test('variables are checked in lexical scopes without leaking fragment or block declarations', () => {
  for(const source of ['{{if true}}{{set $x=1}}{{endif}}{{$x}}', '{{`{{set $x=1}}`}}{{$x}}']) {
    assert.equal(analyze(source).diagnostics.at(-1).code,'err_undefined_variable');
  }
  assert.deepEqual(analyze('{{set $a=1,$b=$a+1}}{{$b}}').diagnostics,[]);
  assert.deepEqual(analyze('{{for 2}}{{`{{index}}{{value}}`}}{{endfor}}').diagnostics,[]);
  assert.equal(analyze('{{for 2}}{{`{{break}}`}}{{endfor}}').diagnostics[0].code,'err_loop_control_outside_for');
});

test('library signature changes alter validation and duplicate names are rejected', () => {
  const library = [{id:'one',name:'helper',trigger:'${x}',replacement:'{{$x}}'}];
  assert.deepEqual(analyze('{{@helper(1)}}',{library}).diagnostics,[]);
  library[0].trigger='${x} ${y}';
  assert.equal(analyze('{{@helper(1)}}',{library}).diagnostics[0].code,'err_snippet_call_args');
  library.push({...library[0],id:'two'});
  assert.equal(analyze('{{@helper(1)}}',{library}).diagnostics[0].code,'err_snippet_call_target');
});

test('host calls receive evaluated typed arguments and the original call range', async () => {
  const source = '😀{{copy(`a{{#1}}`)}}{{url()}}';
  const calls=[];
  const result=await execute(analyze(source),{host:{invoke(request,{signal}) {
    assert.equal(signal.aborted,false); calls.push(request);
    return request.name==='url'?'https://example.test/':'';
  }}});
  assert.equal(String(result),'😀https://example.test/');
  assert.ok(calls[0].args[0] instanceof SnippetFragment);
  assert.equal(source.slice(calls[0].sourceRange.start,calls[0].sourceRange.end),'copy(`a{{#1}}`)');
});

test('short-circuiting skips host calls, snippet calls, literals and pure function work', async () => {
  let count=0;
  const host={invoke(){count++;throw new Error('must not run');}};
  const library=[{name:'ask',replacement:'{{prompt()}}'}];
  const environment={random(){count++;return 0;}};
  for(const [source,expected] of [
    ['{{false && prompt()}}','false'],['{{true || @ask()}}','true'],
    ['{{true ? "yes" : `{{prompt()}}`}}','yes'],['{{false ? copy("x") : "no"}}','no'],
    ['{{true || random(1~2)}}','true'],['{{false && upper(prompt())}}','false'],
  ]) assert.equal(await output(source,{host,library,environment}),expected);
  assert.equal(count,0);
});

test('host returns are inert values and unsupported capabilities fail at the call', async () => {
  assert.equal(await output('{{paste()}}',{host:{invoke(){return '{{#1}}{{prompt()}}';}}}),'{{#1}}{{prompt()}}');
  const fragment=await execute(analyze('{{paste()}}'),{host:{invoke(){return '{{#1}}';}}});
  assert.deepEqual(fragment.nodes,[{type:'text',value:'{{#1}}'}]);
  await assert.rejects(execute(analyze('{{url()}}')),error=>error.code==='err_host_function_unavailable');
});

test('a fragment cast preserves an existing fragment identity', async () => {
  const fragment = new SnippetFragment([{type:'text',value:'a'},{type:'cursor',level:2}]);
  let argument;
  await execute(analyze('{{copy(fragment($f))}}',{variables:['f']}),{variables:{f:fragment},host:{invoke({args}){argument=args[0];return '';}}});
  assert.equal(argument,fragment);
  assert.equal(await output('{{fragment("a{{#2}}b")}}'),'a{{#2}}b');
});

test('fragment indexing and loops count Unicode characters and actual cursors', async () => {
  assert.equal(await output('{{set $f=`a😀{{#2}}b`}}{{len($f)}}:{{type($f[1])}}:{{isCursor($f[2])}}:{{for $f}}{{hasCursor(value)}}{{endfor}}'),'4:fragment:true:falsefalsetruefalse');
  assert.equal(await output('{{includes("abcd","bc")}}/{{includes(`a{{#1}}b`,`{{#1}}`)}}/{{includes(`a{{#1}}b`,"{{#1}}")}}'),'true/true/false');
});

test('output and quoted cursor syntax are never reparsed', async () => {
  const library=[{name:'echo',trigger:'${x}',replacement:'{{$x}}'}];
  const result=await execute(analyze('{{@echo("{{#1}}")}}',{library}),{library});
  assert.deepEqual(result.nodes,[{type:'text',value:'{{#1}}'}]);
});

test('snippet compilation caches successful and invalid sources independently', async () => {
  const snippet={name:'one',replacement:'old{{#1}}'},broken={name:'bad',replacement:'{{if true}}'};
  const entry=prepareSnippetTemplate(snippet);
  assert.equal(prepareSnippetTemplate(snippet),entry);
  assert.ok(prepareSnippetTemplate(broken).error);
  assert.equal(String(await processTemplate(snippet)),'old{{#1}}');
  snippet.replacement='new{{#2}}';
  assert.notEqual(prepareSnippetTemplate(snippet).template,entry.template);
  assert.equal(String(await processTemplate(entry.template)),'old{{#1}}');
});

test('recursion limits include calls nested in arguments', async () => {
  const library=[{name:'echo',trigger:'${x}',replacement:'{{$x}}'}];
  await assert.rejects(execute(analyze('{{@echo(@echo("x"))}}',{library}),{library,limits:{maxCallDepth:1}}),error=>error.code==='err_snippet_call_depth');
  assert.equal(await output('{{@echo(@echo("x"))}}',{library,limits:{maxCallDepth:2}}),'x');
});

test('prompt waiting is excluded from a shared budget while subsequent computation is counted', async () => {
  let clock=0;
  const host={invoke({name}) {if(name==='prompt'){clock+=10000;return 'answer';}clock+=101;return '';}};
  assert.equal(await output('{{prompt()}}',{host,environment:{now:()=>clock},limits:{timeoutMs:100}}),'answer');
  await assert.rejects(output('{{prompt()}}{{toast("work","red")}}',{host,environment:{now:()=>clock},limits:{timeoutMs:100}}),error=>error.code==='err_snippet_timeout');
});

test('a stalled host operation times out, receives abort, and never resumes execution', async () => {
  let aborted=false, calls=0;
  const host={invoke(_request,{signal}) {calls++;signal.addEventListener('abort',()=>{aborted=true;});return new Promise(()=>{});}};
  await assert.rejects(output('{{paste()}}{{toast("late","red")}}',{host,limits:{timeoutMs:100}}),error=>error.code==='err_snippet_timeout');
  assert.equal(aborted,true);assert.equal(calls,1);
});

test('external cancellation interrupts a user-input wait and ignores late results', async () => {
  const controller=new AbortController(); let resolveHost, calls=0, hostSignal;
  const running=output('{{prompt()}}{{toast("late","red")}}',{signal:controller.signal,host:{invoke(_request,{signal}) {calls++;hostSignal=signal;return new Promise(resolve=>{resolveHost=resolve;});}}});
  await new Promise(resolve=>setTimeout(resolve,0)); controller.abort();
  await assert.rejects(running,error=>error.code==='err_snippet_cancelled');
  assert.equal(hostSignal.aborted,true);resolveHost('late');await new Promise(resolve=>setTimeout(resolve,0));assert.equal(calls,1);
});

test('empty or dismissed input aborts the entire expansion', async () => {
  for(const value of ['',null,undefined])await assert.rejects(output('before{{prompt()}}after',{host:{invoke(){return value;}}}),{name:'SnippetPromptCancelled'});
});

test('runtime errors retain the callee source location and a structured call trace', async () => {
  const library=[{name:'helper',replacement:'first\n  {{$missing}}'}];
  await assert.rejects(output('call{{@helper()}}',{library}),error=>{
    assert.equal(error.code,'err_undefined_variable');assert.equal(error.snippetLocation.snippetName,'helper');
    assert.equal(error.snippetLocation.line,2);assert.equal(error.snippetLocation.column,3);assert.deepEqual(error.callTrace,['helper']);return true;
  });
});

test('invalid analysis is rejected before effects and future warnings do not block execution', async () => {
  let calls=0;
  await assert.rejects(execute(analyze('{{paste(1)}}'),{host:{invoke(){calls++;return '';}}}));
  assert.equal(calls,0);
  const valid=analyze('ok');
  const withWarning={...valid,diagnostics:[{code:'future_warning',args:[],severity:'warning',range:{start:0,end:2}}]};
  assert.equal(String(await execute(withWarning)),'ok');
});

test('trigger analysis exposes semantic tokens and accepts the default capture regex', () => {
  const source='/hello ${name:[a-z]+:i}';
  const analysis=analyzeTrigger(source);
  assert.equal(source.slice(analysis.tokens.find(token=>token.kind==='regex').start,analysis.tokens.find(token=>token.kind==='regex').end),'[a-z]+');
  assert.ok(analysis.tokens.some(token=>token.kind==='regexFlag'));
  assert.deepEqual(analyzeTrigger('${name}').diagnostics,[]);
});

test('compiled core modules have no extension or DOM dependencies', async () => {
  for(const name of ['analyzer','runtime','fragment','values','functions','scanner','errors','environment']) {
    const source=await readFile(new URL(`../dist/${name}.js`,import.meta.url),'utf8');
    assert.doesNotMatch(source,/\b(?:window|document|navigator|chrome)\s*\./);
    assert.doesNotMatch(source,/\beval\s*\(|new\s+Function\s*\(/);
  }
});
