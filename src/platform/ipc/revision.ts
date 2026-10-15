// The typed IPC seam of the git revision reads (plan §5.6): file contents at a revision,
// the temp-file materialization the diff tooling uses, and the repository head/submodule
// facts — the ggs-git crate's revision half behind the app's adapters.
import { invoke } from './core';
import type { FileContents } from './fs';

/** What `repo_head` reports about the open repository: where HEAD is and how far it
 *  diverged from its upstream. */
export interface HeadInfo {
	repo: string;
	branch: string | null;
	shortHash: string;
	ahead: number;
	behind: number;
	upstream: string | null;
}

export const repoHead = (repo?: string) => invoke<HeadInfo>('repo_head', repo === undefined ? undefined : { repo });
export const repoSubmodules = (repo: string) => invoke<string[] | null>('repo_submodules', { repo });
export const readFileAt = (revision: string, path: string, repo: string | null | undefined) =>
	invoke<FileContents>('read_file_at', repo === undefined ? { revision, path } : { revision, path, repo });
export const materializeRevisionFile = (repo: string, revision: string, path: string) => invoke<string>('materialize_revision_file', { repo, revision, path });
