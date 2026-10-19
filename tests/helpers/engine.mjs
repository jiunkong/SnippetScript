import * as core from '../../dist/index.js';

// Test hosts are injected callbacks. No DOM, extension globals or VM is needed.
export function engine() {
  const context = { ...core, SnippetScript: core };
  const host = { async invoke({ name, args }) {
    switch(name) {
      case 'prompt': return context.showSnippetPrompt?.(String(args[0] ?? 'Enter value:'));
      case 'choice': return context.showSnippetChoice?.(String(args[0] || 'Select Option:'), args.slice(1));
      case 'toast': context.showSnippetToast?.(...args); return '';
      case 'paste': return context.navigator?.clipboard.readText();
      case 'copy': await context.navigator?.clipboard.writeText(String(args[0] ?? '')); return '';
      default: throw new core.SnippetError('err_host_function_unavailable', [name]);
    }
  }};
  context.processTemplate = (source, variables, options = {}) => core.processTemplate(source, variables, {
    host, environment: { now: () => context.performance?.now() ?? core.defaultEnvironment.now() }, ...options,
  });
  return context;
}
