import { analyze, parseExpression, SnippetTemplate } from './analyzer.js';
import { SnippetError, createSnippetError } from './errors.js';
import { SnippetFragment } from './fragment.js';
import { FUNCTIONS, validateFunction, validateFunctionArguments, validateSnippetCallArguments } from './functions.js';
import { snippetParameterNames } from './trigger.js';
import { defaultEnvironment } from './environment.js';
import { binaryValue, callBuiltinFunction, checkNumberResult, createList, indexValue, isRange, isSnippetIterable, snippetBooleanValue, snippetConditionValue, unaryValue } from './values.js';
import type { Analysis, Environment, ExecuteOptions, Expr, Host, Snippet, SourceRange, Value, Variables } from './types.js';
export const SNIPPET_LOOP_VALUE = Symbol('snippetLoopValue');
export const DEFAULT_SNIPPET_TIMEOUT_MS = 500, MIN_SNIPPET_TIMEOUT_MS = 100, MAX_SNIPPET_TIMEOUT_MS = 60000;
export const DEFAULT_SNIPPET_CALL_DEPTH = 32, MAX_SNIPPET_CALL_DEPTH = 256;
export function normalizeSnippetTimeout(value: unknown): number { return typeof value === 'number' && Number.isFinite(value) && value >= 100 && value <= 60000 ? Math.round(value) : 500; }
export function normalizeSnippetCallDepth(value: unknown): number { return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 256 ? value : 32; }
export class Execution {
    readonly environment: Environment;
    readonly controller = new AbortController();
    readonly signal = this.controller.signal;
    readonly timeoutMs: number;
    deadline: number;
    nextYield: number;
    private externalSignal?: AbortSignal;
    private cancelListener?: () => void;
    private failure?: Error;
    constructor(timeoutMs?: number, environment: Partial<Environment> = {}, signal?: AbortSignal) {
        this.environment = { ...defaultEnvironment, ...environment };
        this.timeoutMs = normalizeSnippetTimeout(timeoutMs);
        const now = this.environment.now();
        this.deadline = now + this.timeoutMs;
        this.nextYield = now + 16;
        this.externalSignal = signal;
        this.cancelListener = () => { this.failure = createSnippetError('err_snippet_cancelled'); this.controller.abort(this.failure); };
        if (signal?.aborted)
            this.cancelListener();
        else
            signal?.addEventListener('abort', this.cancelListener, { once: true });
    }
    check() {
        if (this.failure)
            throw this.failure;
        if (this.environment.now() >= this.deadline) {
            this.failure = createSnippetError('err_snippet_timeout', [this.timeoutMs / 1000]);
            this.controller.abort(this.failure);
            throw this.failure;
        }
    }
    async checkpoint() {
        this.check();
        if (this.environment.now() >= this.nextYield) {
            await this.wait(() => this.environment.yield());
            this.nextYield = this.environment.now() + 16;
            this.check();
        }
    }
    async wait<T>(action: () => T | Promise<T>, userInput = false): Promise<T> {
        this.check();
        const start = this.environment.now();
        let timer: ReturnType<typeof setTimeout> | undefined;
        let listener: () => void = () => { };
        try {
            const abort = new Promise<never>((_, reject) => {
                listener = () => reject(this.failure || createSnippetError('err_snippet_cancelled'));
                this.signal.addEventListener('abort', listener, { once: true });
            });
            const promises: Promise<T>[] = [Promise.resolve().then(action), abort];
            if (!userInput)
                promises.push(new Promise<never>((_, reject) => {
                    timer = setTimeout(() => {
                        this.failure = createSnippetError('err_snippet_timeout', [this.timeoutMs / 1000]);
                        this.controller.abort(this.failure);
                        reject(this.failure);
                    }, Math.max(0, this.deadline - this.environment.now()));
                }));
            const value = await Promise.race(promises);
            if (userInput)
                this.deadline += this.environment.now() - start;
            this.check();
            return value;
        }
        finally {
            if (timer !== undefined)
                clearTimeout(timer);
            this.signal.removeEventListener('abort', listener);
            if (userInput)
                this.nextYield = this.environment.now() + 16;
        }
    }
    userInput<T>(action: () => T | Promise<T>) { return this.wait(action, true); }
    dispose() { if (this.cancelListener)
        this.externalSignal?.removeEventListener('abort', this.cancelListener); }
}
export function createSnippetExecution(timeoutMs?: number) { return new Execution(timeoutMs); }
interface Context {
    execution: Execution;
    library: readonly Snippet[];
    host?: Host;
    maxCallDepth: number;
    stack: readonly Snippet[];
    loopControl?: {
        type?: 'break' | 'continue';
    };
    name: string;
    source: string;
}
function variable(node: Expr & {
    kind: 'variable' | 'loop';
}, args: Variables) {
    const name = node.kind === 'loop' && node.name === 'value' ? SNIPPET_LOOP_VALUE : node.name;
    if (!Object.prototype.hasOwnProperty.call(args, name))
        throw createSnippetError(node.kind === 'variable' ? 'err_undefined_variable' : node.name === 'index' ? 'err_index_outside_for' : 'err_value_outside_for', node.kind === 'variable' ? ['$' + node.name] : []);
    return checkNumberResult(args[name]);
}
function binaryShort(node: Expr & {
    kind: 'binary';
}, left: any): boolean | undefined {
    if (node.operator === '&&' && !snippetBooleanValue(left))
        return false;
    if (node.operator === '||' && snippetBooleanValue(left))
        return true;
    return undefined;
}
function locate(error: any, range: SourceRange, context: Context) {
    if (error && error.name !== 'SnippetPromptCancelled' && !error.snippetLocation) {
        const lines = context.source.slice(0, range.start).split(/\r\n|\r|\n/);
        error.snippetLocation = { snippetName: context.name, offset: range.start, line: lines.length, column: Array.from(lines.at(-1)!).length + 1 };
        error.callTrace = context.stack.map(snippet => snippet.name || '');
    }
}
async function evaluate(node: Expr, args: Variables, context: Context): Promise<any> {
    const execution = context.execution;
    execution.check();
    try {
        switch (node.kind) {
            case 'literal': return checkNumberResult(node.value);
            case 'variable':
            case 'loop': return variable(node, args);
            case 'list': {
                const values: any[] = [];
                for (const item of node.items)
                    values.push(await evaluate(item, args, context));
                return createList(values);
            }
            case 'index': return indexValue(await evaluate(node.target, args, context), await evaluate(node.index, args, context), execution);
            case 'unary': {
                const value = await evaluate(node.operand, args, context);
                return unaryValue(node.operator, value);
            }
            case 'binary': {
                const left = await evaluate(node.left, args, context);
                const short = binaryShort(node, left);
                if (short !== undefined)
                    return short;
                const right = await evaluate(node.right, args, context);
                return node.operator === '&&' || node.operator === '||' ? snippetBooleanValue(right) : binaryValue(node.operator, left, right, execution);
            }
            case 'conditional': return evaluate(snippetConditionValue(await evaluate(node.condition, args, context)) ? node.yes : node.no, args, context);
            case 'fragment': return solve(node.template, { ...args }, { ...context, loopControl: undefined });
            case 'call': {
                validateFunction(node.name, node.args.length);
                const values: any[] = [];
                for (const arg of node.args)
                    values.push(await evaluate(arg, args, context));
                const ranges = node.args.map(arg => arg.range);
                validateFunctionArguments(node.name, values, ranges);
                const spec = FUNCTIONS[node.name];
                const capabilities = {
                    name: node.name, execution, environment: execution.environment, userInput: spec.userInput,
                    solveFragment: async (source: string) => {
                        const analysis = analyze(source, { checkVariables: false, forDepth: Object.prototype.hasOwnProperty.call(args, 'index') ? 1 : 0 });
                        return runAnalysis(analysis, { ...args }, { ...context, loopControl: undefined, source: analysis.source });
                    },
                    invokeHost: async (values: readonly Value[]) => {
                        if (!context.host) throw createSnippetError('err_host_function_unavailable', [node.name]);
                        return execution.wait(() => context.host!.invoke({ name: node.name, args: values, sourceRange: node.range }, { signal: execution.signal }), spec.userInput);
                    },
                };
                return spec.execute ? spec.execute(values, capabilities) : await spec.executeAsync(values, capabilities);
            }
            case 'snippet': {
                const matches = context.library.filter(snippet => snippet.name === node.name);
                if (matches.length !== 1)
                    throw createSnippetError('err_snippet_call_target', [node.name]);
                const target = matches[0], parameters = snippetParameterNames(target.trigger);
                if (parameters.length !== node.args.length)
                    throw createSnippetError('err_snippet_call_args', [node.name, parameters.length]);
                if (context.stack.length >= context.maxCallDepth)
                    throw createSnippetError('err_snippet_call_depth', [context.maxCallDepth, node.name]);
                const childArgs: Variables = {};
                const argumentContext = { ...context, stack: [...context.stack, target] };
                const values: unknown[] = [];
                for (const argument of node.args)
                    values.push(await evaluate(argument, args, argumentContext));
                validateSnippetCallArguments(node.name, values, node.args.map(argument => argument.range));
                for (let i = 0; i < parameters.length; i++)
                    Object.defineProperty(childArgs, parameters[i], { value: values[i], writable: true, enumerable: true, configurable: true });
                let offset = 0;
                if (node.offset) {
                    const value = await evaluate(node.offset, args, argumentContext);
                    offset = typeof value === 'number' ? value : NaN;
                    if (!Number.isSafeInteger(offset) || offset < 0)
                        throw createSnippetError('err_snippet_cursor_offset');
                }
                const analysis = prepareSnippetTemplate(target).analysis;
                const result = await runAnalysis(analysis, childArgs, { ...context, stack: [...context.stack, target], name: target.name || '', source: analysis.source, loopControl: undefined });
                return offset ? result.shiftCursors(offset) : result;
            }
        }
    }
    catch (error) {
        if (error && !error.sourceRange)
            error.sourceRange = node.range;
        throw error;
    }
}
async function solve(template: SnippetTemplate, args: Variables, context: Context): Promise<SnippetFragment> {
    const nodes: any[] = [], newlyCreated = new Set<string>();
    const append = (value: any) => { for (const node of SnippetFragment.from(value).nodes)
        nodes.push(node); };
    const setVar = (name: string, value: any) => { if (!Object.prototype.hasOwnProperty.call(args, name))
        newlyCreated.add(name); Object.defineProperty(args, name, { value, writable: true, enumerable: true, configurable: true }); };
    try {
        for (const node of template.nodes) {
            if (context.loopControl?.type)
                break;
            try {
                await context.execution.checkpoint();
                switch (node.type) {
                    case 'text':
                    case 'cursor':
                        nodes.push(node);
                        break;
                    case 'expression':
                        append(await evaluate(node.expression, args, context));
                        break;
                    case 'cursorExpression': {
                        const level = await evaluate(node.expression, args, context);
                        if (!Number.isSafeInteger(level) || level < 0)
                            throw createSnippetError('err_cursor_level');
                        nodes.push({ type: 'cursor', level });
                        break;
                    }
                    case 'set':
                        for (const assignment of node.assignments) {
                            const value = assignment.expression ? await evaluate(assignment.expression, args, context) : undefined;
                            setVar(assignment.name, assignment.operator && assignment.operator !== '=' ? binaryValue(assignment.operator[0], args[assignment.name] ?? 0, value, context.execution) : value);
                        }
                        break;
                    case 'break':
                    case 'continue':
                        if (!context.loopControl)
                            throw createSnippetError('err_loop_control_outside_for', [node.type]);
                        context.loopControl.type = node.type;
                        break;
                    case 'for': {
                        const iterable = await evaluate(node.expression, args, context), range = isRange(iterable);
                        const iterator = !range && isSnippetIterable(iterable) ? iterable instanceof SnippetFragment ? iterable.iterate(context.execution) : (iterable as string | any[])[Symbol.iterator]() : undefined;
                        const start = range ? iterable.start : 0, step = range && iterable.end < iterable.start ? -1 : 1;
                        const count = iterator ? 0 : range ? Math.abs(iterable.end - iterable.start) + 1 : parseInt(iterable, 10) || 0;
                        const hadIndex = Object.prototype.hasOwnProperty.call(args, 'index'), oldIndex = args.index;
                        const hadValue = Object.prototype.hasOwnProperty.call(args, SNIPPET_LOOP_VALUE), oldValue = args[SNIPPET_LOOP_VALUE];
                        const loopContext: Context = { ...context, loopControl: {} };
                        try {
                            for (let i = 0; iterator || i < count; i++) {
                                const next = iterator?.next();
                                if (next?.done)
                                    break;
                                args.index = i;
                                args[SNIPPET_LOOP_VALUE] = iterator ? next!.value : start + i * step;
                                loopContext.loopControl!.type = undefined;
                                append(await solve(node.body, args, loopContext));
                                if (loopContext.loopControl!.type === 'break')
                                    break;
                            }
                        }
                        finally {
                            if (hadIndex)
                                args.index = oldIndex;
                            else
                                delete args.index;
                            if (hadValue)
                                args[SNIPPET_LOOP_VALUE] = oldValue;
                            else
                                delete args[SNIPPET_LOOP_VALUE];
                        }
                        break;
                    }
                    case 'if':
                        for (const branch of node.branches) {
                            try {
                                if (branch.expression === null || snippetConditionValue(await evaluate(branch.expression, args, context))) {
                                    append(await solve(branch.body, args, context));
                                    break;
                                }
                            }
                            catch (error) {
                                locate(error, branch.range, context);
                                throw error;
                            }
                        }
                        break;
                    case 'switch': {
                        const value = String(await evaluate(node.expression, args, context));
                        let selected = node.defaultBody;
                        cases: for (const branch of node.cases) {
                            try {
                                for (const expression of branch.expressions)
                                    if (String(await evaluate(expression, args, context)) === value) {
                                        selected = branch.body;
                                        break cases;
                                    }
                            }
                            catch (error) {
                                locate(error, branch.range, context);
                                throw error;
                            }
                        }
                        if (selected)
                            append(await solve(selected, args, context));
                        break;
                    }
                }
            }
            catch (error) {
                locate(error, node.range, context);
                throw error;
            }
        }
        context.execution.check();
        return new SnippetFragment(nodes);
    }
    finally {
        for (const key of newlyCreated)
            delete args[key];
    }
}
async function runAnalysis(analysis: Analysis, args: Variables, context: Context) {
    const diagnostic = analysis.diagnostics.find(d => d.severity === 'error');
    if (diagnostic) {
        const error = new SnippetError(diagnostic.code, [...diagnostic.args], diagnostic.range);
        let location = diagnostic.range;
        function visit(value: any) {
            if (!value || typeof value !== 'object')
                return;
            if (value.type && value.range?.start <= diagnostic!.range.start && value.range?.end >= diagnostic!.range.end)
                location = value.range;
            for (const child of Object.values(value))
                if (child && typeof child === 'object')
                    visit(child);
        }
        if (['err_list_index_target', 'err_list_index_integer'].includes(diagnostic.code))
            visit(analysis.template.nodes);
        locate(error, location, context);
        throw error;
    }
    return solve(analysis.template, args, context);
}
export async function execute(analysis: Analysis, options: ExecuteOptions = {}): Promise<SnippetFragment> {
    const execution = new Execution(options.limits?.timeoutMs, options.environment, options.signal);
    try {
        return await runAnalysis(analysis, options.variables || {}, { execution, library: options.library || [], host: options.host, maxCallDepth: normalizeSnippetCallDepth(options.limits?.maxCallDepth), stack: [], name: '', source: analysis.source });
    }
    finally {
        execution.dispose();
    }
}
const templateCache = new WeakMap<Snippet, {
    source: string;
    analysis: Analysis;
    template: SnippetTemplate;
    error?: SnippetError;
}>();
export function prepareSnippetTemplate(snippet: Snippet, _execution?: Execution) {
    const source = snippet.replacement || '';
    let entry = templateCache.get(snippet);
    if (!entry || entry.source !== source) {
        const analysis = analyze(source, { checkVariables: false });
        const diagnostic = analysis.diagnostics.find(d => d.severity === 'error');
        entry = { source, analysis, template: analysis.template, error: diagnostic ? new SnippetError(diagnostic.code, [...diagnostic.args], diagnostic.range) : undefined };
        templateCache.set(snippet, entry);
    }
    return entry;
}
export function parseSnippetTemplate(source: string, _execution?: Execution) {
    const analysis = analyze(source, { checkVariables: false });
    const diagnostic = analysis.diagnostics.find(d => d.severity === 'error');
    if (diagnostic)
        throw new SnippetError(diagnostic.code, [...diagnostic.args], diagnostic.range);
    return analysis.template;
}
export function getSnippetTemplate(snippet: Snippet, _execution?: Execution) { const entry = prepareSnippetTemplate(snippet); if (entry.error)
    throw entry.error; return entry.template; }
