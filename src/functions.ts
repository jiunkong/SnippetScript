import { Type, Types, typeFromNames, typeInfo, ListType, UnionType, ScriptValue } from './type-system.js';
import { fromNative, toNative } from './value-codec.js';
import { SnippetFragment, snippetIterableItems, snippetFragmentFromUnits, snippetFragmentMatchAt, snippetFragmentReplace, snippetFragmentSplit } from './fragment.js';
import { checkNumberResult, createList, snippetConditionValue, snippetValuesEqual, isSnippetIterable } from './native-values.js';
import { isRange, valueTypeOf } from './value-type.js';
import { SnippetError, createSnippetError } from './errors.js';
import type { Environment, ExecutionCheck, SourceRange, TokenKind, Value, ValueType } from './types.js';
export type ParameterTypes = readonly ValueType[] | 'any';
export interface FunctionParameter {
    readonly type: Type;
    readonly name: string;
    readonly types: ParameterTypes;
    readonly requiredType?: Type;
    readonly elementTypes?: readonly ValueType[];
    readonly requiredElementTypes?: readonly ValueType[];
}
export interface FunctionOverload {
    readonly id: string;
    readonly min: number;
    readonly max: number;
    readonly parameters: readonly FunctionParameter[];
    readonly restParameter?: FunctionParameter;
    readonly returnType: Type;
    readonly returnTypes: ParameterTypes;
    readonly returnElementTypes?: readonly ValueType[];
}
export interface OverloadArgument {
    readonly type: Type;
    readonly types: readonly ValueType[];
    readonly elements?: readonly ValueType[];
    readonly exactElements?: boolean;
    readonly exactTypes?: boolean;
}
// Definitions own all function-specific behavior. The analyzer and executor
// supply capabilities and never branch on builtin names.
export interface FunctionExecutionContext {
    readonly name: string;
    readonly execution?: ExecutionCheck;
    readonly environment: Environment;
}
export interface AsyncFunctionExecutionContext extends FunctionExecutionContext {
    readonly userInput?: boolean;
    invokeHost(values: readonly Value[]): Promise<Value>;
    solveFragment(source: string): Promise<SnippetFragment>;
}
export interface FunctionTypeInfo {
    readonly type: Type;
    readonly types: readonly ValueType[];
    readonly elements?: readonly ValueType[];
    readonly exactElements?: boolean;
}
export type FunctionHandler = (values: Value[], context: FunctionExecutionContext) => Value;
type NativeFunctionHandler = (values: any[], context: FunctionExecutionContext) => any;
export type AsyncFunctionHandler = (values: Value[], context: AsyncFunctionExecutionContext) => Promise<Value>;
type NativeAsyncFunctionHandler = (values: any[], context: AsyncFunctionExecutionContext) => Promise<any>;
export type FunctionReturnInference = (args: readonly OverloadArgument[], overloads: readonly FunctionOverload[]) => FunctionTypeInfo;
interface FunctionBehavior {
    readonly kind?: TokenKind;
    readonly host?: boolean;
    readonly userInput?: boolean;
    readonly arityError?: string;
    readonly validate?: (values: readonly unknown[], ranges: readonly SourceRange[]) => void;
    readonly inferReturn?: FunctionReturnInference;
}
type FunctionImplementation = { readonly execute: FunctionHandler; readonly executeAsync?: never }
    | { readonly execute?: never; readonly executeAsync: AsyncFunctionHandler };
export type FunctionSpec = Readonly<FunctionBehavior & FunctionImplementation & {
    readonly overloads: readonly FunctionOverload[];
    readonly min: number;
    readonly max: number;
    readonly kind: TokenKind;
}>;
type OverloadDefinition = Omit<FunctionOverload, 'id'>;
type NativeImplementation = { readonly execute: NativeFunctionHandler; readonly executeAsync?: never } | { readonly execute?: never; readonly executeAsync: NativeAsyncFunctionHandler };
type NativeTypeInfo = Omit<FunctionTypeInfo, 'type'> & { readonly type?: Type };
type NativeReturnInference = (args: readonly OverloadArgument[], overloads: readonly FunctionOverload[]) => NativeTypeInfo;
type FunctionDefinition = Omit<FunctionBehavior, 'inferReturn'> & { readonly inferReturn?: NativeReturnInference } & NativeImplementation & { readonly overloads: readonly OverloadDefinition[] };

