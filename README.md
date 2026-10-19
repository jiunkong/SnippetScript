# SnippetScript

Portable TypeScript analysis and execution of SnippetScript templates. No Chrome, DOM, editor or localization dependency. Apache-2.0 licensed.

## Build and test

Requires Node.js 22+ and npm.

```sh
npm ci
npm run build
npm test
```

`src/` contains strict TypeScript ES modules. `dist/` contains JavaScript and declaration files. There are no runtime package dependencies. Consumers can import `dist/index.js` directly or bundle the TypeScript sources. Tests use Node's built-in test runner and import the compiled modules directly.

## Analyze once, execute repeatedly

```ts
import { analyze, execute } from './dist/index.js';

const analysis = analyze('{{upper($name)}}{{#1}}', {
  variables: ['name'],
  library: [],
});

const fragment = await execute(analysis, {
  variables: { name: 'Guest' },
  limits: { timeoutMs: 500, maxCallDepth: 32 },
});

// text "GUEST" followed by a cursor node, not serialized source code
console.log(fragment.nodes);
```

`Analysis` contains an immutable `SnippetTemplate`, expression ASTs, `tokens`, `regions`, `diagnostics` and snippet `references`. All ranges use original-source UTF-16 `[start, end)` offsets, including nested fragment literals and continued lines. `analyze()` accepts unfinished code and returns recoverable diagnostics; execution rejects error diagnostics before starting effects. Static type diagnostics distinguish definite mismatches (errors) from possibly incompatible union types or unknown types (warnings); warnings do not block execution. `checkVariables: false` defers variable-existence checks to execution when the variable environment is only known at runtime.

A library is an array of `{ id?, name?, trigger?, replacement?, disabled? }` definitions. `${parameter:regex}` placeholders determine call signatures; the host applies trigger matching and selects which definitions belong to a library. Disabled entries can still be called as helpers. References expose the name range, optional stable `targetId`, and library `targetIndex`. Library name/signature changes require reanalysis. `prepareSnippetTemplate()` caches per snippet identity and source, including invalid source, so one unfinished definition does not prevent other snippets from loading.

The same `Analysis` is accepted by `execute()` and can be rendered by any host highlighter. Execution never parses raw expression strings. Dynamic `fragment(string)` explicitly analyzes new source; ordinary strings and evaluated results are never reinterpreted as code.

## Compact formatting

`{{compact}} … {{endcompact}}` removes literal source line breaks (LF, CRLF or CR) and the spaces/tabs immediately after them. It preserves ordinary text, inline whitespace, and whitespace outside the block. Newlines produced by expressions, strings, fragment literals and snippet calls remain intact; use `{{"\n"}}` to insert one explicitly.

Compact blocks may nest and wrap conditionals or loops. They add no variable scope: declarations and assignments behave as if the compact markers were absent. The analyzer applies formatting to literal text nodes and retains original UTF-16 token and diagnostic ranges; execution does not trim generated output. A fragment literal or called snippet applies compact formatting only if its own source contains a compact block.

`newline()` takes no arguments and returns a string containing one LF (`\n`). Use `{{newline()}}` to insert a line break, including within compact blocks, or store its result and compose it in expressions.

## Variable type inference

`analyze()` also returns `variableTypes`: `{ name, range, types, elementTypes? }` entries for variable reads, assignment targets, and loop `index`/`value` expressions. Ranges use the original source, including inside backtick fragments. `types` contains language names (`string`, `number`, `bool`, `fragment`, `list`, `range`, `null`, `undefined`) or `unknown` when a type cannot be determined. Optional `elementTypes` describes possible list element types, merged across repeated analysis of the same occurrence. Hosts can display `list<string | number>` without changing the underlying `list` value type. Assignment targets show the assigned type; later reads reflect the assignments that can reach that position. Assignments remain dynamically typed. The same inference pass checks function arguments and cursor expressions and adds type diagnostics to `Analysis.diagnostics`.

Names supplied through `variables` start as `string`, matching trigger captures. Hosts with known non-string inputs may supply `variableTypes: { name: ['number'] }` instead (or override a name in `variables`). For example:

```ts
const analysis = analyze('{{ $n }}{{set $n=int($n)}}{{ $n }}', { variables: ['n'] });
// The first read is string, the assignment target and final read are number.
```

The pass walks the shared AST without executing expressions or host requests. Branch exits merge possible types; loops propagate types from prior iterations until stable and account for zero iterations, break and continue. Existing variables retain assignments made in nested blocks; variables introduced inside those blocks stay local. Fragment literals are analyzed in a copied scope, and snippet calls return `fragment`. Iterable element types propagate to `value` and indexing; indexing includes `undefined` because an index may be out of bounds. Nested list contents or other insufficiently known inputs can yield `unknown`. Inference is conservative: conditions are not narrowed by their runtime values, so hover types can include alternatives that a particular execution does not take.

