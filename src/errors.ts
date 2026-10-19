import type { SourceRange, Diagnostic } from './types.js';
export class SnippetError extends Error {
    readonly messageKey: string;
    readonly messageValues: unknown[];
    snippetOffset?: number;
    snippetLocation?: {
        snippetName: string;
        offset: number;
        line: number;
        column: number;
    };
    sourceRange?: SourceRange;
    callTrace: string[] = [];
    constructor(public code: string, public args: unknown[] = [], public range?: SourceRange) {
        super(`${code}: ${args.join(', ')}`);
        this.name = 'SnippetError';
        this.messageKey = code;
        this.messageValues = args;
        this.sourceRange = range;
        this.snippetOffset = range?.start;
    }
    toDiagnostic(): Diagnostic { return { code: this.code, args: this.args, severity: 'error', range: this.range || { start: 0, end: 0 } }; }
}
export function createSnippetError(code: string, args: unknown[] = [], _fallback = '') { return new SnippetError(code, args); }
