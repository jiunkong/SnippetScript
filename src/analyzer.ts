import type { Analysis, AnalyzeOptions, Assignment, Diagnostic, Expr, HighlightToken, Region, SnippetReference, SourceRange, TemplateNode, TokenKind } from './types.js';
import { SnippetError, createSnippetError } from './errors.js';
import { decodeSnippetFragmentLiteral, parseSnippetCall, scanSnippetQuotedValue, snippetParameterNames } from './scanner.js';
import { FUNCTIONS, validateFunction } from './functions.js';
export class SnippetTemplate {
    readonly source: string;
    readonly nodes: readonly TemplateNode[];
    constructor(source: string, nodes: readonly TemplateNode[]) {
        this.source = source;
        this.nodes = deepFreeze([...nodes]);
        Object.freeze(this);
    }
}
interface Scope {
    variables: Set<string>;
    forDepth: number;
    breakDepth: number;
}
interface State {
    source: string;
    options: AnalyzeOptions;
    tokens: HighlightToken[];
    diagnostics: Diagnostic[];
    regions: Region[];
    references: SnippetReference[];
}
const own = (object: object, key: PropertyKey) => Object.prototype.hasOwnProperty.call(object, key);
const cloneScope = (scope: Scope): Scope => ({ ...scope, variables: new Set(scope.variables) });
function rangeOf(map: readonly number[], start: number, end: number): SourceRange {
    return { start: map[start] ?? map.at(-1) ?? 0, end: end > start ? (map[end - 1] ?? map.at(-1) ?? 0) + 1 : map[start] ?? map.at(-1) ?? 0 };
}
function token(state: State, kind: TokenKind, range: SourceRange) { if (range.end > range.start)
    state.tokens.push({ ...range, kind }); }
