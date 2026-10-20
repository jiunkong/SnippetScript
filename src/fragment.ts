import type { ExecutionCheck } from './types.js';
import { ScriptValue, Types } from './type-system.js';
import { createSnippetError } from './errors.js';
export type FragmentNode = {
    readonly type: 'text';
    readonly value: string;
} | {
    readonly type: 'cursor';
    readonly level: number;
};
// Evaluated output. Text is always data; only cursor nodes become tab stops.
// Converting to a string is deliberately lossy: cursor syntax becomes text.
export class SnippetFragment extends ScriptValue<readonly FragmentNode[]> {
    readonly kind = 'fragment';
    readonly descriptor = Types.fragment;
    get value() { return this.nodes; }
    readonly nodes: readonly FragmentNode[];
    constructor(nodes: readonly FragmentNode[] = []) {
        super();
        const normalized: any[] = [];
        for (const node of nodes) {
            if (node.type === 'text') {
                if (!node.value)
                    continue;
                const previous = normalized[normalized.length - 1];
                if (previous?.type === 'text')
                    previous.value += node.value;
                else
                    normalized.push({ type: 'text', value: node.value });
            }
            else if (node.type === 'cursor') {
                if (!Number.isSafeInteger(node.level) || node.level < 0)
                    throw createSnippetError('err_cursor_level');
                normalized.push({ type: 'cursor', level: node.level });
            }
            else
                throw new TypeError('Invalid SnippetFragment node');
        }
        this.nodes = Object.freeze(normalized.map(node => Object.freeze(node)));
        Object.freeze(this);
    }
    static from(value: unknown) {
        return value instanceof SnippetFragment ? value
            : new SnippetFragment([{ type: 'text', value: value instanceof ScriptValue ? value.toString() : String(value ?? '') }]);
    }
    toString() {
        return this.nodes.map(node => node.type === 'text' ? node.value : `{{#${node.level}}}`).join('');
    }
    get length() {
        return this.getLength();
    }
    getLength(execution?: {
        check(): void;
    }) {
        let length = 0;
        for (const node of this.nodes) {
            if (node.type === 'text') {
                for (const char of node.value) {
                    execution?.check();
                    length++;
                }
            }
            else {
                execution?.check();
                length++;
            }
        }
        return length;
    }
    [Symbol.iterator]() {
        return this.iterate();
    }
    *iterate(execution?: {
        check(): void;
    }) {
        for (const node of this.nodes) {
            if (node.type === 'text') {
                for (const value of node.value) {
                    execution?.check();
                    yield new SnippetFragment([{ type: 'text', value }]);
                }
            }
            else {
                execution?.check();
                yield new SnippetFragment([node]);
            }
        }
    }
    concat(value: unknown) {
        return new SnippetFragment([...this.nodes, ...SnippetFragment.from(value).nodes]);
    }
    shiftCursors(offset: number) {
        return new SnippetFragment(this.nodes.map(node => {
            if (node.type !== 'cursor')
                return node;
            const level = node.level + offset;
            if (!Number.isSafeInteger(level) || level < 0)
                throw createSnippetError('err_snippet_cursor_offset');
            return { type: 'cursor', level };
        }));
    }
    get maxCursorLevel() {
        return this.nodes.reduce((max, node) => node.type === 'cursor' ? Math.max(max, node.level) : max, -1);
    }
    // Render only actual cursor nodes. Literal cursor syntax is never inspected.
    render(cursor: (level: number) => string, text: (value: string) => string = value => value) {
        return this.nodes.map(node => node.type === 'text' ? text(node.value) : cursor(node.level)).join('');
    }
}
export function snippetIterableItems(value: string | readonly unknown[] | SnippetFragment, execution?: ExecutionCheck): any[] {
    return Array.from(value instanceof SnippetFragment ? value.iterate(execution) : value);
}
export function snippetFragmentFromUnits(units: readonly unknown[]) {
    const nodes: FragmentNode[] = [];
    for (const unit of units)
        for (const node of SnippetFragment.from(unit).nodes)
            nodes.push(node);
    return new SnippetFragment(nodes);
}
export function snippetFragmentUnitsEqual(left: SnippetFragment, right: SnippetFragment) {
    const a = left.nodes[0];
    const b = right.nodes[0];
    return a.type === 'text' && b.type === 'text' ? a.value === b.value : a.type === 'cursor' && b.type === 'cursor' && a.level === b.level;
}
export function snippetFragmentMatchAt(units: readonly SnippetFragment[], search: readonly SnippetFragment[], index: number, execution?: ExecutionCheck) {
    if (index < 0 || index + search.length > units.length)
        return false;
    for (let i = 0; i < search.length; i++) {
        execution?.check();
        if (!snippetFragmentUnitsEqual(units[index + i], search[i]))
            return false;
    }
    return true;
}
export function snippetFragmentReplace(value: SnippetFragment, search: unknown, replacement: unknown, execution?: ExecutionCheck) {
    const units = snippetIterableItems(value, execution);
    const target = snippetIterableItems(SnippetFragment.from(search), execution);
    for (let i = 0; i <= units.length - target.length; i++) {
        execution?.check();
        if (snippetFragmentMatchAt(units, target, i, execution)) {
            return snippetFragmentFromUnits([
                ...units.slice(0, i), SnippetFragment.from(replacement), ...units.slice(i + target.length)
            ]);
        }
    }
    return value;
}
export function snippetFragmentSplit(value: SnippetFragment, separator: unknown, execution?: ExecutionCheck) {
    const units = snippetIterableItems(value, execution);
    const target = snippetIterableItems(SnippetFragment.from(separator), execution);
    if (!target.length)
        return units;
    const parts: SnippetFragment[] = [];
    let from = 0;
    for (let i = 0; i <= units.length - target.length; i++) {
        execution?.check();
        if (snippetFragmentMatchAt(units, target, i, execution)) {
            parts.push(snippetFragmentFromUnits(units.slice(from, i)));
            from = i + target.length;
            i = from - 1;
        }
    }
    parts.push(snippetFragmentFromUnits(units.slice(from)));
    return parts;
}
