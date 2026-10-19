# SnippetScript

This repository is a portable TypeScript language core, consumed by hosts such as Snippet++. It must compile and execute without a DOM, Chrome APIs or editor state.

- Use strict TypeScript ES modules. Public AST/value/host/diagnostic contracts live in `src/types.ts`.
- Share analysis between execution and highlighting; never introduce a second expression parser in a host.
- Tokens contain semantic categories and original UTF-16 ranges only. Colors, CSS, HTML and localized messages belong to hosts.
- Keep immutable templates, fragments and analysis results reusable across executions.
- Do not use eval or Function constructors. Do not parse evaluated output as code; only explicit fragment conversion analyzes dynamic source.
- Host capabilities run through the typed async `Host.invoke` interface. Preserve shared deadlines, user-input wait exclusion, cancellation and late-result handling.
- Preserve existing coercion, scope, cursor, iteration and snippet-call behavior. Logical/ternary branches are lazy.
- Error and warning diagnostics share a structure. Implicit-conversion warning rules are future work, not part of this extraction.
- Run `npm ci` then `npm test` independently. Tests use Node's native runner and compiled ESM imports; no browser globals or test framework dependency.
- Ignore generated `dist/` and `node_modules/`. Commit/push this repository before a consuming repository publishes an updated submodule pointer.
