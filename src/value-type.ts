import { SnippetFragment } from './fragment.js';
import type { RangeValue, ValueType } from './types.js';

export function isRange(value: any): value is RangeValue {
    return value !== null && typeof value === 'object' && value.type === 'range'
        && Number.isSafeInteger(value.start) && Number.isSafeInteger(value.end)
        && Number.isSafeInteger(Math.abs(value.end - value.start) + 1);
}

export function valueTypeOf(value: unknown): ValueType {
    if (value === null) return 'null';
    if (value === undefined) return 'undefined';
    if (typeof value === 'boolean') return 'bool';
    if (typeof value === 'number') return 'number';
    if (typeof value === 'string') return 'string';
    if (value instanceof SnippetFragment) return 'fragment';
    if (Array.isArray(value)) return 'list';
    return isRange(value) ? 'range' : 'unknown';
}
