import { ScriptValue, RangeValue, Type } from './type-system.js';
import { fromNative } from './value-codec.js';
import type { ValueType } from './types.js';
export function isRange(value: unknown): value is RangeValue {
    return value instanceof RangeValue && Number.isSafeInteger(value.start) && Number.isSafeInteger(value.end)
        && Number.isSafeInteger(Math.abs(value.end - value.start) + 1);
}
export function typeOf(value: ScriptValue): Type { return value.descriptor; }
/** Name view for compatibility with older hosts; execution uses Type objects. */
export function valueTypeOf(value: unknown): ValueType { return fromNative(value).kind as ValueType; }
