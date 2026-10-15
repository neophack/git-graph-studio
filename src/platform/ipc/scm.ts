// The typed IPC seam of the SCM domain (plan §5.6): one file per backend domain, function
// signatures as the contract. This file starts with the shared `scm_status` result shape the
// Explorer and the SCM view both decorate rows with; the invoke wrappers join as P5-4
// migrates the callers.

/** repo-relative path (forward slashes) -> status letter (M A D R U !), as `scm_status`
 *  reports it. */
export type StatusMap = Map<string, string>;
