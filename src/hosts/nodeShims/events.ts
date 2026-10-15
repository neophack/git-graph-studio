// The Node `events` builtin: the EventEmitter with the once/off/emit semantics the
// shimmed packages rely on. The class itself lives in shared.ts (Buffer's home) so
// every consumer — the barrel below, the streams that extend it, the process
// surfaces — shares one identity and `instanceof EventEmitter` holds across them.

export { EventEmitter } from './shared';
