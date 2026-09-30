// The Module Self-Tests report page (module 14): what "Developer: Run Module Self-Tests"
// opens. One row per check, grouped by module in module-map order, streamed as the runner
// settles each one — a pass line, a skip with its reason, a failure with its message. The
// header carries the run's summary, a Run/Stop control and a copy-to-clipboard report; a
// click on a module's re-run arrow runs just that module.

import { writeText } from '@tauri-apps/plugin-clipboard-manager';

import { notify, el, icon } from './ui';
import { t } from './i18n';
import {
	registerSelfTests,
	reportMarkdown,
	runSelfTests,
	selfTestGroups,
	summarize,
	type SelfTestGroup,
	type SelfTestOutcome,
	type SelfTestStatus
} from './selftest';
import { registerSelfTestSuites } from './selfTestSuites';
import type { Workbench } from './workbench';

const STATUS_ICON: Record<SelfTestStatus, string> = { pass: 'check', fail: 'error', skip: 'circle-slash' };

export class SelfTestPage {
	private readonly groupsBody: HTMLElement;
	private readonly summaryLine: HTMLElement;
	private readonly runButton: HTMLButtonElement;
	private running = false;
	private stopRequested = false;
	private outcomes: SelfTestOutcome[] = [];

	constructor(
		private readonly container: HTMLElement,
		workbench: Workbench
	) {
		registerSelfTestSuites(workbench);

		this.runButton = el('button', 'selftest-run', [icon('play'), t('selftest.run')]);
		runButtonHook(this.runButton, () => void this.toggleRun());
		const copyButton = el('button', 'selftest-copy', [icon('copy'), t('selftest.copy')]);
		runButtonHook(copyButton, () => void this.copyReport());

		this.container.append(
			el('div', 'selftest', [
				el('div', 'selftest-header', [
					el('div', 'selftest-titles', [
						el('h2', undefined, [t('selftest.title')]),
						(this.summaryLine = el('div', 'selftest-summary', [t('selftest.idle')]))
					]),
					el('div', 'selftest-actions', [copyButton, this.runButton])
				]),
				(this.groupsBody = el('div', 'selftest-groups'))
			])
		);
		this.renderGroups();
		// The click means run — except under the test sweep, where a concurrently running
		// suite would steal the shell out from under the sweep's own assertions.
		if (import.meta.env.MODE !== 'test') void this.start();
	}

	/** Render the module groups: one pending row per check, counts at zero. */
	private renderGroups(): void {
		this.groupsBody.replaceChildren();
		for (const group of selfTestGroups()) {
			const rows = el('div', 'selftest-rows');
			const rerun = el('button', 'action-btn rerun', [icon('debug-restart')]);
			rerun.title = t('selftest.rerunModule');
			rerun.addEventListener('click', (event) => {
				event.stopPropagation();
				void this.runGroups([group]);
			});
			const count = el('span', 'count', [`0/${group.tests.length}`]);
			rows.dataset['module'] = group.module;
			for (const test of group.tests) {
				const row = el(
					'div',
					'selftest-row pending',
					[
						el('span', 'status', [icon('circle-filled')]),
						el('span', 'name', [test.name]),
						el('span', 'ms', []),
						el('span', 'message', [])
					]
				);
				row.dataset['testId'] = `${group.module}/${test.id}`;
				rows.appendChild(row);
			}
			this.groupsBody.appendChild(
				el('div', 'selftest-group', [
					el('div', 'selftest-group-header', [el('span', 'name', [group.module]), count, rerun]),
					rows
				])
			);
		}
	}

	/** Run everything, streaming rows as they settle. */
	private async start(): Promise<void> {
		if (this.running) return;
		this.running = true;
		this.stopRequested = false;
		this.runButton.replaceChildren(icon('debug-stop'), t('selftest.stop'));
		this.outcomes = [];
		this.renderGroups();
		await runSelfTests(
			(outcome) => {
				if (this.stopRequested) return;
				this.outcomes.push(outcome);
				this.paintRow(outcome);
				this.paintSummary();
			},
			undefined,
			() => this.stopRequested
		);
		this.finish();
	}

