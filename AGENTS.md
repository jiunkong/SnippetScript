# SnippetScript

This repository is a portable TypeScript language core, consumed by hosts such as Snippet++. It must compile and execute without a DOM, Chrome APIs or editor state.

- Use strict TypeScript ES modules. Public AST/value/host/diagnostic contracts live in `src/types.ts`.
- Share analysis between execution and highlighting; never introduce a second expression parser in a host.
- Tokens contain semantic categories and original UTF-16 ranges only. Colors, CSS, HTML and localized messages belong to hosts.
- Keep immutable templates, fragments and analysis results reusable across executions.
- Do not use eval or Function constructors. Do not parse evaluated output as code; only explicit fragment conversion analyzes dynamic source.
- Host capabilities run through the typed async `Host.invoke` interface. Preserve shared deadlines, user-input wait exclusion, cancellation and late-result handling.
- Function overloads are the source of truth for signatures, argument validation, candidate narrowing and return inference at analysis and runtime; conversions must be explicit. Snippet-call parameters are string-only, matching trigger captures; keep analysis, signature hovers and runtime validation consistent. Preserve the existing rules for arithmetic, conditions and rendering, along with scope, cursor, iteration and snippet calls. Logical/ternary branches are lazy.
- Register builtins only in `src/functions.ts`: colocate overloads, token category, execution handler, argument validation, return inference and host policies. Do not add builtin-name dispatch in the analyzer, inference pass or runtime. Keep browser implementations in the host; runtime supplies generic host and fragment-execution capabilities. Value algebra in `src/value-operations.ts` must not depend on the function registry.
- Error and warning diagnostics share a structure. Function argument and cursor type checks share the inference pass; merge possible types before assigning severity. Definite mismatches are errors, partly compatible unions/unknown types are warnings, and warnings must not block execution. General arithmetic implicit-conversion rules remain future work.
- Run `npm ci` then `npm test` independently. Tests use Node's native runner and compiled ESM imports; no browser globals or test framework dependency.
- Ignore generated `dist/` and `node_modules/`. Commit/push this repository before a consuming repository publishes an updated submodule pointer.
