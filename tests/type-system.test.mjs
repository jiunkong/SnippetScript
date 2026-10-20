import test from 'node:test';
import assert from 'node:assert/strict';
import { Type, Types, UnionType, ListType, ScriptValue, StringValue, NumberValue, BoolValue, NullValue, UndefinedValue, ListValue, RangeValue, SnippetFragment, fromNative, toNative, analyze, execute, evaluateExpression, FUNCTIONS } from '../dist/index.js';

test('all language values inherit Type and cannot implicitly become native numbers or operands', () => {
  const values = [fromNative('x'),fromNative(2),fromNative(true),fromNative(null),fromNative(undefined),fromNative([1,['x']]),new RangeValue(1,3),new SnippetFragment([{type:'text',value:'x'}])];
  for(const value of values) {
    assert.ok(value instanceof Type);assert.ok(value instanceof ScriptValue);assert.ok(value.descriptor instanceof Type);assert.ok(Object.isFrozen(value));
    assert.throws(()=>value+1, /toNative/);
  }
  assert.ok(values[0] instanceof StringValue);assert.ok(values[1] instanceof NumberValue);assert.ok(values[2] instanceof BoolValue);
  assert.ok(values[3] instanceof NullValue);assert.ok(values[4] instanceof UndefinedValue);assert.ok(values[5] instanceof ListValue);
  assert.ok(values[5].value.every(value=>value instanceof Type));
  assert.equal(values[5].descriptor.format(),'list<number | list<string>>');
  assert.throws(()=>new ListValue([1]),/script values/);
  assert.throws(()=>fromNative({a:1}),/Unsupported/);
  assert.throws(()=>new NumberValue(NaN),error=>error.code==='err_number_nan');
  assert.throws(()=>new RangeValue(1.5,2),error=>error.code==='err_range_integer_bounds');
});

test('union objects flatten, deduplicate, absorb unknown and compare nested list types', () => {
  const union=UnionType.of(Types.number,Types.string,UnionType.of(Types.string,Types.bool));
  assert.ok(union instanceof UnionType);assert.ok(union instanceof Type);assert.ok(Object.isFrozen(union.members));
  assert.equal(union.format(),'string | number | bool');assert.ok(union.accepts(Types.string));assert.equal(union.accepts(Types.null),false);
  assert.equal(UnionType.of(Types.unknown,union),Types.unknown);assert.equal(UnionType.of(Types.never,Types.string),Types.string);
  assert.ok(new ListType(union).accepts(new ListType(Types.string)));assert.equal(new ListType(Types.string).accepts(new ListType(Types.number)),false);
  assert.equal(new ListType(new ListType(union)).format(),'list<list<string | number | bool>>');
});

test('AST, synchronous evaluation and host dispatch carry objects; native conversion stays at boundaries', async () => {
  const analysis=analyze('{{set $n=2}}{{copy(str($n+1))}}{{type($n)}}');
  assert.ok(analysis.template.nodes[0].assignments[0].expression.value instanceof NumberValue);
  const result=evaluateExpression('[1,"x",null,undefined]');assert.ok(result instanceof ListValue);assert.ok(result.value.every(value=>value instanceof ScriptValue));
  assert.deepEqual([...toNative(result)],[1,'x',null,undefined]);
  let copied;
  assert.equal(String(await execute(analysis,{host:{invoke({args}) {assert.ok(args.every(value=>value instanceof ScriptValue));copied=toNative(args[0]);return fromNative(undefined);}}})),'number');
  assert.equal(copied,'3');
  assert.ok(FUNCTIONS.copy.overloads.every(overload=>overload.returnType===Types.undefined));
  assert.ok(FUNCTIONS.upper.overloads.every(overload=>overload.parameters.every(parameter=>parameter.type instanceof Type)));
});

