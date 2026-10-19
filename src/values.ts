// Value algebra is independent of builtin registration. Keep this public facade
// for existing consumers, including the synchronous expression API.
export * from './value-operations.js';
export { formatDate, sampleRandom } from './functions.js';
import { FUNCTIONS, validateFunctionArguments } from './functions.js';
import { defaultEnvironment } from './environment.js';
import { createSnippetError } from './errors.js';
import type { Environment, ExecutionCheck, SourceRange } from './types.js';

export function callBuiltinFunction(name: string, values: any[], execution?: ExecutionCheck, environment: Environment = defaultEnvironment, argumentRanges: readonly SourceRange[] = []): any {
    validateFunctionArguments(name, values, argumentRanges);
    const definition = FUNCTIONS[name];
    if (!definition.execute)
        throw createSnippetError('err_host_function_unavailable', [name]);
    return definition.execute(values, { execution, environment, name });
}