const text = UnionType.of(Types.string, Types.fragment);
function declaredType(source: ParameterTypes | Type): Type {
    return source instanceof Type ? source : source === 'any' ? Types.any : typeFromNames(source);
}
function parameter(name: string, source: ParameterTypes | Type, elements?: readonly ValueType[] | Type, required?: readonly ValueType[] | Type): FunctionParameter {
    const element = elements && (elements instanceof Type ? elements : typeFromNames(elements));
    const base = declaredType(source);
    const type = base.kind === 'list' && element ? new ListType(element) : base;
    const requiredType = required && (required instanceof Type ? required : typeFromNames(required));
    return Object.freeze({ name, type, requiredType,
        get types() { return type.kind === 'any' ? 'any' as const : type.names; },
        get elementTypes() { return element?.names; },
        get requiredElementTypes() { return requiredType?.names; },
    });
}
const string = (name: string) => parameter(name, Types.string);
const number = (name: string) => parameter(name, Types.number);
const value = (name: string) => parameter(name, Types.any);
function overload(parameters: readonly FunctionParameter[], source: ParameterTypes | Type, min = parameters.length, max = parameters.length,
    restParameter?: FunctionParameter, elements?: readonly ValueType[] | Type): OverloadDefinition {
    const base = declaredType(source);
    const element = elements && (elements instanceof Type ? elements : typeFromNames(elements));
    const returnType = base.kind === 'list' && element ? new ListType(element) : base;
    return Object.freeze({ parameters: Object.freeze([...parameters]), returnType,
        get returnTypes() { return returnType.kind === 'any' ? 'any' as const : returnType.names; },
        min, max, restParameter, get returnElementTypes() { return element?.names; },
    });
}
function defineFunctions(definitions: Record<string, FunctionDefinition>): Readonly<Record<string, FunctionSpec>> {
    return Object.freeze(Object.fromEntries(Object.entries(definitions).map(([name, definition]) => {
        const { execute, executeAsync, ...behavior } = definition;
        const implementation: FunctionImplementation = execute
            ? { execute: (values, context) => fromNative(checkNumberResult(execute(values.map(toNative), context))) }
            : { executeAsync: async (values, context) => fromNative(checkNumberResult(await executeAsync!(values.map(toNative), context))) };
        return [name, Object.freeze({
            ...behavior, ...implementation,
            inferReturn: definition.inferReturn && ((args: readonly OverloadArgument[], overloads: readonly FunctionOverload[]) => { const result = definition.inferReturn!(args, overloads); return { ...typeInfo(result.type ?? typeFromNames(result.types, result.elements), result.exactElements) }; }), kind: definition.kind ?? 'function',
            min: Math.min(...definition.overloads.map(overload => overload.min)),
            max: Math.max(...definition.overloads.map(overload => overload.max)),
            overloads: Object.freeze(definition.overloads.map((overload, index) => Object.freeze({ ...overload, id: `${name}:${index}` }))),
        })];
    })));
}

