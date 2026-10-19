import type { Diagnostic, HighlightToken, Region, SourceRange, TriggerAnalysis, TriggerParameter } from './types.js';

const cache = new Map<string, TriggerAnalysis>();
const validFlags = /^[gimsuy]+$/;

export function escapeRegex(source: string): string {
    return source.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** One scanner owns capture signatures, highlighting and matching syntax. */
export function analyzeTrigger(source: string): TriggerAnalysis {
    const cached = cache.get(source);
    if (cached) return cached;
    const tokens: HighlightToken[] = [];
    const regions: Region[] = [];
    const diagnostics: Diagnostic[] = [];
    const parameters: TriggerParameter[] = [];
    const names = new Set<string>();
    const flags = new Set<string>();
    let pattern = '', position = 0;
    const mark = (kind: HighlightToken['kind'], start: number, end: number) => {
        if (end > start) tokens.push(Object.freeze({ kind, start, end }));
    };
    const fail = (code: string, range: SourceRange, args: unknown[] = []) => {
        diagnostics.push(Object.freeze({ code, args: Object.freeze(args), severity: 'error', range: Object.freeze(range) }));
    };
    while (position < source.length) {
        const start = source.indexOf('${', position);
        if (start === -1) { pattern += escapeRegex(source.slice(position)); break; }
        pattern += escapeRegex(source.slice(position, start));
        const nameStart = start + 2;
        let nameEnd = nameStart;
        while (nameEnd < source.length && source[nameEnd] !== ':' && source[nameEnd] !== '}') nameEnd++;
        const name = source.slice(nameStart, nameEnd);
        let end = nameEnd, regexStart: number | undefined, regexEnd: number | undefined;
        let flagColon: number | undefined, parameterFlags = '', regex = '[^ ]+';
        if (source[nameEnd] === ':') {
            regexStart = nameEnd + 1;
            end = regexStart;
            let braces = 0, parens = 0, inClass = false;
            while (end < source.length) {
                const char = source[end];
                // Preserve regex escapes. An escaped brace is not a template or
                // quantifier delimiter, including escaped braces in classes.
                if (char === '\\') { end = Math.min(end + 2, source.length); continue; }
                if (inClass) { if (char === ']') inClass = false; end++; continue; }
                if (char === '[') { inClass = true; end++; continue; }
                if (char === '{') braces++;
                else if (char === '}') { if (braces === 0) break; braces--; }
                else if (char === '(') parens++;
                else if (char === ')') parens = Math.max(0, parens - 1);
                else if (char === ':' && braces === 0 && parens === 0) flagColon = end;
                end++;
            }
            regexEnd = end;
            if (flagColon !== undefined && validFlags.test(source.slice(flagColon + 1, end))) {
                parameterFlags = source.slice(flagColon + 1, end);
                regexEnd = flagColon;
                for (const flag of parameterFlags) flags.add(flag);
            } else flagColon = undefined;
            regex = source.slice(regexStart, regexEnd);
        }
        if (end >= source.length || source[end] !== '}') {
            mark('syntax', start, start + 2);
            mark('variable', nameStart, nameEnd);
            if (regexStart !== undefined) mark('regex', regexStart, source.length);
            fail('err_trigger_arg_unclosed', { start, end: source.length });
            break;
        }
        const range = Object.freeze({ start, end: end + 1 });
        const nameRange = Object.freeze({ start: nameStart, end: nameEnd });
        const regexRange = regexStart === undefined ? undefined : Object.freeze({ start: regexStart, end: regexEnd! });
        const flagsRange = flagColon === undefined ? undefined : Object.freeze({ start: flagColon + 1, end });
        const parameter: TriggerParameter = Object.freeze({ name, regex, flags: parameterFlags, range, nameRange, regexRange, flagsRange });
        parameters.push(parameter);
        regions.push(Object.freeze({ ...range, kind: 'argument' }));
        mark('syntax', start, start + 2);
        mark('variable', nameStart, nameEnd);
        if (regexStart !== undefined) {
            mark('syntax', nameEnd, regexStart);
            mark('regex', regexStart, regexEnd!);
        }
        if (flagsRange) {
            mark('syntax', flagColon!, flagColon! + 1);
            mark('regexFlag', flagsRange.start, flagsRange.end);
        }
        mark('syntax', end, end + 1);
        if (!/^[\p{L}_][\p{L}\p{N}_]*$/u.test(name)) fail('err_trigger_arg_name', name ? nameRange : range, [name]);
        else if (names.has(name)) fail('err_trigger_arg_duplicate', nameRange, [name]);
        names.add(name);
        if (!regex) fail('err_trigger_arg_regex_required', regexRange && regexRange.end > regexRange.start ? regexRange : range);
        pattern += `(?<${name}>${regex})`;
        position = end + 1;
    }
    const combinedFlags = [...flags].join('');
    if (parameters.length && diagnostics.length === 0) {
        try { new RegExp(pattern + '$', combinedFlags); }
        catch (error) {
            const range = parameters.length === 1 ? parameters[0].regexRange || parameters[0].range : { start: parameters[0].range.start, end: parameters.at(-1)!.range.end };
            fail('err_trigger_regex_invalid', range, [error instanceof Error ? error.message : String(error)]);
        }
    }
    const kind = diagnostics.length ? 'invalid' : parameters.length ? 'regex' : 'literal';
    const result: TriggerAnalysis = Object.freeze({
        source, kind, literal: kind === 'literal' ? source : undefined,
        pattern: kind === 'regex' ? pattern + '$' : undefined, flags: combinedFlags,
        parameters: Object.freeze(parameters), tokens: Object.freeze(tokens.sort((a, b) => a.start - b.start)),
        regions: Object.freeze(regions), diagnostics: Object.freeze(diagnostics), references: Object.freeze([]),
    });
    if (cache.size >= 128) cache.delete(cache.keys().next().value!);
    cache.set(source, result);
    return result;
}

export function snippetParameterNames(trigger: string | TriggerAnalysis = ''): string[] {
    const analysis = typeof trigger === 'string' ? analyzeTrigger(trigger) : trigger;
    return analysis.parameters.map(parameter => parameter.name);
}

/** Return a fresh RegExp: lastIndex must never be shared through the cache. */
export function compileTrigger(trigger: string | TriggerAnalysis) {
    const analysis = typeof trigger === 'string' ? analyzeTrigger(trigger) : trigger;
    if (analysis.kind === 'regex') return { isRegex: true, regex: new RegExp(analysis.pattern!, analysis.flags), literal: undefined, error: undefined };
    const diagnostic = analysis.diagnostics[0];
    return { isRegex: false, regex: undefined, literal: analysis.source,
        error: diagnostic ? `${diagnostic.code}: ${diagnostic.args.join(', ')}` : undefined };
}
