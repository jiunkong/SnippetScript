import * as native from './native-values.js';
import { fromNative, toNative } from './value-codec.js';
import { ScriptValue, ListValue, RangeValue } from './type-system.js';
import type { ExecutionCheck } from './types.js';
export { isRange } from './value-type.js';
export function checkNumberResult<T>(value: T): T { native.checkNumberResult(value instanceof ScriptValue ? toNative(value) : value); return value; }
export function unaryValue(operator: string, value: ScriptValue): ScriptValue { return fromNative(native.unaryValue(operator, toNative(value))); }
export function binaryValue(operator: string, left: ScriptValue, right: ScriptValue, execution?: ExecutionCheck): ScriptValue {
    return fromNative(native.binaryValue(operator, toNative(left), toNative(right), execution));
}
export function createList(values: readonly ScriptValue[]): ListValue { return new ListValue(values); }
export function createRange(start: number, end: number): RangeValue { return native.createRange(start, end); }
export function isSnippetIterable(value: unknown): value is ScriptValue { return value instanceof ScriptValue && ['string','fragment','list','range'].includes(value.kind); }
export function snippetConditionValue(value: ScriptValue): boolean { return native.snippetConditionValue(toNative(value)); }
export function snippetBooleanValue(value: ScriptValue): boolean { return native.snippetBooleanValue(toNative(value)); }
export function indexValue(target: ScriptValue, index: ScriptValue, execution?: ExecutionCheck): ScriptValue {
    return fromNative(native.indexValue(toNative(target), toNative(index), execution));
}
export function snippetValuesEqual(left: ScriptValue, right: ScriptValue, execution?: ExecutionCheck): boolean {
    return native.snippetValuesEqual(toNative(left), toNative(right), execution);
}
export function addSnippetValues(left: ScriptValue, right: ScriptValue): ScriptValue { return binaryValue('+',left,right); }
export function subtractSnippetValues(left: ScriptValue, right: ScriptValue, execution?: ExecutionCheck): ScriptValue { return binaryValue('-',left,right,execution); }
export function multiplySnippetValues(left: ScriptValue, right: ScriptValue, execution?: ExecutionCheck): ScriptValue { return binaryValue('*',left,right,execution); }