	/** Run one module's group (the header's re-run button), replacing its rows. */
	private async runGroups(groups: SelfTestGroup[]): Promise<void> {
		if (this.running) return;
		this.running = true;
		this.stopRequested = false;
		this.runButton.replaceChildren(icon('debug-stop'), t('selftest.stop'));
		for (const group of groups) {
			for (const test of group.tests) {
				const row = this.rowFor(group.module, test.id);
				if (!row) continue;
				row.className = 'selftest-row pending';
				row.querySelector('.ms')!.replaceChildren();
				row.querySelector('.message')!.replaceChildren();
				this.outcomes = this.outcomes.filter((previous) => !(previous.module === group.module && previous.id === test.id));
			}
		}
		await runSelfTests(
			(outcome) => {
				this.outcomes.push(outcome);
				this.paintRow(outcome);
				this.paintSummary();
			},
			groups,
			() => this.stopRequested
		);
		this.finish();
	}

	/** The sweep ended (or was stopped): restore the control, announce the outcome. */
	private finish(): void {
		this.running = false;
		this.runButton.replaceChildren(icon('play'), t('selftest.run'));
		const summary = summarize(this.outcomes);
		this.summaryLine.textContent = `${summary.pass} ✓ · ${summary.fail} ✗ · ${summary.skip} ⃠ · ${summary.ms} ms`;
		if (this.stopRequested) {
			this.summaryLine.textContent = `${this.summaryLine.textContent ?? ''} — ${t('selftest.stopped')}`;
			return;
		}
		if (summary.fail > 0) notify('error', `${t('selftest.failedToast')} (${summary.fail})`);
		else notify('info', t('selftest.passedToast'));
	}

	/** Run → stop: the check in flight finishes, no further ones start. */
	private toggleRun(): void {
		if (this.running) {
			this.stopRequested = true;
			return;
		}
		void this.start();
	}

	private rowFor(module: string, id: string): HTMLElement | null {
		return this.container.querySelector<HTMLElement>(`.selftest-row[data-test-id="${CSS.escape(`${module}/${id}`)}"]`);
	}

	private paintRow(outcome: SelfTestOutcome): void {
		const row = this.rowFor(outcome.module, outcome.id);
		if (!row) return;
		row.className = `selftest-row ${outcome.status}`;
		row.querySelector('.status')!.replaceChildren(icon(STATUS_ICON[outcome.status]));
		row.querySelector('.ms')!.textContent = `${outcome.ms} ms`;
		const message = row.querySelector<HTMLElement>('.message')!;
		message.textContent = outcome.message ?? '';
		message.title = outcome.message ?? '';
		// The module's count line follows the rows it holds.
		const card = row.closest('.selftest-group');
		if (!card) return;
		const total = card.querySelectorAll('.selftest-row').length;
		const done = card.querySelectorAll('.selftest-row:not(.pending)').length;
		card.querySelector('span.count')!.textContent = `${done}/${total}`;
	}

	private paintSummary(): void {
		const summary = summarize(this.outcomes);
		this.summaryLine.textContent = `${summary.pass} ✓ · ${summary.fail} ✗ · ${summary.skip} ⃠ · ${summary.ms} ms`;
	}

	/** Copy the Markdown report (summary + every non-pass line). */
	private async copyReport(): Promise<void> {
		await writeText(reportMarkdown(this.outcomes));
		notify('info', t('selftest.copied'));
	}
}

/** The entry the workbench's editor calls: one self-contained editor pane. The returned
 *  dispose clears nothing — the page owns its DOM and its timers are all awaited. */
export function mountSelfTestPage(container: HTMLElement, workbench: Workbench): () => void {
	new SelfTestPage(container, workbench);
	return () => {};
}

function runButtonHook(button: HTMLButtonElement, onClick: () => void): void {
	button.type = 'button';
	button.addEventListener('click', () => onClick());
}
