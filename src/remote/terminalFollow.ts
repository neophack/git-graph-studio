// The terminal page's output follow (docs/remote-client-plan.md §6.6): a frontend only
// looking at the terminal PAGE carries terminal traffic — on the page-stack shells that is
// the panel being the current page; on the remote's wide forms (the desktop browser's
// bottom dock) the panel simply being shown. Every flip the workbench's own observers
// already report (pages.ts's watcher sees the panel's hidden attribute and the page
// moves) re-checks and tells the TerminalView, whose own grace timer (30 s) and tail
// catch-up (64 KB) do the rest. The desktop app never installs this.
import { currentWorkbench } from '../workbench';
import { currentPage, onWorkbenchChange } from './pages';

export function installTerminalFollow(): void {
	const check = (): void => {
		const view = currentWorkbench?.panel.terminal;
		if (!view) return;
		const panel = document.getElementById('panel');
		const shown = !!panel && !panel.hidden
			&& (!document.documentElement.hasAttribute('data-page-stack') || currentPage() === 'panel');
		view.setOutputFollow(shown);
	};
	onWorkbenchChange(check);
	check();
}
