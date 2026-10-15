// The Source Control module's public types: shapes other modules consume without importing
// the view implementation (plan §5.3/5.4).

/** One line's last change, as `scm_blame` reports it. */
export type { BlameLine } from '../../platform/ipc/scm';

// The history view's public type (the class loads lazily; the editor imports it type-only).
export type FileHistoryView = import('./fileHistory').FileHistoryView;
