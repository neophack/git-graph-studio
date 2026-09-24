// The module self-test runner (module 14, Performance Lab): the engine behind the
// "Developer: Run Module Self-Tests" command — one click walks every module's declared
// checks and reports what works. Each check is an async function that throws on failure,
// returns a string to record a skip (with the reason), or resolves to pass; the runner
// times each one, streams outcomes as they land, and never lets one check's failure
// short-circuit the rest. The suites themselves (what each module verifies) live in the
// lazy `selfTestSuites` chunk, the way the analysis pages do.

export interface SelfTest {
	/** Stable id within its group (`module/id`). */
	id: string;
	/** The human-readable name the report shows (already localized by the suite). */
	name: string;
	/** Throw = fail, return a string = skip (the reason), resolve = pass. */
	run: () => Promise<string | void>;
}

export interface SelfTestGroup {
	/** The module's product-grade name, as the module map spells it. */
	module: string;
	tests: SelfTest[];
}

export type SelfTestStatus = 'pass' | 'fail' | 'skip';

export interface SelfTestOutcome {
	module: string;
	id: string;
	name: string;
	status: SelfTestStatus;
	ms: number;
	/** The failure's message, or the skip's reason. */
	message?: string;
}

const groups: SelfTestGroup[] = [];

/** Register one module's checks. Called by the lazy suites chunk on first load; later
 *  registrations for a module name already present replace that module's group, so a
 *  re-import cannot duplicate rows. An empty `tests` removes the module's group — a module
 *  can withdraw itself the same way it announced itself. */
export function registerSelfTests(group: SelfTestGroup): void {
	const index = groups.findIndex((existing) => existing.module === group.module);
	if (group.tests.length === 0) {
		if (index !== -1) groups.splice(index, 1);
		return;
	}
	if (index === -1) groups.push(group);
	else groups[index] = group;
}

/** The registered groups, in registration order (the suites register module-map order). */
export function selfTestGroups(): SelfTestGroup[] {
	return groups;
}

/** How long one check may take before the runner declares it hung. A real check is
 *  milliseconds; thirty seconds means something awaited forever. */
const CHECK_TIMEOUT_MS = 30_000;

/** Run the given groups (default: all registered) in order, one check at a time — a check
 *  that hangs fails its own row after the timeout instead of stalling the report.
 *  `onOutcome` streams every result the moment it settles; the resolved list is the full
 *  report. */
export async function runSelfTests(
	onOutcome: (outcome: SelfTestOutcome) => void,
	groupsToRun: SelfTestGroup[] = groups
): Promise<SelfTestOutcome[]> {
	const outcomes: SelfTestOutcome[] = [];
	for (const group of groupsToRun) {
		for (const test of group.tests) {
			const started = performance.now();
			let outcome: SelfTestOutcome;
			try {
				const skip = await Promise.race([
					test.run(),
					new Promise<never>((_, reject) => {
						setTimeout(() => reject(new Error(`timed out after ${CHECK_TIMEOUT_MS / 1000} s`)), CHECK_TIMEOUT_MS);
					})
				]);
				outcome = skip === undefined
					? { module: group.module, id: test.id, name: test.name, status: 'pass', ms: elapsed(started) }
					: { module: group.module, id: test.id, name: test.name, status: 'skip', ms: elapsed(started), message: skip };
			} catch (error) {
				outcome = {
					module: group.module,
					id: test.id,
					name: test.name,
					status: 'fail',
					ms: elapsed(started),
					message: error instanceof Error ? error.message : String(error)
				};
			}
			outcomes.push(outcome);
			onOutcome(outcome);
		}
	}
	return outcomes;
}

/** A finished run's headline counts — the summary the page and the copied report open with. */
export function summarize(outcomes: SelfTestOutcome[]): { pass: number; fail: number; skip: number; ms: number } {
	const ms = outcomes.reduce((total, outcome) => total + outcome.ms, 0);
	return {
		pass: outcomes.filter((outcome) => outcome.status === 'pass').length,
		fail: outcomes.filter((outcome) => outcome.status === 'fail').length,
		skip: outcomes.filter((outcome) => outcome.status === 'skip').length,
		ms: Math.round(ms)
	};
}

/** The report as Markdown: the summary, then one line per non-pass (the full pass list stays
 *  in the page — a copy that names every green check would be noise). */
export function reportMarkdown(outcomes: SelfTestOutcome[]): string {
	const summary = summarize(outcomes);
	const lines = [
		`Module self-tests: ${summary.pass} passed, ${summary.fail} failed, ${summary.skip} skipped (${summary.ms} ms)`,
		''
	];
	// The report groups by the outcomes' own modules, in first-seen order — it describes the
	// run that happened, independent of what is registered right now.
	const modules: string[] = [];
	for (const outcome of outcomes) {
		if (!modules.includes(outcome.module)) modules.push(outcome.module);
	}
	for (const module of modules) {
		const rows = outcomes.filter((outcome) => outcome.module === module);
		const counted = summarize(rows);
		lines.push(`## ${module} — ${counted.pass}/${rows.length} passed`);
		for (const outcome of rows) {
			if (outcome.status === 'pass') continue;
			lines.push(`- ${outcome.status === 'fail' ? 'FAIL' : 'SKIP'}: ${outcome.name}${outcome.message ? ` — ${outcome.message}` : ''}`);
		}
	}
	return lines.join('\n');
}

function elapsed(started: number): number {
	return Math.max(1, Math.round(performance.now() - started));
}
