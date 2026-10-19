import type { Environment, ExecutionCheck, RangeValue, Value } from './types.js';
import { createSnippetError } from './errors.js';
import { SnippetFragment, snippetIterableItems, snippetFragmentFromUnits, snippetFragmentMatchAt, snippetFragmentReplace, snippetFragmentSplit } from './fragment.js';
import { defaultEnvironment } from './environment.js';
export function formatDate(date: Date, format: string) {
    const pad = (n: number) => String(n).padStart(2, '0');
    const tokens: Record<string, string | number> = {
        'YYYY': date.getFullYear(),
        'YY': String(date.getFullYear()).slice(-2),
        'MM': pad(date.getMonth() + 1),
        'M': date.getMonth() + 1,
        'DD': pad(date.getDate()),
        'D': date.getDate(),
        'HH': pad(date.getHours()),
        'H': date.getHours(),
        'mm': pad(date.getMinutes()),
        'm': date.getMinutes(),
        'ss': pad(date.getSeconds()),
        's': date.getSeconds(),
        'ddd': date.toLocaleDateString(undefined, { weekday: 'short' }),
        'dddd': date.toLocaleDateString(undefined, { weekday: 'long' })
    };
    return format.replace(/YYYY|YY|MM|M|DD|D|HH|H|mm|m|ss|s|dddd|ddd/g, match => String(tokens[match]));
}
export function callBuiltinFunction(name: string, values: any[], execution?: ExecutionCheck, environment: Environment = defaultEnvironment): any {
    const now = environment.date();
    const pad = (n: number) => String(n).padStart(2, '0');
    const defaultDate = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
    const defaultTime = `${pad(now.getHours())}:${pad(now.getMinutes())}`;
    switch (name) {
        case 'date': {
            const format = values[0];
            return format ? formatDate(now, String(format)) : defaultDate;
        }
        case 'time': {
            const format = values[0];
            return format ? formatDate(now, String(format)) : defaultTime;
        }
        case 'datetime': {
            const format = values[0];
            return format ? formatDate(now, String(format)) : `${defaultDate} ${defaultTime}`;
        }
        case 'uuid': return environment.uuid();
        case 'random': return sampleRandom(values, environment);
        case 'bs':
        case 'backspace': return '\u0008';
        case 'upper':
        case 'lower':
        case 'trim':
        case 'capitalize': {
            const value = values[0];
            if (value instanceof SnippetFragment) {
                if (name === 'trim') {
                    return new SnippetFragment(value.nodes.map((node, i) => {
                        execution?.check();
                        if (node.type === 'cursor')
                            return node;
                        let text = node.value;
                        if (i === 0)
                            text = text.trimStart();
                        if (i === value.nodes.length - 1)
                            text = text.trimEnd();
                        return { type: 'text', value: text };
                    }));
                }
                let first = true;
                return new SnippetFragment(value.nodes.map(node => {
                    execution?.check();
                    if (node.type === 'cursor')
                        return node;
                    const text = name === 'upper' ? node.value.toUpperCase() : name === 'lower' ? node.value.toLowerCase()
                        : first ? String.fromCodePoint(node.value.codePointAt(0)!).toUpperCase() + node.value.slice(node.value.codePointAt(0)! > 0xffff ? 2 : 1) : node.value;
                    first = false;
                    return { type: 'text', value: text };
                }));
            }
            const s = String(value || '');
            if (name === 'upper')
                return s.toUpperCase();
            if (name === 'lower')
                return s.toLowerCase();
            if (name === 'trim')
                return s.trim();
            return s.charAt(0).toUpperCase() + s.slice(1);
        }
        case 'substr': {
            const items = values;
            if (items[0] instanceof SnippetFragment) {
                const units = snippetIterableItems(items[0], execution);
                // Match substr's start/count coercion, but count Unicode characters and
                // cursor nodes as complete units instead of slicing serialized syntax.
                const integer = (value: unknown) => { const n = Number(value); return Number.isNaN(n) ? 0 : Math.trunc(n); };
                const rawStart = integer(items[1]);
                const start = rawStart < 0 ? Math.max(0, units.length + rawStart) : Math.min(rawStart, units.length);
                const count = items[2] === undefined ? units.length : Math.max(0, integer(items[2]));
                return snippetFragmentFromUnits(units.slice(start, start + count));
            }
            return String(items[0] || '').substr(items[1] || 0, items[2]);
        }
        case 'startswith':
        case 'endswith': {
            const items = values;
            if (items[0] instanceof SnippetFragment || items[1] instanceof SnippetFragment) {
                const units = snippetIterableItems(SnippetFragment.from(items[0]), execution);
                const search = snippetIterableItems(SnippetFragment.from(items[1]), execution);
                return snippetFragmentMatchAt(units, search, name === 'startswith' ? 0 : units.length - search.length, execution);
            }
            const value = String(items[0] ?? '');
            const search = String(items[1] ?? '');
            return name === 'startswith' ? value.startsWith(search) : value.endsWith(search);
        }
        case 'replace': {
            const items = values;
            if (items.some(item => item instanceof SnippetFragment))
                return snippetFragmentReplace(SnippetFragment.from(items[0]), items[1] ?? '', items[2] ?? '', execution);
            return String(items[0] || '').replace(items[1] || '', items[2] || '');
        }
        case 'includes': {
            const target = values[0];
            const value = values[1];
            if (!isSnippetIterable(target))
                throw createSnippetError('err_includes_iterable_target');
            if (isRange(target)) {
                return Number.isSafeInteger(value) && value >= Math.min(target.start, target.end)
                    && value <= Math.max(target.start, target.end);
            }
            if (Array.isArray(target))
                return target.some(item => snippetValuesEqual(item, value, execution));
            if (typeof target === 'string' && !(value instanceof SnippetFragment))
                return target.includes(String(value ?? ''));
            const search = snippetIterableItems(SnippetFragment.from(value), execution);
            if (!search.length)
                return true;
            const units = snippetIterableItems(SnippetFragment.from(target), execution);
            for (let i = 0; i <= units.length - search.length; i++) {
                execution?.check();
                if (snippetFragmentMatchAt(units, search, i, execution))
                    return true;
            }
            return false;
        }
        case 'len': {
            const value = values[0];
            if (isRange(value))
                return Math.abs(value.end - value.start) + 1;
            if (value instanceof SnippetFragment)
                return value.getLength(execution);
            return Array.isArray(value) ? value.length : Array.from(String(value || '')).length;
        }
        case 'split': {
            const value = values[0];
            const separator = values[1];
            if (value instanceof SnippetFragment || separator instanceof SnippetFragment)
                return createList(snippetFragmentSplit(SnippetFragment.from(value), separator ?? '', execution));
            return createList(String(value ?? '').split(String(separator ?? '')));
        }
        case 'join': {
            const value = values[0];
            const separator = values[1];
            if (!Array.isArray(value))
                throw createSnippetError('err_join_list_required');
            if (separator instanceof SnippetFragment || value.some(item => item instanceof SnippetFragment)) {
                const units: any[] = [];
                value.forEach((item, i) => {
                    execution?.check();
                    if (i)
                        units.push(separator);
                    units.push(item);
                });
                return snippetFragmentFromUnits(units);
            }
            return value.join(String(separator ?? ''));
        }
        case 'insertAt':
        case 'removeAt': {
            let target = values[0];
            if (isRange(target))
                throw createSnippetError('err_readonly_iterable', [name]);
            if (!isSnippetIterable(target))
                throw createSnippetError('err_iterable_function_target', [name]);
            const index = values[1];
            if (!Number.isSafeInteger(index))
                throw createSnippetError('err_list_index_integer');
            const inserted = name === 'insertAt' ? values[2] : undefined;
            if (typeof target === 'string' && inserted instanceof SnippetFragment)
                target = SnippetFragment.from(target);
            const result = snippetIterableItems(target, execution);
            const length = result.length;
            const position = index < 0 ? length + index : index;
            if (name === 'insertAt') {
                const value = inserted;
                if (position >= 0 && position <= length)
                    result.splice(position, 0, typeof target === 'string' ? String(value ?? '') : value);
            }
            else if (position >= 0 && position < length)
                result.splice(position, 1);
            return target instanceof SnippetFragment ? snippetFragmentFromUnits(result)
                : typeof target === 'string' ? result.join('') : createList(result);
        }
        case 'str': return String(values[0] ?? '');
        case 'bool': return snippetConditionValue(values[0]);
        case 'isCursor': {
            const value = values[0];
            return value instanceof SnippetFragment && value.nodes.length === 1 && value.nodes[0].type === 'cursor';
        }
        case 'hasCursor': {
            const value = values[0];
            return value instanceof SnippetFragment && value.nodes.some(node => {
                execution?.check();
                return node.type === 'cursor';
            });
        }
        case 'type': {
            const value = values[0];
            if (value === null)
                return 'null';
            if (typeof value === 'boolean')
                return 'bool';
            if (value instanceof SnippetFragment)
                return 'fragment';
            if (Array.isArray(value))
                return 'list';
            return isRange(value) ? 'range' : typeof value;
        }
        case 'num': {
            const v = Number(values[0]);
            return isNaN(v) ? 0 : v;
        }
        case 'int': {
            const v = parseInt(String(values[0]));
            return isNaN(v) ? 0 : v;
        }
        case 'round': {
            const v = Number(values[0]);
            return isNaN(v) ? 0 : Math.round(v);
        }
        case 'ceil': {
            const v = Number(values[0]);
            return isNaN(v) ? 0 : Math.ceil(v);
        }
        case 'floor': {
            const v = Number(values[0]);
            return isNaN(v) ? 0 : Math.floor(v);
        }
        case 'min': {
            const vals = values.map(value => Number(value)).filter(n => !isNaN(n));
            return vals.length ? Math.min(...vals) : 0;
        }
        case 'max': {
            const vals = values.map(value => Number(value)).filter(n => !isNaN(n));
            return vals.length ? Math.max(...vals) : 0;
        }
        default: throw createSnippetError('err_unknown_function', [name]);
    }
}
export function isRange(value: any): value is RangeValue {
    return value !== null && typeof value === 'object' && value.type === 'range'
        && Number.isSafeInteger(value.start) && Number.isSafeInteger(value.end)
        && Number.isSafeInteger(Math.abs(value.end - value.start) + 1);
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
    return left + right;
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
    return left * right;
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
    return left - right;
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
export function sampleRandom(values: readonly Value[], environment: Environment) {
    const evaluated = values.map(value => isRange(value) ? Math.min(value.start, value.end) + Math.floor(environment.random() * (Math.abs(value.end - value.start) + 1)) : value);
    return evaluated.length === 1 ? evaluated[0] : evaluated[Math.floor(environment.random() * evaluated.length)];
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
        case '/': return left / right;
        case '%': return left % right;
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