Hosts may expose this information as hovers without attaching presentation to token kinds. `inferVariableTypes(template, options)` is also exported for consumers that already hold a parsed template.

## Function parameter types and diagnostics

Every `FUNCTIONS` entry owns immutable `overloads`. Each `FunctionOverload` has a stable `id`, `min`/`max`, named `parameters`, optional `restParameter`, and its own `returnTypes` and optional `returnElementTypes`. Parameters can constrain list `elementTypes`; `requiredElementTypes` denotes an element that must occur (used by the fragment-producing string-separator overload of `join`). Aggregate function arity, token category and host policy remain on the function entry. No target-type maps or flattened union signature are used.

`resolveFunctionOverloads(name, argumentTypes)` is shared by static diagnostics, return inference, candidate hovers and runtime validation. It returns applicable `candidates`, fallback signatures from the longest compatible prefix, and argument `issues`. Prefix matching permits unfinished calls. Union possibilities retain argument-combination constraints, so `includes(string | range, string | number)` warns about incompatible pairings even though each argument is individually accepted by some overload. List element alternatives are checked across possible subsets; runtime values use exact types/contents. Unknown types retain candidates conservatively and can produce warnings. `inferTemplateTypes` exposes inferred `callTypes`, including optional result `elementTypes`, and argument types alongside variable types and diagnostics. Callable overloads also include inferred `returnElementTypes` for list-producing signatures with dynamic return inference.

| Functions | Parameter types |
| --- | --- |
| `date`, `time`, `datetime`, `prompt` | Optional `string` |
| `choice` | `string` title, followed by `string` options |
| `toast` | `string` message, `string` color, optional `number` duration in seconds (default 6) |
| `copy` | `string \| fragment` |
| `upper`, `lower`, `trim`, `capitalize` | `string \| fragment` |
| `substr` | `string \| fragment`, `number` start, optional `number` count |
| `replace` | Three `string \| fragment` arguments |
| `startswith`, `endswith`, `split` | Two `string \| fragment` arguments |
| `len` | `string \| fragment \| list \| range` |
| `includes` | Iterable, then text for string/fragment targets, number for ranges, or any value for lists |
| `join` | `list<string \| fragment>`, `string \| fragment` separator |
| `insertAt`, `removeAt` | `string \| fragment \| list`, `number` index; insert also takes text for string/fragment targets or any value for list targets |
| `round`, `ceil`, `floor` | `number` |
| `min`, `max` | One or more `number` arguments |
| `isCursor`, `hasCursor` | `fragment` (returns `bool`; ordinary function highlighting) |
| `str`, `num`, `int`, `bool`, `fragment`, `type` | Any value; explicit conversions and type inspection accept every type |
| `random` | One or more arbitrary values (a range produces a number) |
| `url`, `domain`, `title`, `uuid`, `bs`, `backspace`, `paste` | No arguments |

Function arguments are checked against these signatures at runtime as well as during analysis. `validateSnippetCallArguments(name, values, ranges?)` enforces string-only snippet-call parameters. `validateFunctionArguments(name, values, ranges?)` is shared by the asynchronous executor, synchronous expression evaluator, direct builtin entrypoint and browser host dispatch. Incompatible actual values throw `err_argument_type` at the argument range; they are not coerced even when inference previously emitted only a warning. `join()` checks list element types too; `insertAt()` only accepts text for string/fragment targets, while lists preserve arbitrary values.

Type labels share `formatTypeNames()` and `argumentTypeLabel()`. Variable/signature hovers and function, snippet-argument and cursor type diagnostics preserve list element types, such as `list<string | number> | undefined`. Unknown or empty element sets display as `list<unknown>`; unconstrained list parameters remain `list`.

Use explicit conversions: `substr(1234, 1, 2)` is an error; `substr(str(1234), 1, 2)` is valid. Likewise, pass `num($capture)` or `int($capture)` to numeric parameters. Explicit conversion functions still accept any value. String/fragment overloads continue to support both representations and preserve cursor nodes when producing fragments. Arithmetic, conditions, switch comparisons, loop counts and rendering retain their existing rules; this change makes function arguments and numeric cursor offsets strict.

Cursor expressions and snippet-call cursor offsets require `number`. Existing runtime checks still enforce non-negative safe integers. A definite incompatible argument produces `err_argument_type`; a union containing both allowed and disallowed alternatives produces `warn_argument_type`. Cursor equivalents are `err_cursor_expression_type` / `warn_cursor_expression_type` and `err_cursor_offset_type` / `warn_cursor_offset_type`. Unknown types produce warnings for constrained parameters rather than blocking execution. Errors highlight the offending argument/expression's original source range. Diagnostics collected during repeated loop analysis are merged before deciding severity, so an early iteration does not leave a stale definite error.