// Host implementations remain in the embedding application. Normalization,
// cancellation and failure policy are part of the language's function definition.
function host(options: { result?: (value: any) => any; failure?: (error: any) => any } = {}): NativeAsyncFunctionHandler {
    return async (values, context) => {
        let result: any;
        try { result = toNative(await context.invokeHost(values.map(fromNative))); }
        catch (error) {
            if (error?.code === 'err_snippet_timeout' || error?.code === 'err_snippet_cancelled' || error?.code === 'err_host_function_unavailable' || !options.failure) throw error;
            result = options.failure(error);
        }
        if (context.userInput && (result === '' || result == null)) {
            const error = new Error('Snippet expansion cancelled');
            error.name = 'SnippetPromptCancelled';
            throw error;
        }
        return options.result ? options.result(result) : String(result ?? '');
    };
}
function textTransform(transform: (text: string, first: boolean, fragment: boolean) => string, trimEdges = false): NativeFunctionHandler {
    return ([value], { execution }) => {
        if (!(value instanceof SnippetFragment)) return transform(value, true, false);
        let first = true;
        return new SnippetFragment(value.nodes.map((node, index) => {
            execution?.check();
            if (node.type === 'cursor') return node;
            let text = node.value;
            if (trimEdges) {
                if (index === 0) text = text.trimStart();
                if (index === value.nodes.length - 1) text = text.trimEnd();
            } else text = transform(text, first, true);
            first = false;
            return { type: 'text', value: text };
        }));
    };
}
function textBoundary(atEnd: boolean): NativeFunctionHandler {
    return (items, { execution }) => {
        if (items[0] instanceof SnippetFragment || items[1] instanceof SnippetFragment) {
            const units = snippetIterableItems(SnippetFragment.from(items[0]), execution);
            const search = snippetIterableItems(SnippetFragment.from(items[1]), execution);
            return snippetFragmentMatchAt(units, search, atEnd ? units.length - search.length : 0, execution);
        }
        return atEnd ? items[0].endsWith(items[1]) : items[0].startsWith(items[1]);
    };
}
function editIterable(insert: boolean): NativeFunctionHandler {
    return (values, { execution }) => {
        let target = values[0];
        const index = values[1];
        if (!Number.isSafeInteger(index)) throw createSnippetError('err_list_index_integer');
        const inserted = insert ? values[2] : undefined;
        if (typeof target === 'string' && inserted instanceof SnippetFragment) target = SnippetFragment.from(target);
        const result = snippetIterableItems(target, execution);
        const position = index < 0 ? result.length + index : index;
        if (insert) {
            if (position >= 0 && position <= result.length) result.splice(position, 0, inserted);
        } else if (position >= 0 && position < result.length) result.splice(position, 1);
        return target instanceof SnippetFragment ? snippetFragmentFromUnits(result)
            : typeof target === 'string' ? result.join('') : createList(result);
    };
}
const uniqueTypes = (types: readonly ValueType[]): ValueType[] => types.includes('unknown') ? ['unknown'] : [...new Set(types)];
function listArgumentElement(argument?: OverloadArgument): Type {
    const type = argument?.type;
    if (type instanceof ListType) return type.element;
    if (type instanceof UnionType) return UnionType.of(...type.members.filter(member => member instanceof ListType).map(member => (member as ListType).element));
    return Types.unknown;
}
const preserveListElements: NativeReturnInference = (args, overloads) => ({
    type: UnionType.of(...overloads.map(overload => overload.returnType instanceof ListType ? new ListType(listArgumentElement(args[0])) : overload.returnType)),
    types: uniqueTypes(overloads.flatMap(overload => overload.returnTypes === 'any' ? ['unknown'] : overload.returnTypes)),
    elements: args[0]?.elements ?? ['unknown'],
});

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
function sampleRandomNative(values: readonly any[], environment: Environment) {
    const evaluated = values.map(value => isRange(value) ? Math.min(value.start, value.end) + Math.floor(environment.random() * (Math.abs(value.end - value.start) + 1)) : value);
    return evaluated.length === 1 ? evaluated[0] : evaluated[Math.floor(environment.random() * evaluated.length)];
}

export function sampleRandom(values: readonly Value[], environment: Environment): Value {
    return fromNative(sampleRandomNative(values.map(toNative), environment));
}

