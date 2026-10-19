import { createSnippetError } from './errors.js';
import type { TokenKind } from './types.js';
export interface FunctionSpec {
    readonly min: number;
    readonly max: number;
    readonly kind: TokenKind;
    readonly host?: boolean;
    readonly userInput?: boolean;
}
const arities: Record<string, readonly [
    number,
    number
]> = {
    url: [0, 0], domain: [0, 0], title: [0, 0], uuid: [0, 0], bs: [0, 0], backspace: [0, 0], paste: [0, 0],
    date: [0, 1], time: [0, 1], datetime: [0, 1], prompt: [0, 1], random: [1, Infinity], choice: [2, Infinity],
    upper: [1, 1], lower: [1, 1], trim: [1, 1], capitalize: [1, 1], substr: [2, 3], replace: [3, 3], len: [1, 1],
    startswith: [2, 2], endswith: [2, 2], includes: [2, 2], toast: [2, 2], copy: [1, 1], type: [1, 1], isCursor: [1, 1], hasCursor: [1, 1],
    split: [2, 2], join: [2, 2], insertAt: [3, 3], removeAt: [2, 2], str: [1, 1], num: [1, 1], int: [1, 1], bool: [1, 1], fragment: [1, 1],
    round: [1, 1], ceil: [1, 1], floor: [1, 1], min: [1, Infinity], max: [1, Infinity],
};
export const FUNCTIONS: Readonly<Record<string, FunctionSpec>> = Object.freeze(Object.fromEntries(Object.entries(arities).map(([name, [min, max]]) => [name, Object.freeze({
        min, max, kind: ['random', 'uuid'].includes(name) ? 'randomFunction' : ['str', 'num', 'int', 'bool', 'fragment', 'type', 'isCursor', 'hasCursor'].includes(name) ? 'typeFunction' : 'function',
        host: ['prompt', 'choice', 'toast', 'copy', 'paste', 'url', 'domain', 'title'].includes(name), userInput: ['prompt', 'choice'].includes(name),
    })])));
export const BUILTIN_ALL = Object.freeze(Object.keys(FUNCTIONS));
export function validateFunction(name: string, count: number, malformed = false): void {
    const spec = Object.prototype.hasOwnProperty.call(FUNCTIONS, name) ? FUNCTIONS[name] : undefined;
    if (!spec)
        throw createSnippetError('err_unknown_function', [name]);
    if (!malformed && count >= spec.min && count <= spec.max)
        return;
    const code = name === 'substr' ? 'err_substr_args' : name === 'replace' ? 'err_replace_args'
        : spec.max === 0 ? 'err_fn_no_args_allowed'
            : ['includes', 'split', 'join', 'removeAt', 'startswith', 'endswith', 'toast'].includes(name) ? 'err_fn_two_args_exact'
                : name === 'insertAt' ? 'err_fn_three_args_exact'
                    : ['str', 'num', 'int', 'bool', 'fragment', 'type', 'isCursor', 'hasCursor'].includes(name) ? 'err_fn_one_arg_exact'
                        : name === 'copy' && malformed ? 'err_fn_one_arg_exact'
                            : count === 0 && spec.min > 0 ? 'err_fn_args_required'
                                : name === 'copy' ? 'err_fn_one_arg_exact'
                                    : spec.max === 1 ? 'err_fn_one_arg_max' : 'err_function_arguments';
    throw createSnippetError(code, [name]);
}
