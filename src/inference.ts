import { FUNCTIONS, SNIPPET_PARAMETER_TYPES, argumentTypeLabel, resolveFunctionOverloads } from './functions.js';
import type { AnalyzeOptions, CallTypeInfo, Diagnostic, Expr, SourceRange, ValueType, VariableTypeInfo } from './types.js';
import type { SnippetTemplate } from './analyzer.js';
import { binaryValue } from './value-operations.js';

// This pass only reads the shared AST. It never evaluates user code or host calls.
interface Info { types: ValueType[]; elements?: ValueType[]; exactElements?: boolean }
type Scope = Map<string, Info>;
interface Flow { normal?: Scope; breaks: Scope[]; continues: Scope[] }
const order: ValueType[] = ['string', 'number', 'bool', 'fragment', 'list', 'range', 'null', 'undefined', 'unknown'];
const names = (values: readonly ValueType[]): ValueType[] => values.includes('unknown') ? ['unknown'] : order.filter(type => values.includes(type));
const info = (...types: ValueType[]): Info => ({ types: names(types) });
const unknown = () => info('unknown');
const union = (...values: Info[]): Info => ({ exactElements: values.every(value => value.exactElements) && values.every(value => JSON.stringify(value.elements) === JSON.stringify(values[0]?.elements)), types: names(values.flatMap(value => value.types)),
    elements: values.some(value => value.types.includes('list')) ? names(values.filter(value => value.types.includes('list')).flatMap(value => value.elements ?? ['unknown'])) : undefined });
function merge(scopes: Scope[]): Scope | undefined {
    if (!scopes.length) return undefined;
    return new Map([...new Set(scopes.flatMap(scope => [...scope.keys()]))].map(name =>
        [name, union(...scopes.map(scope => scope.get(name) ?? info('undefined')))]));
}
function binary(operator: string, left: Info, right: Info): Info {
    if (['==', '!=', '<', '>', '<=', '>=', '&&', '||'].includes(operator)) return info('bool');
    if (operator === '~') return info('range');
    if (operator === '/' || operator === '%') return info('number');
    if (left.types.includes('unknown') || right.types.includes('unknown')) return unknown();
    const results: Info[] = [];
    for (const a of left.types) for (const b of right.types) {
        if (operator === '+') {
            if (a === 'list' || b === 'list') {
                if (a === b) results.push({ types: ['list'], elements: names([...(left.elements ?? ['unknown']), ...(right.elements ?? ['unknown'])]) });
            } else results.push(info(a === 'fragment' || b === 'fragment' ? 'fragment' : a === 'string' || b === 'string' ? 'string' : 'number'));
        } else if (operator === '-' && (a === 'list' || b === 'list')) {
            if (a === b) results.push(left);
        } else if (operator === '*') {
            results.push(info(a === 'fragment' || b === 'fragment' ? 'fragment' : a === 'string' || b === 'string' ? 'string' : 'number'));
        } else results.push(info('number'));
    }
    return results.length ? union(...results) : unknown();
}
function builtin(name: string, args: Info[]): Info {
    const resolution = resolveFunctionOverloads(name, args);
    const candidates = resolution.candidates.length ? resolution.candidates : resolution.fallback;
    if (!candidates.length) return unknown();
    const inferred = FUNCTIONS[name]?.inferReturn?.(args, candidates);
    if (inferred) return { ...inferred, types: names(inferred.types), elements: inferred.elements && names(inferred.elements) };
    return union(...candidates.map(overload => {
        const result: Info = overload.returnTypes === 'any' ? unknown() : info(...overload.returnTypes);
        if (result.types.includes('list')) result.elements = [...(overload.returnElementTypes ?? ['unknown'])];
        return result;
    }));
}

