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

`Analysis` contains an immutable `SnippetTemplate`, expression ASTs, `tokens`, `regions`, `diagnostics` and snippet `references`. All ranges use original-source UTF-16 `[start, end)` offsets, including nested fragment literals and continued lines. `analyze()` accepts unfinished code and returns recoverable diagnostics; execution rejects error diagnostics before starting effects. Warnings are represented by the contract but no warning rules are implemented yet. `checkVariables: false` defers variable-existence checks to execution when the variable environment is only known at runtime.

A library is an array of `{ id?, name?, trigger?, replacement?, disabled? }` definitions. `${parameter:regex}` placeholders determine call signatures; the host owns regex trigger matching and which definitions belong to a library. Disabled entries can still be called as helpers. References expose the name range, optional stable `targetId`, and library `targetIndex`. Library name/signature changes require reanalysis. `prepareSnippetTemplate()` caches per snippet identity and source, including invalid source, so one unfinished definition does not prevent other snippets from loading.

The same `Analysis` is accepted by `execute()` and can be rendered by any host highlighter. Execution never parses raw expression strings. Dynamic `fragment(string)` explicitly analyzes new source; ordinary strings and evaluated results are never reinterpreted as code.

## Highlighting contract

Tokens are `{ kind, start, end }`. Categories are:

`syntax`, `keyword`, `variable`, `function`, `randomFunction`, `typeFunction`, `snippetFunction`, `operator`, `list`, `fragmentDelimiter`, `cursorSyntax`, `cursor`, `regex`, `regexFlag`, `bool`, `null`.

`bool` covers `true` and `false`; `null` covers `null`. Strings and numbers have no dedicated highlighting category in this version. Quoted text is never classified as language syntax. Regions (`expression`, `cursorExpression`, `cursor`, `argument`) describe structural presentation ranges. `analyzeTrigger()` provides the trigger-parameter tokens and regions separately from host-side trigger compilation.

The core provides no colors, CSS, HTML or theme policy. Hosts map categories to their own presentation. Errors and references are separate from token categories.

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

The public `FUNCTIONS` registry owns argument counts, semantic token categories, host capability classification and user-input wait policy. Hosts implement `prompt`, `choice`, `toast`, `copy`, `paste`, `url`, `domain`, and `title`. Missing capabilities fail when invoked. Calls skipped by `&&`, `||` or a ternary are never invoked, including calls and effects inside fragment literals. Arguments are evaluated left to right.

User-input waits (`prompt` and `choice`) are excluded from the shared timeout. Clipboard and other host waits count. Empty/null input cancels expansion with `SnippetPromptCancelled`. `copy` reports failures; failed clipboard reads preserve the existing empty-string behavior. Timeouts and explicit cancellation abort the host signal, ignore late results, and stop execution. Hosts are responsible for any cancellation their external API supports; already completed external side effects are not rolled back.

`environment` can override `now`, `date`, `random`, `uuid` and async `yield` for deterministic tests or a different scheduler. Defaults use standard JavaScript APIs. The default budget is 500ms (100–60000ms), call depth 32 (1–256), and cooperative scheduling yields approximately every 16ms. Synchronous host work must return control for cancellation to be observed.

Errors expose `code`, `args`, `sourceRange`, `snippetLocation` and `callTrace`. `messageKey`/`messageValues` are compatibility aliases for extension adapters. Translate diagnostic codes in the host. `snippetLocation` uses one-based lines and Unicode-character columns; source offsets remain UTF-16.

## Values

`SnippetTemplate` is reusable code; `SnippetFragment` is immutable output with text and cursor nodes. Strings containing `{{#1}}` remain inert. Backtick literals and `fragment(string)` interpret template syntax. `str(fragment)` serializes cursor syntax into inert text. Fragment length, indexing and iteration count a Unicode code point or cursor as one item; indexed/iterated items remain fragments.

Existing arithmetic/coercion, list and range behavior is retained. `bool()` uses the same condition rules as `if`; logical operators retain their existing truthiness rules. The approved evaluation change is lazy execution of the selected logical/ternary branches. Diagnostics now use one shared set of specific argument-count codes for both analysis and execution.