For example, `{{#("1")}}` is a type error, `{{#num("1")}}` is valid, and `{{prompt(true ? "text" : 1)}}` reports a warning because the message is inferred as `string | number`. Conditions are conservatively analyzed even when their values appear constant. General implicit conversions in arithmetic are not yet diagnosed.

Division and remainder expressions whose divisor is provably zero report `err_division_by_zero` or `err_remainder_by_zero` at the divisor's range. The same checks cover `/=` and `%=`. Numeric literal arithmetic is folded for this check, so `-0` and `(1 - 1)` are recognized. Variables and function calls are not evaluated or assumed constant; these checks use the existing AST without invoking host capabilities. As with other analysis errors, they prevent template execution.

`Analysis.callSignatures` exposes names/ranges, whole `callRange`, `complete`, `argumentStarts`, `matches`, and the narrowed `overloads` for each recognized call. Each callable overload has its own parameter names/types, optional/rest markers and return types. Invalid arguments retain the last compatible prefix's signatures with `matches: false` for correction. The host can highlight the active parameter without parsing source or executing code. Function calls being edited retain parsed prefix arguments and type information even without a closing parenthesis/tag or while typing a quoted argument; diagnostics still prevent execution of unfinished source.

Snippet calls expose one signature: string parameters (the same initial type as trigger captures) and a fragment result. Non-string values require an explicit conversion such as `@foo(str(123))`. Missing or ambiguous snippet targets do not receive a fabricated signature.

## Highlighting contract

Tokens are `{ kind, start, end }`. Categories are:

`syntax`, `parenthesis`, `keyword`, `variable`, `function`, `randomFunction`, `typeFunction`, `snippetFunction`, `operator`, `arithmeticOperator`, `rangeOperator`, `list`, `fragmentDelimiter`, `cursorSyntax`, `cursor`, `regex`, `regexFlag`, `bool`, `null`, `stringEscape`.

`parenthesis` covers grouping parentheses, including inside cursor expressions. Function-call parentheses retain their function category. `arithmeticOperator` covers binary and unary `+`/`-`, and binary `*`/`/`/`%`. `rangeOperator` covers the range construction operator `~`. Other operators retain the `operator` category. These categories allow hosts to style grouping, arithmetic and ranges independently of template delimiters and other operators.

`bool` covers `true` and `false`; `null` covers both `null` and `undefined`. Strings and numbers have no dedicated highlighting category in this version. Quoted text is never classified as language syntax. Regions (`expression`, `cursorExpression`, `cursor`, `argument`) describe structural presentation ranges. `analyzeTrigger()` is the single trigger parser and returns a cached immutable `TriggerAnalysis`: token/region/diagnostic data, ordered `parameters`, `kind` (`literal`, `regex`, `invalid`), and compiled-pattern source/flags. `snippetParameterNames()` reads those parameters; `compileTrigger()` accepts source or that analysis and creates a fresh `RegExp` so cached state never shares mutable `lastIndex`.

`${name}` retains the default `[^ ]+` regex; an explicitly empty `${name:}` is invalid. Regex scanning preserves escapes: `\{` and `\}` match literal braces, `{2,4}` remains a quantifier, and braces in character classes are not placeholder delimiters. For example, `${text:\{[^}]+\}}` captures `{hello}`. A supported flag suffix is recognized only outside escapes, character classes, groups and braces. Invalid names, duplicate parameters, unfinished placeholders and regex compilation failures produce the same diagnostics for highlighting and compilation.

The core provides no colors, CSS, HTML or theme policy. Hosts map categories to their own presentation. Errors and references are separate from token categories.

For numeric cursor tags such as `{{#0}}`, the `#` marker is a `cursorSyntax` token and the digits have no dedicated color token, matching ordinary number literals. The enclosing cursor region keeps background and underline continuous. The `cursor` and `#cursor` aliases retain their cursor label category.

## Host capabilities and execution environment

```ts
import { SnippetError } from './dist/index.js';

const controller = new AbortController();
const fragment = await execute(analysis, {
  variables: {},
  library: [],
  signal: controller.signal,
  host: {
    async invoke({ name, args, sourceRange }, { signal }) {
      // Implement a supported capability and return a language value.
      // Observe signal to dismiss pending UI / stop cancellable work.
      throw new SnippetError('err_host_function_unavailable', [name]);
    },
  },
});
```

`toast(message, color[, seconds])` returns `undefined` after host dispatch succeeds (direct template output inserts no text); it is not a success flag and does not wait for the display interval. The optional duration must be finite, greater than zero, and at most `MAX_TOAST_DURATION_SECONDS` (2147483.647, the browser timer limit). It defaults to `DEFAULT_TOAST_DURATION_SECONDS` (6). The core validates an explicit duration before host dispatch; the browser host validates CSS color and displays the toast. Invalid types, invalid duration, invalid color, missing host capabilities or host errors propagate as failures. Later toasts replace earlier ones, and the page can remove the display, so visible duration is not guaranteed. Fractional seconds are supported, rounded to milliseconds with a minimum timer delay of 1 ms.