function report(state: State, error: any, fallback: SourceRange) {
    state.diagnostics.push(Object.freeze({ code: error.code || error.messageKey || 'err_template_syntax', args: Object.freeze(error.args || error.messageValues || []), severity: 'error', range: Object.freeze(error.range || fallback) }));
}
function fail(code: string, range: SourceRange, args: unknown[] = []): never { throw new SnippetError(code, args, range); }
const precedences: Record<string, number> = { '~': 1, '||': 2, '&&': 3, '==': 4, '!=': 4, '>': 4, '<': 4, '>=': 4, '<=': 4, '+': 5, '-': 5, '*': 6, '/': 6, '%': 6 };
interface Lex {
    text: string;
    start: number;
    end: number;
    type: string;
    data?: any;
}
class ExpressionParser {
    position = 0;
    current: Lex;
    constructor(readonly text: string, readonly map: readonly number[], readonly state: State, readonly scope: Scope) { this.current = this.next(); }
    range(start: number, end: number) { return rangeOf(this.map, start, end); }
    next(): Lex {
        while (/\s/.test(this.text[this.position] || '') && this.position < this.text.length)
            this.position++;
        const start = this.position, char = this.text[start];
        if (!char)
            return { text: '', start, end: start, type: 'eof' };
        if (char === '"' || char === "'" || char === '`') {
            const scan = scanSnippetQuotedValue(this.text, start);
            if (scan.error !== undefined)
                fail(scan.error, this.range(scan.offset ?? start, this.text.length));
            this.position = scan.end!;
            return { text: this.text.slice(start, this.position), start, end: this.position, type: char === '`' ? 'fragment' : 'string' };
        }
        if (char === '@') {
            const call = parseSnippetCall(this.text, start);
            if (call.error !== undefined)
                fail(call.error, this.range(start, this.text.length));
            this.position = call.end;
            return { text: this.text.slice(start, call.end), start, end: call.end, type: 'snippet', data: call };
        }
        const variable = this.text.slice(start).match(/^\$[\p{L}\p{N}_]+/u);
        const numeric = this.text.slice(start).match(/^(?:0[xX][\da-fA-F]+|0[bB][01]+|0[oO][0-7]+|(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?)/);
        const identifier = this.text.slice(start).match(/^[\p{L}_][\p{L}\p{N}_]*/u);
        const match = variable || numeric || identifier;
        if (match) {
            this.position += match[0].length;
            return { text: match[0], start, end: this.position, type: variable ? 'variable' : numeric ? 'number' : 'identifier' };
        }
        const two = this.text.slice(start, start + 2);
        this.position += ['==', '!=', '<=', '>=', '&&', '||'].includes(two) ? 2 : 1;
        return { text: this.text.slice(start, this.position), start, end: this.position, type: 'punctuation' };
    }
    advance() { const item = this.current; this.current = this.next(); return item; }
    mark(item: Lex, kind: TokenKind) { token(this.state, kind, this.range(item.start, item.end)); }
    expected(text: string, code = 'err_missing_operand') {
        if (this.current.text !== text)
            fail(this.current.text === ']' && text === ')' ? 'err_list_syntax' : code, this.range(this.current.start, this.current.end), ['err_list_syntax', 'err_list_index_integer'].includes(code) || this.current.text === ']' && text === ')' ? [] : [this.text]);
        return this.advance();
    }
    parse(min = 0): Expr {
        let left = this.atom();
        while (this.current.type !== 'eof') {
            const next = this.current;
            if (next.text === '[') {
                this.advance();
                this.mark(next, 'list');
                if (this.current.text === ']' || this.current.text === ',')
                    fail('err_list_index_integer', this.range(next.start, this.current.end));
                const index = this.parse();
                const close = this.expected(']', 'err_list_index_integer');
                this.mark(close, 'list');
                if (left.kind === 'literal' && typeof left.value !== 'string')
                    report(this.state, createSnippetError('err_list_index_target'), left.range);
                if (index.kind === 'literal' && (typeof index.value !== 'number' || !Number.isSafeInteger(index.value)))
                    report(this.state, createSnippetError('err_list_index_integer'), index.range);
                left = { kind: 'index', target: left, index, range: { start: left.range.start, end: this.range(close.start, close.end).end } };
                continue;
            }
            if (next.text === '?' && min === 0) {
                this.advance();
                this.mark(next, 'operator');
                const yes = this.parse();
                const colon = this.expected(':');
                this.mark(colon, 'operator');
                const no = this.parse();
                left = { kind: 'conditional', condition: left, yes, no, range: { start: left.range.start, end: no.range.end } };
                continue;
            }
            const precedence = precedences[next.text];
            if (precedence === undefined || precedence < min)
                break;
            if (next.text === '~' && left.kind === 'binary' && left.operator === '~')
                fail('err_range_both_values_required', this.range(next.start, next.end), [this.text]);
            this.advance();
            this.mark(next, 'operator');
            if (['', ')', ']', ',', ':', '~'].includes(this.current.text))
                fail(next.text === '~' ? 'err_range_both_values_required' : 'err_missing_operand', this.range(next.start, next.end), [this.text]);
            const right = this.parse(precedence + 1);
            left = { kind: 'binary', operator: next.text, left, right, range: { start: left.range.start, end: right.range.end } };
        }
        return left;
    }
    arguments(close: string, errorCode: string): Expr[] {
        const items: Expr[] = [];
        if (this.current.text === close)
            return items;
        while (true) {
            if (!this.current.text || this.current.text === ',' || this.current.text === close)
                fail(errorCode, this.range(this.current.start, this.current.end));
            items.push(this.parse());
            if (this.current.text !== ',')
                break;
            const comma = this.advance();
            this.mark(comma, close === ']' ? 'list' : 'syntax');
            if (this.current.text === close)
                fail(errorCode, this.range(comma.start, comma.end));
        }
        return items;
    }
    atom(): Expr {
        const item = this.advance(), range = this.range(item.start, item.end);
        if (item.type === 'number')
            return { kind: 'literal', value: /^0[xXbBoO]/.test(item.text) ? parseFloat(item.text) : Number(item.text), range };
        if (item.type === 'string')
            return { kind: 'literal', value: item.text.slice(1, -1), range };
        if (item.type === 'variable') {
            this.mark(item, 'variable');
            const name = item.text.slice(1);
            if (this.state.options.checkVariables !== false && !this.scope.variables.has(name))
                report(this.state, createSnippetError('err_undefined_variable', [item.text]), range);
            return { kind: 'variable', name, range };
        }
        if (item.type === 'fragment') {
            this.mark({ ...item, end: item.start + 1 }, 'fragmentDelimiter');
            this.mark({ ...item, start: item.end - 1 }, 'fragmentDelimiter');
            const decoded = decodeSnippetFragmentLiteral(item.text);
            const map = decoded.offsets.map(offset => this.map[item.start + offset]);
            const scope = cloneScope(this.scope);
            scope.breakDepth = 0;
            return { kind: 'fragment', template: parseBody(decoded.text, map, this.state, scope), range };
        }
        if (item.type === 'snippet') {
            const call = item.data;
            token(this.state, 'snippetFunction', this.range(item.start, call.nameEnd));
            const args = this.subArguments(call.argsStart, call.argsEnd);
            for (const index of [call.argsStart - 1, call.argsEnd, call.offsetOpenStart, call.offsetEnd]) {
                if (index !== undefined && index !== null)
                    token(this.state, 'snippetFunction', this.range(index, index + 1));
            }
            let offset: Expr | undefined;
            if (call.offsetStart !== null) {
                try {
                    offset = expression(this.text.slice(call.offsetStart, call.offsetEnd), this.map.slice(call.offsetStart, call.offsetEnd), this.state, this.scope);
                }
                catch (error) {
                    if (error.code === 'err_missing_operand' && this.text.slice(call.offsetStart, call.offsetEnd).includes(','))
                        fail('err_snippet_call_syntax', range);
                    throw error;
                }
                const numeric = this.text.slice(call.offsetStart, call.offsetEnd).trim();
                if (/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(numeric) && (!Number.isSafeInteger(Number(numeric)) || Number(numeric) < 0))
                    report(this.state, createSnippetError('err_snippet_cursor_offset'), offset.range);
            }
            const library = this.state.options.library;
            const matches = library?.map((snippet, index) => ({ snippet, index })).filter(entry => entry.snippet.name === call.name);
            if (matches && matches.length !== 1)
                report(this.state, createSnippetError('err_snippet_call_target', [call.name]), range);
            else if (matches?.length && args.length !== snippetParameterNames(matches[0].snippet.trigger).length)
                report(this.state, createSnippetError('err_snippet_call_args', [call.name, snippetParameterNames(matches[0].snippet.trigger).length]), range);
            this.state.references.push({ ...this.range(item.start, call.nameEnd), name: call.name, targetId: matches?.length === 1 ? matches[0].snippet.id : undefined, targetIndex: matches?.length === 1 ? matches[0].index : undefined });
            return { kind: 'snippet', name: call.name, args, offset, range };
        }
        if (item.text === '(') {
            token(this.state, 'syntax', range);
            if (this.current.text === ')')
                fail('err_missing_operand', range, ['()']);
            const node = this.parse();
            const close = this.expected(')', 'err_unmatched_open_paren');
            this.mark(close, 'syntax');
            return node;
        }
        if (item.text === '[') {
            this.mark(item, 'list');
            const items = this.arguments(']', 'err_list_syntax');
            const close = this.expected(']', 'err_list_syntax');
            this.mark(close, 'list');
            return { kind: 'list', items, range: { start: range.start, end: this.range(close.start, close.end).end } };
        }
        if (item.text === '+' || item.text === '-') {
            this.mark(item, 'operator');
            const operand = this.parse(7);
            return { kind: 'unary', operator: item.text, operand, range: { start: range.start, end: operand.range.end } };
        }
        if (item.text === '~')
            fail('err_range_both_values_required', range, [this.text]);
        if (item.type === 'identifier') {
            if (this.current.text === '(') {
                const open = this.advance();
                const spec = own(FUNCTIONS, item.text) ? FUNCTIONS[item.text] : undefined;
                token(this.state, spec?.kind || 'function', this.range(item.start, open.end));
                let args: Expr[];
                try {
                    args = this.arguments(')', 'err_function_arguments');
                }
                catch (error) {
                    if (error.code === 'err_function_arguments')
                        validateFunction(item.text, 0, true);
                    throw error;
                }
                const close = this.expected(')', 'err_unmatched_open_paren');
                this.mark(close, spec?.kind || 'function');
                try {
                    validateFunction(item.text, args.length);
                }
                catch (error) {
                    report(this.state, error, range);
                }
                return { kind: 'call', name: item.text, args, range: { start: range.start, end: this.range(close.start, close.end).end } };
            }
            if (item.text === 'index' || item.text === 'value') {
                this.mark(item, 'variable');
                if (!this.scope.forDepth)
                    report(this.state, createSnippetError(item.text === 'index' ? 'err_index_outside_for' : 'err_value_outside_for'), range);
                return { kind: 'loop', name: item.text, range };
            }
            if (['true', 'false', 'null', 'undefined'].includes(item.text)) {
                if (item.text !== 'undefined')
                    this.mark(item, item.text === 'null' ? 'null' : 'bool');
                return { kind: 'literal', value: item.text === 'true' ? true : item.text === 'false' ? false : item.text === 'null' ? null : undefined, range };
            }
            fail('err_unknown_tag', range, [item.text]);
        }
        fail(item.text === '$' ? 'err_var_name_required' : 'err_missing_operand', range, [this.text]);
    }
    subArguments(start: number, end: number): Expr[] {
        if (!this.text.slice(start, end).trim())
            return [];
        const parser = new ExpressionParser(this.text.slice(start, end), this.map.slice(start, end), this.state, this.scope);
        const args: Expr[] = [];
        while (parser.current.type !== 'eof') {
            if (parser.current.text === ',')
                fail('err_snippet_call_syntax', parser.range(parser.current.start, parser.current.end));
            args.push(parser.parse());
            if (parser.current.type === 'eof')
                break;
            const comma = parser.expected(',', 'err_snippet_call_syntax');
            parser.mark(comma, 'syntax');
            if (parser.current.type === 'eof')
                fail('err_snippet_call_syntax', parser.range(comma.start, comma.end));
        }
        return args;
    }
}
function expression(text: string, map: readonly number[], state: State, scope: Scope): Expr {
    const parser = new ExpressionParser(text, map, state, scope);
    const result = parser.parse();
    if (parser.current.type !== 'eof') {
        const char = parser.current.text;
        fail(char === '=' ? 'err_assignment_instead_of_comparison' : char === '&' || char === '|' ? 'err_logical_operator_single' : char === ']' ? 'err_list_syntax' : char === ')' ? 'err_unmatched_close_paren' : 'err_missing_operand', parser.range(parser.current.start, parser.current.end), char === ']' ? [] : [text]);
    }
    return result;
}
export function parseExpression(source: string): Expr {
    const state: State = { source, options: { checkVariables: false, forDepth: 1 }, tokens: [], diagnostics: [], regions: [], references: [] };
    const node = expression(source, Array.from({ length: source.length }, (_, i) => i), state, { variables: new Set(), forDepth: 1, breakDepth: 0 });
    if (state.diagnostics.length) {
        const d = state.diagnostics[0];
        throw new SnippetError(d.code, [...d.args], d.range);
    }
    return deepFreeze(node);
}
function normalize(source: string, inputMap: readonly number[]) {
    let text = '';
    const map: number[] = [];
    let from = 0;
    for (const match of [...source.matchAll(/\\(?:\r\n|\n|\r)\s*/g), { index: source.length, 0: '' }]) {
        text += source.slice(from, match.index);
        for (let i = from; i < match.index!; i++)
            map.push(inputMap[i]);
        from = match.index! + match[0].length;
    }
    return { text, map };
}
interface Frame {
    type: string;
    nodes: TemplateNode[];
    scope: Scope;
    range: SourceRange;
    expression?: Expr;
    branches?: any[];
    cases?: any[];
    defaultBody?: SnippetTemplate;
    expressions?: Expr[];
    hasElse?: boolean;
}
function parseBody(raw: string, inputMap: readonly number[], state: State, initialScope: Scope): SnippetTemplate {
    const { text, map } = normalize(raw, inputMap);
    const root: Frame = { type: 'root', nodes: [], scope: initialScope, range: rangeOf(map, 0, text.length) };
    const stack: Frame[] = [root];
    const body = (frame: Frame) => new SnippetTemplate(state.source, frame.nodes);
    let position = 0;
    while (position < text.length) {
        let start = text.indexOf('{{', position);
        while (start !== -1 && text[start + 2] === '{')
            start = text.indexOf('{{', start + 1);
        if (start === -1)
            start = text.length;
        let frame = stack.at(-1)!;
        if (start > position) {
            const range = rangeOf(map, position, start);
            frame.nodes.push({ type: 'text', value: text.slice(position, start), range, offset: range.start });
        }
        if (start === text.length)
            break;
        let end = start + 2;
        try {
            while (end < text.length && !text.startsWith('}}', end)) {
                if (['"', "'", '`'].includes(text[end])) {
                    const quoted = scanSnippetQuotedValue(text, end);
                    if (quoted.error)
                        fail(quoted.error, rangeOf(map, start, text.length));
                    end = quoted.end!;
                }
                else
                    end++;
            }
            if (end >= text.length - 1)
                fail('err_template_unclosed_tag', rangeOf(map, start, text.length));
            const range = rangeOf(map, start, end + 2);
            position = end + 2;
            const content = text.slice(start + 2, end), tag = content.trim();
            const tagStart = start + 2 + content.indexOf(tag), tagEnd = tagStart + tag.length;
            const expr = (from: number, to = tagEnd) => expression(text.slice(from, to), map.slice(from, to), state, frame.scope);
            const syntax = (cursor = false) => { token(state, cursor ? 'cursorSyntax' : 'syntax', rangeOf(map, start, start + 2)); token(state, cursor ? 'cursorSyntax' : 'syntax', rangeOf(map, end, end + 2)); };
            const node = (value: any) => frame.nodes.push({ ...value, range, offset: range.start });
            if (!tag)
                fail('err_unknown_tag', range, ['']);
            const keyword = tag.match(/^(if|elif|else|endif|for|endfor|set|switch|endswitch|case|endcase|default|enddefault|break|continue)\b/);
            if (keyword) {
                syntax();
                token(state, 'keyword', rangeOf(map, tagStart, tagStart + keyword[0].length));
                const type = keyword[0];
                let from = tagStart + type.length;
                while (/\s/.test(text[from] || '') && from < tagEnd)
                    from++;
                if (from < tagEnd)
                    state.regions.push({ ...rangeOf(map, from, tagEnd), kind: 'expression' });
                if (['if', 'for', 'switch', 'case'].includes(type)) {
                    if (type === 'case' && frame.type !== 'switch')
                        fail('err_template_syntax', range, [tag]);
                    const scope = cloneScope(frame.scope);
                    const expressions: Expr[] = [];
                    if (type === 'case') {
                        const parser = new ExpressionParser(text.slice(from, tagEnd), map.slice(from, tagEnd), state, frame.scope);
                        while (parser.current.type !== 'eof') {
                            expressions.push(parser.parse());
                            if (parser.current.type === 'eof')
                                break;
                            parser.expected(',');
                        }
                        if (!expressions.length)
                            fail('err_missing_operand', range, [tag]);
                    }
                    const condition = type === 'case' ? undefined : expr(from);
                    if (type === 'for') {
                        scope.forDepth++;
                        scope.breakDepth++;
                    }
                    stack.push({ type, nodes: [], scope, range, expression: condition, expressions, branches: type === 'if' ? [] : undefined, cases: type === 'switch' ? [] : undefined });
                }
                else if (type === 'elif' || type === 'else') {
                    if (frame.type !== 'if' || frame.hasElse)
                        fail('err_elif_else_outside_if', range);
                    frame.branches!.push({ expression: frame.expression ?? null, body: body(frame), range: frame.range });
                    frame.nodes = [];
                    frame.scope = cloneScope(stack.at(-2)!.scope);
                    frame.expression = type === 'else' ? undefined : expr(from);
                    frame.hasElse = type === 'else';
                    frame.range = range;
                }
                else if (type === 'default') {
                    if (frame.type !== 'switch')
                        fail('err_template_syntax', range, [tag]);
                    stack.push({ type, nodes: [], scope: cloneScope(frame.scope), range });
                }
                else if (type.startsWith('end')) {
                    if (frame.type !== type.slice(3))
                        fail(({ endif: 'err_endif_no_if', endfor: 'err_endfor_no_for', endswitch: 'err_endswitch_no_switch', endcase: 'err_endcase_no_case', enddefault: 'err_enddefault_no_default' } as Record<string, string>)[type] || 'err_template_syntax', range);
                    stack.pop();
                    const parent = stack.at(-1)!;
                    const common = { range: frame.range, offset: frame.range.start };
                    if (frame.type === 'if') {
                        frame.branches!.push({ expression: frame.expression ?? null, body: body(frame), range: frame.range });
                        parent.nodes.push({ ...common, range: frame.branches![0].range, offset: frame.branches![0].range.start, type: 'if', branches: frame.branches! });
                    }
                    else if (frame.type === 'for')
                        parent.nodes.push({ ...common, type: 'for', expression: frame.expression!, body: body(frame) });
                    else if (frame.type === 'switch')
                        parent.nodes.push({ ...common, type: 'switch', expression: frame.expression!, cases: frame.cases!, defaultBody: frame.defaultBody });
                    else if (frame.type === 'case')
                        parent.cases!.push({ expressions: frame.expressions!, body: body(frame), range: frame.range });
                    else
                        parent.defaultBody = body(frame);
                }
                else if (type === 'break' || type === 'continue') {
                    if (from < tagEnd || !frame.scope.breakDepth)
                        fail('err_loop_control_outside_for', range, [type]);
                    node({ type });
                }
                else if (type === 'set') {
                    const parser = new ExpressionParser(text.slice(from, tagEnd), map.slice(from, tagEnd), state, frame.scope);
                    const assignments: Assignment[] = [];
                    while (parser.current.type !== 'eof') {
                        const name = parser.advance();
                        if (name.type !== 'variable')
                            fail('err_var_name_required', parser.range(name.start, name.end), [name.text]);
                        parser.mark(name, 'variable');
                        let operator: string | undefined;
                        let value: Expr | undefined;
                        if (parser.current.text !== ',' && parser.current.type !== 'eof') {
                            const op = parser.advance();
                            operator = op.text;
                            if (['+', '-', '*', '/', '%'].includes(operator) && parser.current.text === '=') {
                                parser.advance();
                                operator += '=';
                            }
                            if (!['=', '+=', '-=', '*=', '/=', '%='].includes(operator))
                                fail('err_template_syntax', range, [tag]);
                            token(state, 'operator', parser.range(op.start, parser.current.start));
                            value = parser.parse();
                        }
                        assignments.push({ name: name.text.slice(1), operator, expression: value });
                        frame.scope.variables.add(name.text.slice(1));
                        if (parser.current.type === 'eof')
                            break;
                        const comma = parser.expected(',', 'err_template_syntax');
                        parser.mark(comma, 'syntax');
                        if (parser.current.type === 'eof')
                            fail('err_template_syntax', range, [tag]);
                    }
                    if (!assignments.length)
                        fail('err_template_syntax', range, [tag]);
                    node({ type: 'set', assignments });
                }
            }
            else if (tag === 'cursor' || /^#\s*(cursor|\d+)$/.test(tag)) {
                syntax(true);
                token(state, 'cursor', rangeOf(map, tagStart, tagEnd));
                state.regions.push({ ...range, kind: 'cursor' });
                const level = tag === 'cursor' || /^#\s*cursor$/.test(tag) ? 0 : Number(tag.slice(1).trim());
                if (!Number.isSafeInteger(level) || level < 0)
                    fail('err_cursor_level', range);
                node({ type: 'cursor', level });
            }
            else {
                const cursor = tag.startsWith('#');
                syntax(cursor);
                if (cursor)
                    token(state, 'cursorSyntax', rangeOf(map, tagStart, tagStart + 1));
                state.regions.push({ ...rangeOf(map, cursor ? tagStart + 1 : start + 2, end), kind: cursor ? 'cursorExpression' : 'expression' });
                node({ type: cursor ? 'cursorExpression' : 'expression', expression: expr(tagStart + (cursor ? 1 : 0)) });
            }
        }
        catch (error) {
            report(state, error, rangeOf(map, start, Math.min(end + 2, text.length)));
            if (position <= start)
                position = Math.min(end + 2, text.length);
        }
    }
    for (const frame of stack.slice(1))
        report(state, createSnippetError(({ if: 'err_if_unclosed', for: 'err_for_unclosed', switch: 'err_switch_unclosed', case: 'err_case_unclosed', default: 'err_default_unclosed' } as Record<string, string>)[frame.type]), frame.range);
    return body(root);
}
function deepFreeze<T>(value: T): T {
    if (value && typeof value === 'object' && !Object.isFrozen(value)) {
        for (const child of Object.values(value))
            deepFreeze(child);
        Object.freeze(value);
    }
    return value;
}
export function analyze(source: string, options: AnalyzeOptions = {}): Analysis {
    const state: State = { source, options, tokens: [], diagnostics: [], regions: [], references: [] };
    const template = parseBody(source, Array.from({ length: source.length }, (_, i) => i), state, { variables: new Set(options.variables || []), forDepth: options.forDepth || 0, breakDepth: 0 });
    // Freeze children even though SnippetTemplate itself was frozen during construction.
    for (const node of template.nodes)
        deepFreeze(node);
    state.tokens.sort((a, b) => a.start - b.start || a.end - b.end);
    state.diagnostics.sort((a, b) => a.range.start - b.range.start);
    return deepFreeze({ source, template, tokens: state.tokens, diagnostics: state.diagnostics, references: state.references, regions: state.regions });
}
export function analyzeTrigger(source: string): Omit<Analysis, 'template'> {
    const state: State = { source, options: {}, tokens: [], diagnostics: [], regions: [], references: [] };
    const regex = /\$\{([^:}]+)(?::((?:[^{}]|\{[^{}]*\})*))?\}/gu;
    for (const match of source.matchAll(regex)) {
        const start = match.index!, end = start + match[0].length, name = match[1], inner = match[2];
        if (!inner) {
            report(state, createSnippetError('err_trigger_arg_regex_required'), { start, end });
            continue;
        }
        token(state, 'syntax', { start, end: start + 2 });
        token(state, 'variable', { start: start + 2, end: start + 2 + name.length });
        token(state, 'syntax', { start: start + 2 + name.length, end: start + 3 + name.length });
        let regexEnd = end - 1;
        const flag = inner.match(/:([gimsuy]+)$/);
        if (flag && inner.length > flag[0].length) {
            const flagStart = end - 1 - flag[1].length;
            token(state, 'syntax', { start: flagStart - 1, end: flagStart });
            token(state, 'regexFlag', { start: flagStart, end: end - 1 });
            regexEnd = flagStart - 1;
        }
        token(state, 'regex', { start: start + 3 + name.length, end: regexEnd });
        token(state, 'syntax', { start: end - 1, end });
        state.regions.push({ start, end, kind: 'argument' });
    }
    return deepFreeze({ source, tokens: state.tokens.sort((a, b) => a.start - b.start), diagnostics: state.diagnostics, references: [], regions: state.regions });
}