export async function processTemplate(input: string | Snippet | SnippetTemplate, args: Variables = {}, options: any = {}): Promise<SnippetFragment> {
    const snippet = typeof input === 'object' && !(input instanceof SnippetTemplate) ? input : undefined;
    const source = typeof input === 'string' ? input : input instanceof SnippetTemplate ? input.source : input.replacement || '';
    const analysis = input instanceof SnippetTemplate ? { source, template: input, variableTypes: [], callSignatures: [], diagnostics: [], tokens: [], regions: [], references: [] } : snippet ? prepareSnippetTemplate(snippet).analysis : analyze(source, { checkVariables: false, forDepth: Object.prototype.hasOwnProperty.call(args, 'index') ? 1 : 0 });
    const execution = options.execution || new Execution(options.maxExecutionMs, options.environment, options.signal);
    try {
        return await runAnalysis(analysis, args, { execution, library: options.snippets || [], host: options.host, maxCallDepth: normalizeSnippetCallDepth(options.maxCallDepth), stack: options.stack || (snippet ? [snippet] : []), name: snippet?.name || options.stack?.at(-1)?.name || '', source, loopControl: options.loopControl });
    }
    finally {
        if (!options.execution)
            execution.dispose();
    }
}
// Synchronous convenience API for pure expressions. Execution of templates uses
// the already parsed AST above, never this source-based convenience wrapper.
export function evaluateExpression(source: string, args: Variables = {}, execution?: any, environment: Environment = defaultEnvironment): any {
    return evaluatePure(parseExpression(source), args, execution, environment);
}
function evaluatePure(node: Expr, args: Variables, execution: any, environment: Environment): any {
    execution?.check();
    const evalNode = (child: Expr) => evaluatePure(child, args, execution, environment);
    switch (node.kind) {
        case 'literal': return checkNumberResult(node.value);
        case 'variable':
        case 'loop': return variable(node, args);
        case 'list': return createList(node.items.map(evalNode));
        case 'index': return indexValue(evalNode(node.target), evalNode(node.index), execution);
        case 'unary': return unaryValue(node.operator, evalNode(node.operand));
        case 'conditional': return evalNode(snippetConditionValue(evalNode(node.condition)) ? node.yes : node.no);
        case 'binary': {
            const left = evalNode(node.left), short = binaryShort(node, left);
            if (short !== undefined)
                return short;
            const right = evalNode(node.right);
            return node.operator === '&&' || node.operator === '||' ? snippetBooleanValue(right) : binaryValue(node.operator, left, right, execution);
        }
        case 'call': if (FUNCTIONS[node.name]?.execute)
            return callBuiltinFunction(node.name, node.args.map(evalNode), execution, environment, node.args.map(arg => arg.range));
    }
    throw createSnippetError('err_host_function_unavailable', [node.kind === 'call' ? node.name : node.kind]);
}
export function evaluateCondition(source: string, args: Variables = {}, execution?: any) { return snippetConditionValue(evaluateExpression(source, args, execution)); }
