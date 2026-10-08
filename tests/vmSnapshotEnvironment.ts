// The vmThreads pool runs vitest's own runner inside the vm context, where a bare
// dynamic `import()` has no module callback on the Node 20 line and dies with
// ERR_VM_DYNAMIC_IMPORT_CALLBACK_MISSING — and vitest resolves its default snapshot
// environment through exactly such an import (runVmTests resolves it inside the vm,
// per test file). Pointing `snapshotEnvironment` at this module routes the resolution
// through the module runner, the same path every test file takes, and this is the very
// class the default branch would have imported — behaviour is unchanged.
import { VitestSnapshotEnvironment } from "vitest/runtime";

// The consumer validates `mod.default` as an object — an instance, not the class.
export default new VitestSnapshotEnvironment();
