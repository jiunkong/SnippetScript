import type { Environment } from './types.js';
export const defaultEnvironment: Environment = {
    now: () => globalThis.performance?.now() ?? Date.now(),
    date: () => new Date(), random: () => Math.random(), uuid: () => globalThis.crypto.randomUUID(),
    yield: () => new Promise(resolve => setTimeout(resolve, 0)),
};