export const FUNCTIONS = defineFunctions({
    url: {
        overloads: [
            overload([], Types.string),
        ],
        host: true,
        executeAsync: host(),
    },
    domain: {
        overloads: [
            overload([], Types.string),
        ],
        host: true,
        executeAsync: host(),
    },
    title: {
        overloads: [
            overload([], Types.string),
        ],
        host: true,
        executeAsync: host(),
    },
    uuid: {
        overloads: [
            overload([], Types.string),
        ],
        kind: 'randomFunction',
        execute: (_values, { environment }) => environment.uuid(),
    },
    bs: {
        overloads: [
            overload([], Types.string),
        ],
        execute: () => '\u0008',
    },
    backspace: {
        overloads: [
            overload([], Types.string),
        ],
        execute: () => '\u0008',
    },
    newline: {
        overloads: [
            overload([], Types.string),
        ],
        execute: () => '\n',
    },
    nl: {
        overloads: [
            overload([], Types.string),
        ],
        execute: () => '\n',
    },
    paste: {
        overloads: [
            overload([], Types.string),
        ],
        host: true,
        executeAsync: host({ failure: () => '' }),
    },
    date: {
        overloads: [
            overload([string('format')], Types.string, 0, 1),
        ],
        execute: (values, { environment }) => formatDate(environment.date(), values[0] || 'YYYY-MM-DD'),
    },
    time: {
        overloads: [
            overload([string('format')], Types.string, 0, 1),
        ],
        execute: (values, { environment }) => formatDate(environment.date(), values[0] || 'HH:mm'),
    },
    datetime: {
        overloads: [
            overload([string('format')], Types.string, 0, 1),
        ],
        execute: (values, { environment }) => formatDate(environment.date(), values[0] || 'YYYY-MM-DD HH:mm'),
    },
    prompt: {
        overloads: [
            overload([string('message')], Types.string, 0, 1),
        ],
        host: true,
        userInput: true,
        executeAsync: host(),
    },
    random: {
        overloads: [
            overload([], Types.any, 1, Infinity, value('value')),
        ],
        kind: 'randomFunction',
        execute: (values, { environment }) => sampleRandomNative(values, environment),
        inferReturn: args => ({ type: args.length ? UnionType.of(...args.map(arg => arg.type.kind === 'range' ? Types.number : arg.type)) : Types.unknown, types: uniqueTypes(args.length ? args.flatMap(value => value.types.map(type => type === 'range' ? 'number' : type)) : ['unknown']),
            elements: uniqueTypes(args.filter(value => value.types.includes('list')).flatMap(value => value.elements ?? ['unknown'])),
            exactElements: args.length > 0 && args.every(value => value.exactElements) && args.every(value => JSON.stringify(value.elements) === JSON.stringify(args[0].elements)) }),
    },
    choice: {
        overloads: [
            overload([string('title')], Types.string, 2, Infinity, string('option')),
        ],
        host: true,
        userInput: true,
        executeAsync: host(),
    },
    upper: {
        overloads: [
            overload([string('text')], Types.string),
            overload([parameter('text', Types.fragment)], Types.fragment),
        ],
        execute: textTransform(text => text.toUpperCase()),
    },
    lower: {
        overloads: [
            overload([string('text')], Types.string),
            overload([parameter('text', Types.fragment)], Types.fragment),
        ],
        execute: textTransform(text => text.toLowerCase()),
    },
    trim: {
        overloads: [
            overload([string('text')], Types.string),
            overload([parameter('text', Types.fragment)], Types.fragment),
        ],
        execute: textTransform(text => text.trim(), true),
    },
    capitalize: {
        overloads: [
            overload([string('text')], Types.string),
            overload([parameter('text', Types.fragment)], Types.fragment),
        ],
        execute: textTransform((text, first, fragment) => !first ? text : fragment ? String.fromCodePoint(text.codePointAt(0)!).toUpperCase() + text.slice(text.codePointAt(0)! > 0xffff ? 2 : 1) : text.charAt(0).toUpperCase() + text.slice(1)),
    },
    substr: {
        overloads: [
            overload([string('text'), number('start'), number('count')], Types.string, 2, 3),
            overload([parameter('text', Types.fragment), number('start'), number('count')], Types.fragment, 2, 3),
        ],
        arityError: 'err_substr_args',
        execute: (values, { execution }) => {
            const items = values;
            if (items[0] instanceof SnippetFragment) {
                const units = snippetIterableItems(items[0], execution);
                // Truncate numeric start/count, but count Unicode characters and
                // cursor nodes as complete units instead of slicing serialized syntax.
                const integer = (value: number) => Math.trunc(value);
                const rawStart = integer(items[1]);
                const start = rawStart < 0 ? Math.max(0, units.length + rawStart) : Math.min(rawStart, units.length);
                const count = items[2] === undefined ? units.length : Math.max(0, integer(items[2]));
                return snippetFragmentFromUnits(units.slice(start, start + count));
            }
            return (items[0] as string).substr(items[1], items[2]);
        },
    },
    replace: {
        overloads: [
            overload([string('text'), string('search'), string('replacement')], Types.string),
            overload([parameter('text', Types.fragment), parameter('search', text), parameter('replacement', text)], Types.fragment),
            overload([string('text'), parameter('search', Types.fragment), parameter('replacement', text)], Types.fragment),
            overload([string('text'), string('search'), parameter('replacement', Types.fragment)], Types.fragment),
        ],
        arityError: 'err_replace_args',
        execute: (values, { execution }) => {
            const items = values;
            if (items.some(item => item instanceof SnippetFragment))
                return snippetFragmentReplace(SnippetFragment.from(items[0]), items[1] ?? '', items[2] ?? '', execution);
            return (items[0] as string).replace(items[1], items[2]);
        },
    },
    len: {
        overloads: [
            overload([string('iterable')], Types.number),
            overload([parameter('iterable', Types.fragment)], Types.number),
            overload([parameter('iterable', new ListType(Types.unknown))], Types.number),
            overload([parameter('iterable', Types.range)], Types.number),
        ],
        execute: (values, { execution }) => {
            const value = values[0];
            if (isRange(value))
                return Math.abs(value.end - value.start) + 1;
            if (value instanceof SnippetFragment)
                return value.getLength(execution);
            return Array.isArray(value) ? value.length : Array.from(value as string).length;
        },
    },
    startswith: {
        overloads: [
            overload([string('text'), parameter('search', text)], Types.bool),
            overload([parameter('text', Types.fragment), parameter('search', text)], Types.bool),
        ],
        arityError: 'err_fn_two_args_exact',
        execute: textBoundary(false),
    },
    endswith: {
        overloads: [
            overload([string('text'), parameter('search', text)], Types.bool),
            overload([parameter('text', Types.fragment), parameter('search', text)], Types.bool),
        ],
        arityError: 'err_fn_two_args_exact',
        execute: textBoundary(true),
    },
    includes: {
        overloads: [
            overload([string('iterable'), parameter('value', text)], Types.bool),
            overload([parameter('iterable', Types.fragment), parameter('value', text)], Types.bool),
            overload([parameter('list', new ListType(Types.unknown)), value('value')], Types.bool),
            overload([parameter('range', Types.range), number('value')], Types.bool),
        ],
        arityError: 'err_fn_two_args_exact',
        execute: (values, { execution }) => {
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
                return target.includes(value as string);
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
        },
    },
    toast: {
        overloads: [
            overload([string('message'), string('color'), number('durationSeconds')], Types.undefined, 2, 3),
        ],
        arityError: 'err_toast_args',
        host: true,
        validate: (values, ranges) => { if (values.length === 3) validateToastDuration(values[2], ranges[2]); },
        executeAsync: host({ result: () => undefined }),
    },
    copy: {
        overloads: [
            overload([string('text')], Types.undefined),
            overload([parameter('text', Types.fragment)], Types.undefined),
        ],
        arityError: 'err_fn_one_arg_exact',
        host: true,
        executeAsync: host({ result: () => undefined, failure: () => { throw createSnippetError('err_clipboard_copy_failed'); } }),
    },
    type: {
        overloads: [
            overload([value('value')], Types.string),
        ],
        kind: 'typeFunction',
        arityError: 'err_fn_one_arg_exact',
        execute: (values) => valueTypeOf(values[0]),
    },
    isCursor: {
        overloads: [
            overload([parameter('fragment', Types.fragment)], Types.bool),
        ],
        arityError: 'err_fn_one_arg_exact',
        execute: (values) => {
            const value = values[0];
            return value instanceof SnippetFragment && value.nodes.length === 1 && value.nodes[0].type === 'cursor';
        },
    },
    hasCursor: {
        overloads: [
            overload([parameter('fragment', Types.fragment)], Types.bool),
        ],
        arityError: 'err_fn_one_arg_exact',
        execute: (values, { execution }) => {
            const value = values[0];
            return value instanceof SnippetFragment && value.nodes.some(node => {
                execution?.check();
                return node.type === 'cursor';
            });
        },
    },
    split: {
        overloads: [
            overload([string('text'), string('separator')], new ListType(Types.unknown), 2, 2, undefined, Types.string),
            overload([parameter('text', Types.fragment), parameter('separator', text)], new ListType(Types.unknown), 2, 2, undefined, Types.fragment),
            overload([string('text'), parameter('separator', Types.fragment)], new ListType(Types.unknown), 2, 2, undefined, Types.fragment),
        ],
        arityError: 'err_fn_two_args_exact',
        execute: (values, { execution }) => {
            const value = values[0];
            const separator = values[1];
            if (value instanceof SnippetFragment || separator instanceof SnippetFragment)
                return createList(snippetFragmentSplit(SnippetFragment.from(value), separator ?? '', execution));
            return createList((value as string).split(separator));
        },
    },
    join: {
        overloads: [
            overload([parameter('list', new ListType(Types.unknown), Types.string), string('separator')], Types.string),
            overload([parameter('list', new ListType(Types.unknown), text), parameter('separator', Types.fragment)], Types.fragment),
            overload([parameter('list', new ListType(Types.unknown), text, Types.fragment), string('separator')], Types.fragment),
        ],
        arityError: 'err_fn_two_args_exact',
        execute: (values, { execution }) => {
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
            return value.join(separator);
        },
    },
    insertAt: {
        overloads: [
            overload([string('text'), number('index'), string('value')], Types.string),
            overload([string('text'), number('index'), parameter('value', Types.fragment)], Types.fragment),
            overload([parameter('fragment', Types.fragment), number('index'), parameter('value', text)], Types.fragment),
            overload([parameter('list', new ListType(Types.unknown)), number('index'), value('value')], new ListType(Types.unknown)),
        ],
        arityError: 'err_fn_three_args_exact',
        execute: editIterable(true),
        inferReturn: (args, overloads) => ({ ...preserveListElements(args, overloads),
            type: UnionType.of(...overloads.map(overload => overload.returnType instanceof ListType ? new ListType(UnionType.of(listArgumentElement(args[0]), args[2]?.type ?? Types.unknown)) : overload.returnType)),
            elements: uniqueTypes([...(args[0]?.elements ?? ['unknown']), ...(args[2]?.types ?? ['unknown'])]) }),
    },
    removeAt: {
        overloads: [
            overload([string('iterable'), number('index')], Types.string),
            overload([parameter('iterable', Types.fragment), number('index')], Types.fragment),
            overload([parameter('iterable', new ListType(Types.unknown)), number('index')], new ListType(Types.unknown)),
        ],
        arityError: 'err_fn_two_args_exact',
        execute: editIterable(false),
        inferReturn: preserveListElements,
    },
    str: {
        overloads: [
            overload([value('value')], Types.string),
        ],
        kind: 'typeFunction',
        arityError: 'err_fn_one_arg_exact',
        execute: (values) => String(values[0] ?? ''),
    },
    num: {
        overloads: [
            overload([value('value')], Types.number),
        ],
        kind: 'typeFunction',
        arityError: 'err_fn_one_arg_exact',
        execute: (values) => {
            return Number(values[0] instanceof ScriptValue ? String(values[0]) : values[0]);
        },
    },
    int: {
        overloads: [
            overload([value('value')], Types.number),
        ],
        kind: 'typeFunction',
        arityError: 'err_fn_one_arg_exact',
        execute: (values) => {
            return parseInt(String(values[0]));
        },
    },
    bool: {
        overloads: [
            overload([value('value')], Types.bool),
        ],
        kind: 'typeFunction',
        arityError: 'err_fn_one_arg_exact',
        execute: (values) => snippetConditionValue(values[0]),
    },
    fragment: {
        overloads: [
            overload([value('value')], Types.fragment),
        ],
        kind: 'typeFunction',
        arityError: 'err_fn_one_arg_exact',
        executeAsync: async ([value], context) => value instanceof SnippetFragment ? value : context.solveFragment(String(value ?? '')),
    },
    round: {
        overloads: [
            overload([number('value')], Types.number),
        ],
        execute: (values) => {
            const v = values[0];
            return Math.round(v);
        },
    },
    ceil: {
        overloads: [
            overload([number('value')], Types.number),
        ],
        execute: (values) => {
            const v = values[0];
            return Math.ceil(v);
        },
    },
    floor: {
        overloads: [
            overload([number('value')], Types.number),
        ],
        execute: (values) => {
            const v = values[0];
            return Math.floor(v);
        },
    },
    min: {
        overloads: [
            overload([], Types.number, 1, Infinity, number('value')),
        ],
        execute: (values) => {
            return Math.min(...values);
        },
    },
    max: {
        overloads: [
            overload([], Types.number, 1, Infinity, number('value')),
        ],
        execute: (values) => {
            return Math.max(...values);
        },
    },
});