export function inferTemplateTypes(template: SnippetTemplate, options: AnalyzeOptions = {}): { readonly variableTypes: readonly VariableTypeInfo[]; readonly diagnostics: readonly Diagnostic[]; readonly callTypes: readonly CallTypeInfo[] } {
    const occurrences = new Map<string, VariableTypeInfo>();
    const calls = new Map<number, { range: SourceRange; value: Info; name?: string; args?: Info[]; argumentRanges?: SourceRange[] }>();
    const numericConstants = new WeakMap<Expr, number | undefined>();
    const zeroDivisors = new Map<string, Diagnostic>();
    // Fold only numeric literal arithmetic in the existing AST. Variables,
    // functions and host capabilities are never evaluated during analysis.
    function numericConstant(node: Expr): number | undefined {
        if (numericConstants.has(node)) return numericConstants.get(node);
        let value: number | undefined;
        if (node.kind === 'literal' && typeof node.value === 'number') value = node.value;
        else if (node.kind === 'unary') {
            const operand = numericConstant(node.operand);
            if (operand !== undefined) value = node.operator === '-' ? -operand : operand;
        } else if (node.kind === 'binary' && ['+', '-', '*', '/', '%'].includes(node.operator)) {
            const left = numericConstant(node.left), right = numericConstant(node.right);
            if (left !== undefined && right !== undefined && !((node.operator === '/' || node.operator === '%') && right === 0)) {
                try { value = binaryValue(node.operator, left, right); }
                catch (error) { if (error.code !== 'err_number_nan') throw error; }
            }
        }
        numericConstants.set(node, value);
        return value;
    }
    function checkDivisor(operator: string, divisor: Expr) {
        if (operator !== '/' && operator !== '%' || numericConstant(divisor) !== 0) return;
        const code = operator === '/' ? 'err_division_by_zero' : 'err_remainder_by_zero';
        zeroDivisors.set(`${code}:${divisor.range.start}:${divisor.range.end}`, Object.freeze({
            code, severity: 'error', args: Object.freeze([]), range: Object.freeze({ ...divisor.range })
        }));
    }
    function recordCall(range: SourceRange, value: Info, name?: string, args?: Info[], argumentRanges?: SourceRange[]): Info {
        const previous = calls.get(range.start);
        calls.set(range.start, { range, name, argumentRanges, args: args?.map((arg, index) => previous?.args?.[index] ? union(previous.args[index], arg) : arg),
            value: previous ? union(previous.value, value) : value });
        return value;
    }
    interface Check {
        range: SourceRange;
        code: 'snippet' | 'cursor' | 'offset';
        name?: string;
        index?: number;
        actual: Info;
        target?: Info;
    }
    const checks = new Map<string, Check>();
    function check(check: Check) {
        const key = `${check.code}:${check.range.start}:${check.range.end}:${check.index ?? ''}`;
        const previous = checks.get(key);
        checks.set(key, previous ? { ...check, actual: union(previous.actual, check.actual),
            target: previous.target && check.target ? union(previous.target, check.target) : check.target } : check);
    }
    function record(name: string, range: SourceRange, value: Info) {
        const key = `${range.start}:${range.end}`;
        const previous = occurrences.get(key);
        const types = names([...(previous?.types ?? []), ...value.types]);
        const elementTypes = types.includes('list') ? names([
            ...(previous?.types.includes('list') ? previous.elementTypes ?? ['unknown'] : []),
            ...(value.types.includes('list') ? value.elements ?? ['unknown'] : [])
        ]) : undefined;
        occurrences.set(key, { name, range, types, elementTypes });
    }
    function expression(node: Expr, scope: Scope, loopValue?: Info): Info {
        switch (node.kind) {
            case 'literal': return info(node.value === null ? 'null' : node.value === undefined ? 'undefined' : typeof node.value === 'boolean' ? 'bool' : typeof node.value === 'number' ? 'number' : 'string');
            case 'variable': {
                const value = scope.get(node.name) ?? unknown(); record(node.name, node.range, value); return value;
            }
            case 'loop': {
                const value = node.name === 'index' ? info('number') : loopValue ?? unknown();
                record(node.name, node.range, value); return value;
            }
            case 'fragment': block(node.template, new Map(scope), loopValue); return info('fragment');
            case 'snippet':
                node.args.forEach((arg, index) => check({ code: 'snippet', name: node.name, index,
                    range: arg.range, actual: expression(arg, scope, loopValue) }));
                if (node.offset) check({ code: 'offset', range: node.offset.range, actual: expression(node.offset, scope, loopValue) });
                return recordCall(node.range, info('fragment'));
            case 'list': {
                const items = node.items.map(item => expression(item, scope, loopValue));
                return { types: ['list'], elements: names(items.flatMap(item => item.types)), exactElements: items.every(item => item.types.length === 1 && !item.types.includes('unknown')) };
            }
            case 'index': {
                const target = expression(node.target, scope, loopValue); expression(node.index, scope, loopValue);
                return info(...target.types.flatMap<ValueType>(type => type === 'list' ? target.elements ?? ['unknown'] : type === 'range' ? ['number'] as ValueType[] : type === 'string' || type === 'fragment' ? [type] : ['unknown']), 'undefined');
            }
            case 'unary': expression(node.operand, scope, loopValue); return info('number');
            case 'binary':
                checkDivisor(node.operator, node.right);
                return binary(node.operator, expression(node.left, scope, loopValue), expression(node.right, scope, loopValue));
            case 'conditional': expression(node.condition, scope, loopValue); return union(expression(node.yes, scope, loopValue), expression(node.no, scope, loopValue));
            case 'call': {
                const args = node.args.map(arg => expression(arg, scope, loopValue));
                return recordCall(node.range, builtin(node.name, args), node.name, args, node.args.map(arg => arg.range));
            }
        }
    }
    function block(body: SnippetTemplate, incoming: Scope, loopValue?: Info): Flow {
        let scope: Scope | undefined = new Map(incoming);
        const breaks: Scope[] = [], continues: Scope[] = [];
        for (const node of body.nodes) {
            if (!scope) break;
            switch (node.type) {
                case 'expression': expression(node.expression, scope, loopValue); break;
                case 'cursorExpression': check({ code: 'cursor', range: node.expression.range, actual: expression(node.expression, scope, loopValue) }); break;
                case 'set':
                    for (const assignment of node.assignments) {
                        let value = assignment.expression ? expression(assignment.expression, scope, loopValue) : info('undefined');
                        if (assignment.operator && assignment.operator !== '=') {
                            if (assignment.expression) checkDivisor(assignment.operator[0], assignment.expression);
                            const previous = scope.get(assignment.name) ?? info('number');
                            value = binary(assignment.operator[0], previous, value);
                        }
                        scope.set(assignment.name, value);
                        record(assignment.name, assignment.range, value);
                    }
                    break;
                case 'break': breaks.push(scope); scope = undefined; break;
                case 'continue': continues.push(scope); scope = undefined; break;
                case 'if': {
                    const paths: Scope[] = [];
                    for (const branch of node.branches) {
                        if (branch.expression) expression(branch.expression, scope, loopValue);
                        const flow = block(branch.body, scope, loopValue);
                        if (flow.normal) paths.push(flow.normal);
                        breaks.push(...flow.breaks); continues.push(...flow.continues);
                    }
                    if (node.branches.every(branch => branch.expression !== null)) paths.push(scope);
                    scope = merge(paths); break;
                }
                case 'switch': {
                    expression(node.expression, scope, loopValue);
                    const paths: Scope[] = [];
                    for (const branch of node.cases) {
                        branch.expressions.forEach(item => expression(item, scope!, loopValue));
                        const flow = block(branch.body, scope, loopValue);
                        if (flow.normal) paths.push(flow.normal);
                        breaks.push(...flow.breaks); continues.push(...flow.continues);
                    }
                    if (node.defaultBody) {
                        const flow = block(node.defaultBody, scope, loopValue);
                        if (flow.normal) paths.push(flow.normal);
                        breaks.push(...flow.breaks); continues.push(...flow.continues);
                    } else paths.push(scope);
                    scope = merge(paths); break;
                }
                case 'for': {
                    const iterable = expression(node.expression, scope, loopValue);
                    const item = info(...iterable.types.flatMap(type => type === 'list' ? iterable.elements ?? ['unknown'] : type === 'string' || type === 'fragment' ? [type] : type === 'unknown' ? ['unknown'] : ['number']) as ValueType[]);
                    const entry = new Map(scope); entry.set('index', info('number'));
                    let head = entry;
                    const exits: Scope[] = [scope]; // The loop may execute zero times.
                    // Type sets are finite; iterate until assignments from earlier
                    // iterations no longer change the types at the loop head.
                    for (let iteration = 0; iteration < (entry.size + 1) * order.length * 2 + 2; iteration++) {
                        const flow = block(node.body, head, item);
                        exits.push(...flow.breaks);
                        const back = [...flow.continues, ...(flow.normal ? [flow.normal] : [])];
                        exits.push(...back);
                        const next = merge([entry, ...back])!;
                        if (JSON.stringify([...next]) === JSON.stringify([...head])) break;
                        head = next;
                    }
                    const merged = merge(exits)!;
                    if (scope.has('index')) merged.set('index', scope.get('index')!); else merged.delete('index');
                    scope = merged; break;
                }
            }
        }
        // solve() removes variables first created in a nested body, while
        // assignments to existing variables survive that body's completion.
        const clean = (value: Scope) => new Map([...incoming.keys()].map(name => [name, value.get(name) ?? info('undefined')]));
        return { normal: scope ? clean(scope) : undefined, breaks: breaks.map(clean), continues: continues.map(clean) };
    }
    const scope: Scope = new Map((options.variables ?? []).map(name => [name, info('string')]));
    for (const [name, types] of Object.entries(options.variableTypes ?? {})) scope.set(name, info(...types));
    block(template, scope);
    const diagnostics: Diagnostic[] = [...zeroDivisors.values()];
    for (const entry of checks.values()) {
        const expected: readonly ValueType[] = entry.code === 'snippet' ? SNIPPET_PARAMETER_TYPES : ['number'];
        const compatible = entry.actual.types.some(type => type === 'unknown' || expected.includes(type));
        const incompatible = entry.actual.types.some(type => type === 'unknown' || !expected.includes(type));
        if (!incompatible) continue;
        const severity = compatible ? 'warning' : 'error';
        const actual = argumentTypeLabel(entry.actual);
        const args = entry.code === 'snippet' ? [`@${entry.name}`, String(entry.index! + 1), expected.join(' | '), actual] : [actual];
        diagnostics.push(Object.freeze({ code: `${severity === 'error' ? 'err' : 'warn'}_${entry.code === 'snippet' ? 'argument_type' : entry.code === 'offset' ? 'cursor_offset_type' : 'cursor_expression_type'}`,
            args: Object.freeze(args), severity, range: Object.freeze(entry.range) }));
    }
    for (const call of calls.values()) {
        if (!call.name || !call.args) continue;
        for (const issue of resolveFunctionOverloads(call.name, call.args).issues)
            diagnostics.push(Object.freeze({ code: `${issue.severity === 'error' ? 'err' : 'warn'}_argument_type`, severity: issue.severity,
                args: Object.freeze([call.name, String(issue.index + 1), issue.expected, issue.actual]), range: Object.freeze(call.argumentRanges![issue.index]) }));
    }
    const variableTypes = Object.freeze([...occurrences.values()].sort((a, b) => a.range.start - b.range.start || a.range.end - b.range.end)
        .map(value => Object.freeze({ ...value, types: Object.freeze(value.types), elementTypes: value.elementTypes && Object.freeze(value.elementTypes), range: Object.freeze(value.range) })));
    const callTypes = Object.freeze([...calls.values()].map(call => Object.freeze({ range: Object.freeze(call.range), types: Object.freeze(call.value.types),
        elementTypes: call.value.elements && Object.freeze(call.value.elements),
        argumentTypes: call.args?.map(arg => Object.freeze({ ...arg, types: Object.freeze(arg.types), elements: arg.elements ? Object.freeze(arg.elements) : undefined })) })));
    return Object.freeze({ variableTypes, callTypes, diagnostics: Object.freeze(diagnostics) });
}

export function inferVariableTypes(template: SnippetTemplate, options: AnalyzeOptions = {}): readonly VariableTypeInfo[] {
    return inferTemplateTypes(template, options).variableTypes;
}