test('branch inference and host return normalization expose Type objects with name views for older hosts', async () => {
  const source='{{set $x=0}}{{if $flag}}{{set $x="text"}}{{else}}{{set $x=2}}{{endif}}{{$x}}';
  const analysis=analyze(source,{variables:['flag']});
  const last=analysis.variableTypes.filter(value=>value.name==='x').at(-1);
  assert.ok(last.type instanceof UnionType);assert.equal(last.type.format(),'string | number');assert.deepEqual(last.types,['string','number']);
  assert.equal(String(await execute(analyze('{{type(copy("x"))}}'),{host:{invoke(){return fromNative(undefined);}}})),'undefined');
  assert.equal(String(await execute(analyze('{{set $x=1}}{{set $x="text"}}{{type($x)}}'))),'string');
});

test('nested list element descriptions survive indexing and generic list builtins', () => {
  const analysis=analyze('{{set $list=[[1]]}}{{set $item=$list[0]}}{{set $edited=insertAt($list,1,["x"])}}{{$item}}{{$edited}}');
  assert.deepEqual(analysis.diagnostics,[]);
  const last=name=>analysis.variableTypes.filter(variable=>variable.name===name).at(-1).type;
  assert.equal(last('item').format(),'list<number> | undefined');
  assert.equal(last('edited').format(),'list<list<number> | list<string>>');
  assert.ok(evaluateExpression('[[1]][0]') instanceof ListValue);
});

test('native variable updates stay at the boundary and unchanged list identities are preserved', async () => {
  const list=[1,2],variables={total:0,list};
  await execute(analyze('{{set $total+=2}}'),{variables});
  assert.equal(variables.total,2);assert.equal(variables.list,list);
  const typed={total:new NumberValue(0)};
  await execute(analyze('{{set $total+=2}}'),{variables:typed});
  assert.ok(typed.total instanceof NumberValue);assert.equal(typed.total.value,2);
  assert.equal(String(await execute(analyze('{{set $x}}{{set $x+=2}}{{$x}}'))),'2');
});

test('hosts can supply object type descriptions without legacy name arrays', () => {
  const analysis=analyze('{{len($items)}}',{variableTypes:{items:new ListType(Types.string)}});
  assert.deepEqual(analysis.diagnostics,[]);
  assert.ok(analysis.variableTypes[0].type instanceof ListType);
  assert.equal(analysis.variableTypes[0].type.format(),'list<string>');
  assert.equal(new UnionType([Types.string,Types.unknown]).format(),'unknown');
});

test('recursive list inference widens deep shapes and unions deduplicate structurally', () => {
  const started=performance.now();
  const analysis=analyze('{{set $a=0,$b=1}}{{for 20}}{{set $a=[$a,$b],$b=[$a,$b]}}{{endfor}}{{$a}}');
  assert.ok(performance.now()-started<2000,'recursive analysis must remain bounded');
  assert.deepEqual(analysis.diagnostics,[]);
  assert.match(analysis.variableTypes.filter(value=>value.name==='a').at(-1).type.format(),/unknown/);
  const first=new ListType(UnionType.of(Types.number,Types.string));
  const second=new ListType(UnionType.of(Types.string,Types.number));
  assert.ok(first.equals(second));assert.equal(UnionType.of(first,second),first);
});

test('boundary codecs preserve shared immutable lists without expanding recursive shapes', () => {
  let value=fromNative(1);
  for(let i=0;i<30;i++)value=new ListValue([value,value]);
  const native=toNative(value);
  assert.equal(native[0],native[1]);assert.equal(fromNative(native),value);
  assert.equal(evaluateExpression('len($x)',{x:value}).value,2);
  const child=[1],shared=fromNative([child,child]);assert.equal(shared.value[0],shared.value[1]);
  child[0]=2;assert.equal(fromNative(child).value[0].value,2,'mutable host arrays are resnapshotted');
  const cyclic=[];cyclic.push(cyclic);assert.throws(()=>fromNative(cyclic),/Cyclic/);
});