export function overloadParameter(overload: FunctionOverload, index: number): FunctionParameter | undefined {
    return overload.parameters[index] ?? overload.restParameter;
}
export function formatTypeNames(types: ParameterTypes | Type, elementTypes?: readonly ValueType[]): string[] {
    if (types instanceof Type) return (types.descriptor instanceof UnionType ? (types.descriptor as UnionType).members : [types.descriptor]).map(type => type.format());
    return (types === 'any' ? ['any'] : types).map(type =>
        type === 'list' && elementTypes ? `list<${elementTypes.join(' | ') || 'unknown'}>` : type);
}
export function argumentTypeLabel(argument: OverloadArgument): string {
    return formatTypeNames(argument.type ?? typeFromNames(argument.types, argument.elements ?? ['unknown'])).join(' | ');
}
export function parameterTypeLabel(parameter: FunctionParameter): string {
    return formatTypeNames(parameter.type).join(' | ')
        + (parameter.requiredElementTypes?.length ? ' & contains<' + parameter.requiredElementTypes.join(' | ') + '>' : '');
}
function parameterMatch(parameter: FunctionParameter | undefined, type: ValueType, argument: OverloadArgument): { possible: boolean; certain: boolean } {
    if (!parameter || parameter.types !== 'any' && !parameter.types.includes(type)) return { possible: false, certain: false };
    if (type !== 'list' || !parameter.elementTypes) return { possible: true, certain: true };
    const elements = argument.elements ?? ['unknown'];
    const unknown = elements.includes('unknown');
    const allowed = elements.filter(type => parameter.elementTypes!.includes(type));
    const valid = !unknown && allowed.length === elements.length;
    if (!valid && (argument.exactElements || !unknown && !allowed.length)) return { possible: false, certain: false };
    if (parameter.requiredElementTypes?.some(type => !elements.includes(type)) && !unknown) return { possible: false, certain: false };
    return { possible: true, certain: valid && (!parameter.requiredElementTypes?.length || !!argument.exactElements) };
}
const actualTypes: readonly ValueType[] = ['string', 'number', 'bool', 'fragment', 'list', 'range', 'null', 'undefined'];
export interface OverloadIssue { readonly index: number; readonly severity: 'error' | 'warning'; readonly expected: string; readonly actual: string }
export function resolveFunctionOverloads(name: string, args: readonly OverloadArgument[]) {
    args = args.map(argument => ({ ...argument, ...typeInfo(argument.type ?? typeFromNames(argument.types, argument.elements)), exactElements: argument.exactElements }));
    const spec = Object.prototype.hasOwnProperty.call(FUNCTIONS, name) ? FUNCTIONS[name] : undefined;
    if (!spec) return { candidates: [] as FunctionOverload[], fallback: [] as FunctionOverload[], issues: [] as OverloadIssue[] };
    let contexts: FunctionOverload[][] = [[...spec.overloads]];
    let fallback = [...spec.overloads];
    const issues: OverloadIssue[] = [];
    for (const [index, argument] of args.entries()) {
        const next = new Map<string, FunctionOverload[]>();
        const expected = new Set<string>();
        let accepted = false, rejected = false;
        for (const context of contexts) {
            for (const candidate of context) {
                const parameter = overloadParameter(candidate, index);
                if (parameter) expected.add(parameterTypeLabel(parameter));
            }
            for (const type of argument.types.includes('unknown') && !argument.exactTypes ? actualTypes : argument.types) {
                let variants: OverloadArgument[] = [argument];
                if (type === 'list' && !argument.exactElements && context.some(overload => overloadParameter(overload, index)?.elementTypes)) {
                    const elements = !argument.elements || argument.elements.includes('unknown') ? actualTypes : [...new Set(argument.elements)];
                    // Element unions represent possible list contents. Check their
                    // subsets so disjoint list overloads can collectively cover them.
                    variants = Array.from({ length: 2 ** elements.length }, (_, mask) => ({ ...argument,
                        elements: elements.filter((_, index) => mask & 2 ** index), exactElements: true }));
                }
                for (const variant of variants) {
                    const matches = context.map(overload => ({ overload, match: parameterMatch(overloadParameter(overload, index), type, variant) })).filter(entry => entry.match.possible);
                    if (!matches.length) { rejected = true; continue; }
                    accepted = true;
                    if (matches.every(entry => !entry.match.certain)) rejected = true;
                    const candidates = matches.map(entry => entry.overload);
                    next.set(candidates.map(overload => overload.id).join(','), candidates);
                }
            }
        }
        if (rejected && expected.size) issues.push({ index, severity: accepted ? 'warning' : 'error', expected: [...expected].join(' / '),
            actual: argumentTypeLabel(argument) });
        contexts = [...next.values()];
        if (!contexts.length) return { candidates: [] as FunctionOverload[], fallback, issues };
        fallback = [...new Set(contexts.flat())];
    }
    return { candidates: [...new Set(contexts.flat())], fallback, issues };
}
export const BUILTIN_ALL = Object.freeze(Object.keys(FUNCTIONS));
export function validateFunction(name: string, count: number, malformed = false): void {
    const spec = Object.prototype.hasOwnProperty.call(FUNCTIONS, name) ? FUNCTIONS[name] : undefined;
    if (!spec)
        throw createSnippetError('err_unknown_function', [name]);
    if (!malformed && count >= spec.min && count <= spec.max)
        return;
    const code = spec.arityError
        ?? (spec.max === 0 ? 'err_fn_no_args_allowed'
            : count === 0 && spec.min > 0 ? 'err_fn_args_required'
                : spec.max === 1 ? 'err_fn_one_arg_max' : 'err_function_arguments');
    throw createSnippetError(code, [name]);
}


