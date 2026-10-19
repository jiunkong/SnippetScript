import type { FunctionParameter, ParameterTypes, OverloadArgument } from './functions.js';
import type { SnippetFragment } from './fragment.js';
import type { SnippetTemplate } from './analyzer.js';
export interface ExecutionCheck {
    check(): void;
}
export interface SourceRange {
    readonly start: number;
    readonly end: number;
}
export type TokenKind = 'syntax' | 'parenthesis' | 'keyword' | 'variable' | 'function' | 'randomFunction' | 'typeFunction' | 'snippetFunction' | 'operator' | 'arithmeticOperator' | 'rangeOperator' | 'list' | 'fragmentDelimiter' | 'cursorSyntax' | 'cursor' | 'regex' | 'regexFlag' | 'bool' | 'null' | 'stringEscape';
export interface HighlightToken extends SourceRange {
    readonly kind: TokenKind;
}
export interface Diagnostic {
    readonly code: string;
    readonly args: readonly unknown[];
    readonly severity: 'error' | 'warning';
    readonly range: SourceRange;
}
export interface Region extends SourceRange {
    readonly kind: 'expression' | 'cursorExpression' | 'cursor' | 'argument';
}
export interface SnippetReference extends SourceRange {
    readonly name: string;
    readonly targetId?: string;
    readonly targetIndex?: number;
}
export interface Snippet {
    id?: string;
    name?: string;
    trigger?: string;
    replacement?: string;
    disabled?: boolean;
}
export interface RangeValue {
    readonly type: 'range';
    readonly start: number;
    readonly end: number;
}
export type Value = string | number | boolean | null | undefined | SnippetFragment | RangeValue | readonly Value[];
export type Variables = Record<string | symbol, Value>;
export type ValueType = 'string' | 'number' | 'bool' | 'fragment' | 'list' | 'range' | 'null' | 'undefined' | 'unknown';
export interface VariableTypeInfo {
    readonly name: string;
    readonly range: SourceRange;
    readonly types: readonly ValueType[];
    readonly elementTypes?: readonly ValueType[];
}
export interface CallTypeInfo {
    readonly argumentTypes?: readonly OverloadArgument[];
    readonly range: SourceRange;
    readonly types: readonly ValueType[];
    readonly elementTypes?: readonly ValueType[];
}
export interface CallableOverload {
    readonly id: string;
    readonly parameters: readonly (FunctionParameter & { readonly optional?: boolean; readonly rest?: boolean })[];
    readonly returnTypes: ParameterTypes;
    readonly returnElementTypes?: readonly ValueType[];
}
export interface CallSignature {
    readonly kind: 'function' | 'snippet';
    readonly overloads: readonly CallableOverload[];
    readonly callRange: SourceRange;
    readonly complete: boolean;
    readonly argumentStarts: readonly number[];
    readonly matches: boolean;
    readonly name: string;
    readonly range: SourceRange;
}
export interface Analysis {
    readonly source: string;
    readonly template: SnippetTemplate;
    readonly variableTypes: readonly VariableTypeInfo[];
    readonly callSignatures: readonly CallSignature[];
    readonly tokens: readonly HighlightToken[];
    readonly diagnostics: readonly Diagnostic[];
    readonly references: readonly SnippetReference[];
    readonly regions: readonly Region[];
}
export interface TriggerParameter {
    readonly name: string;
    readonly regex: string;
    readonly flags: string;
    readonly range: SourceRange;
    readonly nameRange: SourceRange;
    readonly regexRange?: SourceRange;
    readonly flagsRange?: SourceRange;
}
export interface TriggerAnalysis extends Omit<Analysis, 'template' | 'variableTypes' | 'callSignatures'> {
    readonly kind: 'literal' | 'regex' | 'invalid';
    readonly literal?: string;
    readonly pattern?: string;
    readonly flags: string;
    readonly parameters: readonly TriggerParameter[];
}
export interface AnalyzeOptions {
    library?: readonly Snippet[] | null;
    variables?: readonly string[];
    variableTypes?: Readonly<Record<string, readonly ValueType[]>>;
    forDepth?: number;
    checkVariables?: boolean;
}
export interface HostRequest {
    readonly name: string;
    readonly args: readonly Value[];
    readonly sourceRange: SourceRange;
}
export interface Host {
    invoke(request: HostRequest, context: {
        signal: AbortSignal;
    }): Value | Promise<Value>;
}
export interface Environment {
    now(): number;
    date(): Date;
    random(): number;
    uuid(): string;
    yield(): Promise<void>;
}
export interface Limits {
    timeoutMs?: number;
    maxCallDepth?: number;
}
export interface ExecuteOptions {
    variables?: Variables;
    library?: readonly Snippet[];
    host?: Host;
    signal?: AbortSignal;
    limits?: Limits;
    environment?: Partial<Environment>;
}
export type Expr = Readonly<({
    kind: 'literal';
    value: Value;
} | {
    kind: 'variable';
    name: string;
} | {
    kind: 'loop';
    name: 'index' | 'value';
} | {
    kind: 'list';
    items: readonly Expr[];
} | {
    kind: 'index';
    target: Expr;
    index: Expr;
} | {
    kind: 'unary';
    operator: string;
    operand: Expr;
} | {
    kind: 'binary';
    operator: string;
    left: Expr;
    right: Expr;
} | {
    kind: 'conditional';
    condition: Expr;
    yes: Expr;
    no: Expr;
} | {
    kind: 'call';
    name: string;
    args: readonly Expr[];
} | {
    kind: 'snippet';
    name: string;
    args: readonly Expr[];
    offset?: Expr;
} | {
    kind: 'fragment';
    template: SnippetTemplate;
})> & {
    readonly range: SourceRange;
};
export interface Assignment {
    readonly range: SourceRange;
    readonly name: string;
    readonly operator?: string;
    readonly expression?: Expr;
}
export type TemplateNode = Readonly<({
    type: 'text';
    value: string;
} | {
    type: 'cursor';
    level: number;
} | {
    type: 'expression' | 'cursorExpression';
    expression: Expr;
} | {
    type: 'set';
    assignments: readonly Assignment[];
} | {
    type: 'break' | 'continue';
} | {
    type: 'for';
    expression: Expr;
    body: SnippetTemplate;
} | {
    type: 'if';
    branches: readonly {
        expression: Expr | null;
        body: SnippetTemplate;
        range: SourceRange;
    }[];
} | {
    type: 'switch';
    expression: Expr;
    cases: readonly {
        expressions: readonly Expr[];
        body: SnippetTemplate;
        range: SourceRange;
    }[];
    defaultBody?: SnippetTemplate;
})> & {
    readonly range: SourceRange;
    readonly offset: number;
};
