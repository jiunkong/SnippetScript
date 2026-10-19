import { isRange } from './value-type.js';
export { isRange } from './value-type.js';
import type { ExecutionCheck, RangeValue, Value } from './types.js';
import { createSnippetError } from './errors.js';
import { SnippetFragment, snippetIterableItems } from './fragment.js';

export function checkNumberResult<T>(value: T): T {
    if (Number.isNaN(value)) throw createSnippetError('err_number_nan');
    return value;
}

export function unaryValue(operator: string, value: any): number {
    return checkNumberResult(operator === '-' ? -value : +value);
}
export function createRange(start: number, end: number): RangeValue {
    const range = { type: 'range' as const, start, end };
    if (!isRange(range)) {
        throw createSnippetError('err_range_integer_bounds', [], 'Range endpoints must be safe integers.');
    }
    Object.defineProperty(range, 'toString', { value: () => `${start}~${end}` });
    return Object.freeze(range);
}
export function isSnippetIterable(value: unknown) {
    return typeof value === 'string' || Array.isArray(value) || isRange(value) || value instanceof SnippetFragment;
}
export function addSnippetValues(left: any, right: any): any {
    if (Array.isArray(left) || Array.isArray(right)) {
        if (!Array.isArray(left) || !Array.isArray(right))
            throw createSnippetError('err_list_concat_types');
        return createList([...left, ...right]);
    }
    if (left instanceof SnippetFragment || right instanceof SnippetFragment) {
        return SnippetFragment.from(left).concat(right);
    }
    return checkNumberResult(left + right);
}
export function multiplySnippetValues(left: any, right: any, execution?: ExecutionCheck): any {
    if (left instanceof SnippetFragment || right instanceof SnippetFragment) {
        const fragment = left instanceof SnippetFragment ? left : right;
        const count = left instanceof SnippetFragment ? right : left;
        if (typeof count !== 'number' || !Number.isSafeInteger(count) || count < 0)
            throw createSnippetError('err_string_repeat_count');
        // Use the same allocation limit as string repetition before building nodes.
        try {
            fragment.toString().repeat(count);
        }
        catch (error) {
            if (error instanceof RangeError)
                throw createSnippetError('err_string_repeat_size');
            throw error;
        }
        const nodes: any[] = [];
        if (fragment.nodes.length)
            for (let i = 0; i < count; i++) {
                execution?.check();
                for (const node of fragment.nodes)
                    nodes.push(node);
            }
        return new SnippetFragment(nodes);
    }
    if (typeof left === 'string' || typeof right === 'string') {
        const text = typeof left === 'string' ? left : right;
        const count = typeof left === 'string' ? right : left;
        if (typeof count !== 'number' || !Number.isSafeInteger(count) || count < 0) {
            throw createSnippetError('err_string_repeat_count');
        }
        try {
            return text.repeat(count);
        }
        catch (error) {
            if (error instanceof RangeError)
                throw createSnippetError('err_string_repeat_size');
            throw error;
        }
    }
    return checkNumberResult(left * right);
}
export function snippetValuesEqual(left: any, right: any, execution?: ExecutionCheck): boolean {
    execution?.check();
    if (left instanceof SnippetFragment && right instanceof SnippetFragment) {
        return left.nodes.length === right.nodes.length && left.nodes.every((node, i) => {
            execution?.check();
            const other: any = right.nodes[i];
            return node.type === other.type && (node.type === 'text' ? node.value === other.value : node.level === other.level);
        });
    }
    if (Array.isArray(left) && Array.isArray(right)) {
        return left.length === right.length && left.every((value, i) => snippetValuesEqual(value, right[i], execution));
    }
    if (isRange(left) && isRange(right))
        return left.start === right.start && left.end === right.end;
    return Object.is(left, right) || left === right;
}
export function subtractSnippetValues(left: any, right: any, execution?: ExecutionCheck): any {
    if (Array.isArray(left) || Array.isArray(right)) {
        if (!Array.isArray(left) || !Array.isArray(right))
            throw createSnippetError('err_list_subtract_types');
        return createList(left.filter(value => {
            execution?.check();
            return !right.some(removed => snippetValuesEqual(value, removed, execution));
        }));
    }
    return checkNumberResult(left - right);
}
export function createList(values: readonly Value[]) {
    const list = [...values];
    Object.defineProperty(list, 'toString', { value: () => `[${list.map(value => typeof value === 'string' ? JSON.stringify(value) : String(value)).join(',')}]`
    });
    return Object.freeze(list);
}
export function snippetConditionValue(value: unknown) {
    if (value instanceof SnippetFragment)
        value = String(value);
    return !!value && value !== 'false' && value !== '0';
}
export function snippetBooleanValue(value: unknown) {
    return value instanceof SnippetFragment ? value.nodes.length > 0 : !!value;
}
export function indexValue(target: any, index: any, execution?: any): any {
    if (!isSnippetIterable(target))
        throw createSnippetError('err_list_index_target');
    if (typeof index !== 'number' || !Number.isSafeInteger(index))
        throw createSnippetError('err_list_index_integer');
    if (isRange(target)) {
        const distance = Math.abs(target.end - target.start), step = target.end < target.start ? -1 : 1;
        return (index < 0 ? -index - 1 : index) <= distance ? index < 0 ? target.end + (index + 1) * step : target.start + index * step : undefined;
    }
    const items = snippetIterableItems(target, execution), position = index < 0 ? items.length + index : index;
    return position >= 0 && position < items.length ? items[position] : undefined;
}
export function binaryValue(operator: string, left: any, right: any, execution?: any): any {
    switch (operator) {
        case '+': return addSnippetValues(left, right);
        case '-': return subtractSnippetValues(left, right, execution);
        case '*': return multiplySnippetValues(left, right, execution);
        case '/': return checkNumberResult(left / right);
        case '%': return checkNumberResult(left % right);
        case '~': return createRange(left, right);
        case '==': return left instanceof SnippetFragment && right instanceof SnippetFragment ? snippetValuesEqual(left, right, execution) : left == right;
        case '!=': return left instanceof SnippetFragment && right instanceof SnippetFragment ? !snippetValuesEqual(left, right, execution) : left != right;
        case '<': return left < right;
        case '>': return left > right;
        case '<=': return left <= right;
        case '>=': return left >= right;
        default: throw createSnippetError('err_unknown_tag', [operator]);
    }
}