// The same immutable signatures drive static diagnostics and every execution
// entrypoint. A union warning in the editor is checked against the actual value
// here before invoking a builtin or handing control to a browser host.
function runtimeArgument(value: unknown): OverloadArgument {
    const boxed = fromNative(value);
    return { ...typeInfo(boxed.descriptor), exactElements: true, exactTypes: true };
}
export function validateFunctionArguments(name: string, values: readonly unknown[], ranges: readonly SourceRange[] = []): void {
    validateFunction(name, values.length);
    values.forEach(checkNumberResult);
    const args = values.map(runtimeArgument);
    const resolution = resolveFunctionOverloads(name, args);
    if (!resolution.candidates.length) {
        const issue = resolution.issues.find(issue => issue.severity === 'error') ?? resolution.issues[0];
        if (issue) throw new SnippetError('err_argument_type', [name, String(issue.index + 1), issue.expected, issue.actual], ranges[issue.index]);
    }
    FUNCTIONS[name].validate?.(values.map(value => toNative(fromNative(value))), ranges);
}


export const DEFAULT_TOAST_DURATION_SECONDS = 6;
// Browsers store setTimeout delays as signed 32-bit milliseconds.
export const MAX_TOAST_DURATION_SECONDS = 2147483647 / 1000;
export function validateToastDuration(seconds: unknown, range?: SourceRange): void {
    if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds <= 0 || seconds > MAX_TOAST_DURATION_SECONDS)
        throw new SnippetError('err_toast_duration', [], range);
}


// Snippet parameters are capture variables and therefore start as strings,
// whether supplied by a trigger match or by another snippet's explicit call.
export const SNIPPET_PARAMETER_TYPES: readonly ValueType[] = Object.freeze(['string']);
export function validateSnippetCallArguments(name: string, values: readonly unknown[], ranges: readonly SourceRange[] = []): void {
    for (let index = 0; index < values.length; index++) {
        const actual = valueTypeOf(values[index]);
        if (!SNIPPET_PARAMETER_TYPES.includes(actual))
            throw new SnippetError('err_argument_type', [`@${name}`, String(index + 1), SNIPPET_PARAMETER_TYPES.join(' | '), argumentTypeLabel(runtimeArgument(values[index]))], ranges[index]);
    }
}
