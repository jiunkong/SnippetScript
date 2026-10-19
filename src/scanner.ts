export interface ParseError {
    error: string;
}
export interface ParsedName {
    error?: undefined;
    name: string;
    nameEnd: number;
}
export interface ParsedCall extends ParsedName {
    argsStart: number;
    argsEnd: number;
    end: number;
    offsetStart: number | null;
    offsetEnd: number | null;
    offsetOpenStart?: number;
    offsetCloseEnd?: number;
}
export function snippetParameterNames(trigger?: string) {
    return [...String(trigger || '').matchAll(/\$\{([^:}]+)(?::([^}]+))?\}/g)].map(match => match[1]);
}
// Read an entire quoted value. Backtick fragments may contain template tags,
// whose expressions can themselves contain quoted values or nested fragments.
export function scanSnippetQuotedValue(text: string, start: number, execution?: {
    check(): void;
}) {
    const stack = [{ kind: text[start], start }];
    let i = start + 1;
    while (i < text.length) {
        execution?.check();
        const frame = stack[stack.length - 1];
        const char = text[i];
        if (frame.kind === 'tag') {
            if (char === '"' || char === "'" || char === '`') {
                stack.push({ kind: char, start: i++ });
            }
            else if (text.startsWith('}}', i)) {
                stack.pop();
                i += 2;
            }
            else
                i++;
        }
        else if (char === '\\')
            i += 2;
        else if (char === frame.kind) {
            stack.pop();
            i++;
            if (!stack.length)
                return { end: i };
        }
        else if (frame.kind === '`' && text.startsWith('{{', i) && text[i + 2] !== '{') {
            stack.push({ kind: 'tag', start: i });
            i += 2;
        }
        else
            i++;
    }
    const frame = stack[stack.length - 1];
    return { error: frame.kind === 'tag' ? 'err_template_unclosed_tag'
            : frame.kind === '`' ? 'err_unclosed_fragment_literal' : 'err_unclosed_string', offset: frame.start };
}
// Only the fragment's own text decodes escaped backticks/backslashes. Quoted
// expressions retain their spelling for their respective parsers.
export function decodeSnippetFragmentLiteral(token: string) {
    let text = '';
    const offsets: number[] = [];
    for (let i = 1; i < token.length - 1; i++) {
        if (token.startsWith('{{', i) && token[i + 2] !== '{') {
            let end = i + 2;
            while (end < token.length - 1 && !token.startsWith('}}', end)) {
                if (token[end] === '"' || token[end] === "'" || token[end] === '`') {
                    const quoted = scanSnippetQuotedValue(token, end);
                    if (quoted.error !== undefined)
                        break;
                    end = quoted.end;
                }
                else
                    end++;
            }
            end += 2;
            for (; i < end; i++) {
                offsets.push(i);
                text += token[i];
            }
            i--;
        }
        else {
            const offset = i;
            if (token[i] === '\\' && (token[i + 1] === '`' || token[i + 1] === '\\'))
                i++;
            offsets.push(offset);
            text += token[i];
        }
    }
    return { text, offsets };
}
// Shared by template execution and options validation. Offsets may precede or
// follow the required argument list; nested calls and quoted delimiters are safe.
export function parseSnippetFunctionName(text: string, start = 0): ParsedName | ParseError {
    if (text[start] !== '@')
        return { error: 'err_snippet_call_syntax' };
    const quote = text[start + 1];
    if (quote === '"' || quote === "'") {
        let name = '';
        for (let i = start + 2; i < text.length; i++) {
            const char = text[i];
            if (char === quote)
                return name ? { name, nameEnd: i + 1 } : { error: 'err_snippet_call_syntax' };
            if (char === '\n' || char === '\r')
                break;
            if (char === '\\' && (text[i + 1] === quote || text[i + 1] === '\\'))
                name += text[++i];
            else
                name += char;
        }
        return { error: 'err_snippet_call_syntax' };
    }
    const name = text.slice(start).match(/^@([\p{L}_][\p{L}\p{N}_]*)/u);
    return name ? { name: name[1], nameEnd: start + name[0].length } : { error: 'err_snippet_call_syntax' };
}
export function parseSnippetCall(text: string, start = 0): ParsedCall | ParseError {
    const parsedName = parseSnippetFunctionName(text, start);
    if (parsedName.error !== undefined)
        return parsedName;
    let position = parsedName.nameEnd;
    const call: any = { ...parsedName, offsetStart: null, offsetEnd: null };
    while (true) {
        while (/\s/.test(text[position] || '') && position < text.length)
            position++;
        const open = text.startsWith('&lt;', position) ? '&lt;' : text[position];
        if (open === '[')
            return { error: 'err_snippet_call_syntax' };
        if (open !== '(' && open !== '<' && open !== '&lt;')
            break;
        const offset = open !== '(';
        if ((offset && call.offsetStart !== null) || (!offset && call.argsStart !== undefined)) {
            return { error: 'err_snippet_call_syntax' };
        }
        const openStart = position;
        position += open.length;
        const from = position;
        const stack = [offset ? '>' : ')'];
        let closeStart = position;
        let quote = null;
        for (; position < text.length && stack.length; position++) {
            const char = text[position];
            if (quote) {
                if (char === '\\')
                    position++;
                else if (char === quote)
                    quote = null;
            }
            else if (char === '`') {
                const literal = scanSnippetQuotedValue(text, position);
                if (literal.error !== undefined)
                    return { error: literal.error };
                position = literal.end - 1;
            }
            else if (char === '"' || char === "'")
                quote = char;
            else if (char === '@') {
                const nested = parseSnippetCall(text, position);
                if (nested.error !== undefined)
                    return nested;
                position = nested.end - 1;
            }
            else if (offset && stack.length === 1 && (char === '>' || text.startsWith('&gt;', position))) {
                closeStart = position;
                if (char !== '>')
                    position += 3;
                stack.pop();
            }
            else if (char === '(' || char === '[')
                stack.push(char === '(' ? ')' : ']');
            else if (char === ')' || char === ']') {
                if (stack.pop() !== char)
                    return { error: 'err_snippet_call_syntax' };
            }
        }
        if (stack.length)
            return { error: 'err_snippet_call_syntax' };
        if (offset) {
            call.offsetOpenStart = openStart;
            call.offsetCloseEnd = position;
            call.offsetStart = from;
            call.offsetEnd = closeStart;
            if (!text.slice(from, closeStart).trim())
                return { error: 'err_snippet_cursor_offset' };
        }
        else {
            call.argsStart = from;
            call.argsEnd = position - 1;
        }
        call.end = position;
    }
    return call.argsStart === undefined ? { error: 'err_snippet_call_syntax' } : call;
}
