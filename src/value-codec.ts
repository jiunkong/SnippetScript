import { ScriptValue, StringValue, NumberValue, BoolValue, NullValue, UndefinedValue, ListValue, RangeValue, UNDEFINED, NULL } from './type-system.js';
import { SnippetFragment } from './fragment.js';
import { createSnippetError } from './errors.js';
export type NativeValue = string | number | boolean | null | undefined | SnippetFragment | RangeValue | readonly NativeValue[];
const nativeLists = new WeakMap<ListValue, readonly NativeValue[]>();
const boxedLists = new WeakMap<object, ListValue>();

/** The only conversion entrypoint for native application data. */
export function fromNative(value: unknown): ScriptValue {
    return box(value, new WeakMap(), new WeakSet());
}
function box(value: unknown, seen: WeakMap<object, ScriptValue>, active: WeakSet<object>): ScriptValue {
    if (value instanceof ScriptValue) return value;
    if (value === undefined) return UNDEFINED;
    if (value === null) return NULL;
    if (typeof value === 'string') return new StringValue(value);
    if (typeof value === 'number') {
        if (Number.isNaN(value)) throw createSnippetError('err_number_nan');
        return new NumberValue(value);
    }
    if (typeof value === 'boolean') return new BoolValue(value);
    if (Array.isArray(value)) {
        const existing = boxedLists.get(value) ?? seen.get(value);
        if (existing) return existing;
        if (active.has(value)) throw new TypeError('Cyclic native lists are not script values');
        active.add(value);
        const list = new ListValue(value.map(item => box(item, seen, active)));
        active.delete(value);
        seen.set(value, list);
        return list;
    }
    throw new TypeError('Unsupported native value at the script boundary');
}
/** Native browser/library adapter; fragments and ranges retain their semantics. */
export function toNative(value: ScriptValue): NativeValue {
    if (!(value instanceof ScriptValue)) throw new TypeError('Expected a script value');
    if (value instanceof SnippetFragment || value instanceof RangeValue) return value;
    if (value instanceof ListValue) {
        const cached = nativeLists.get(value);
        if (cached) return cached;
        const items = value.value.map(toNative);
        Object.defineProperty(items, 'toString', { value: () => value.toString() });
        Object.freeze(items);
        nativeLists.set(value, items);
        boxedLists.set(items, value);
        return items;
    }
    if (value instanceof StringValue || value instanceof NumberValue || value instanceof BoolValue || value instanceof NullValue || value instanceof UndefinedValue) return value.value;
    throw new TypeError('Unsupported script value at the native boundary');
}
export function boxVariables(values: Record<string | symbol, unknown>) {
    return Object.fromEntries(Reflect.ownKeys(values).map(key => [key, fromNative(values[key])]));
}

/** Preserve updates to existing host variables without leaking native values into scopes. */
export function writeBackVariables(target: Record<string | symbol, unknown>, scope: Record<string | symbol, ScriptValue>, before?: Record<string | symbol, ScriptValue>): void {
    for (const key of Reflect.ownKeys(target)) {
        if (before && before[key] === scope[key]) continue;
        if (Object.prototype.hasOwnProperty.call(scope, key)) target[key] = target[key] instanceof ScriptValue ? scope[key] : toNative(scope[key]);
    }
}