The public `FUNCTIONS` registry owns overloads, argument counts, semantic token categories, execution handlers, additional value validation, return inference and host policies. Hosts implement `prompt`, `choice`, `toast`, `copy`, `paste`, `url`, `domain`, and `title`. Missing capabilities fail when invoked. Calls skipped by `&&`, `||` or a ternary are never invoked, including calls and effects inside fragment literals. Arguments are evaluated left to right.

### Adding a builtin

Add one entry to `defineFunctions({...})` in `src/functions.ts`. No builtin-name dispatch belongs in the analyzer, runtime, inference pass, highlighter or guide.

```ts
// Inside the registry:
example: {
    overloads: [overload([string('text')], ['string'])],
    execute: ([text]) => text.toUpperCase(),
},
```

- `overloads` describes each parameter, optional/rest arity, list constraints and return type. Stable overload IDs and aggregate arity are generated automatically.
- `execute` implements synchronous functions; `executeAsync` implements functions requiring runtime capabilities. Exactly one handler is required by TypeScript.
- `validate` adds value constraints after common arity/type validation, with original argument ranges.
- `inferReturn` handles value-dependent return types, such as preserving list elements or selecting among argument types. Ordinary returns are inferred directly from narrowed overloads.
- `kind` controls the semantic function token category. The host maps categories to colors.
- Host entries use `host()` and `host: true`; `userInput: true` excludes input waits from the deadline and treats empty/null responses as cancellation. Result normalization and failure policies are declared in that entry.

The runtime supplies `environment`, execution checks, `invokeHost(values)` and `solveFragment(source)`. Function definitions choose which capabilities to use; the runtime has no branches for specific builtins. Browser code stays outside the core, and adding a new browser capability requires implementing that capability in the host. `values.ts` preserves the public synchronous builtin API, while `value-operations.ts` contains independent value algebra and has no dependency on the registry.

User-input waits (`prompt` and `choice`) are excluded from the shared timeout. Clipboard and other host waits count. Empty/null input cancels expansion with `SnippetPromptCancelled`. `copy` reports failures; failed clipboard reads preserve the existing empty-string behavior. Timeouts and explicit cancellation abort the host signal, ignore late results, and stop execution. Hosts are responsible for any cancellation their external API supports; already completed external side effects are not rolled back.

`environment` can override `now`, `date`, `random`, `uuid` and async `yield` for deterministic tests or a different scheduler. Defaults use standard JavaScript APIs. The default budget is 500ms (100–60000ms), call depth 32 (1–256), and cooperative scheduling yields approximately every 16ms. Synchronous host work must return control for cancellation to be observed.

Errors expose `code`, `args`, `sourceRange`, `snippetLocation` and `callTrace`. `messageKey`/`messageValues` are compatibility aliases for extension adapters. Translate diagnostic codes in the host. `snippetLocation` uses one-based lines and Unicode-character columns; source offsets remain UTF-16.

## Values

Numeric operations and builtin return values reject `NaN` with `err_number_nan` at runtime, before the value can be assigned, rendered or passed to another function. Binary arithmetic, compound assignment and unary numeric conversion share this rule in both execution APIs. `num()` and `int()` also throw when conversion produces NaN, instead of substituting zero; rounding functions and min/max no longer substitute or discard NaN. Short-circuited branches remain unevaluated. Infinity remains supported under the existing numeric rules.

`SnippetTemplate` is reusable code; `SnippetFragment` is immutable output with text and cursor nodes. Strings containing `{{#1}}` remain inert. Backtick literals and `fragment(string)` interpret template syntax. `str(fragment)` serializes cursor syntax into inert text. Fragment length, indexing and iteration count a Unicode code point or cursor as one item; indexed/iterated items remain fragments.

Existing arithmetic/coercion, list and range behavior is retained. `bool()` uses the same condition rules as `if`; logical operators retain their existing truthiness rules. The approved evaluation change is lazy execution of the selected logical/ternary branches. Diagnostics now use one shared set of specific argument-count codes for both analysis and execution.

Ordinary single- and double-quoted string literals decode `\"`, `\'` and `\\` into one character, `\n` into a newline and `\t` into a tab. Unknown escapes such as `\d` remain unchanged. Decoding changes the runtime value only: tokens and diagnostics retain ranges in the original source spelling. Fragment literal text and trigger regexes use their own escape rules.

Recognized escape sequences in ordinary string literals are emitted as `stringEscape` tokens covering their original two-character spelling. Unknown escapes remain plain string text. Decoding and highlighting share the same escape scanner.
