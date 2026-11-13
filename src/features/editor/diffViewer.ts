// The diff editor's accessible viewer (module 6): VS Code's F7 surface — a panel over the
// diff that lists every change as one row ("Difference i of n: +a −d" plus a preview of the
// changed lines), navigable by keyboard alone, each row jumping to its change in the editor.
// F7 opens it and walks it, Escape closes it, Enter jumps and closes.

import { t, tf } from '../../platform/i18n';
import { el, icon } from '../../platform/ui/index';

/** One change of the diff, shaped for the viewer. `preview` lists the change's deleted
 *  lines first (the − side), then its added lines (+), each side capped by the caller. */
export interface DiffViewerChange {
  added: number;
  deleted: number;
  preview: { text: string; kind: 'add' | 'del' }[];
  /** Lines of the change the preview cap left out, both sides together. */
  hidden: number;
}

export interface DiffViewerHandle {
  /** Navigate the highlighted row (clamped at the ends, like the editor's own stepping). */
  navigate(direction: 1 | -1): void;
  /** Whether the viewer is mounted right now. */
  open: boolean;
  close(): void;
}

/** How many lines of one change's preview the viewer shows per side; the rest collapses
 *  into the "… N more lines" hint (the caller counts `hidden` with the same cap). */
export const PREVIEW_CAP = 5;

/** Mount VS Code's accessible diff viewer over `host` (the diff editor's own element, made
 *  `position: relative` by the styles). `changes` is re-read on every open, so an edit made
 *  with the viewer open is picked up when the caller refreshes it. `jump` moves the editors
 *  to a change; `onClose` fires when the viewer leaves the DOM (a close button, Escape,
 *  Enter's jump, or the diff being rebuilt under it). */
export function mountAccessibleDiffViewer(
  host: HTMLElement,
  changes: () => DiffViewerChange[],
  opts: { jump: (index: number) => void; initial?: number; onClose: () => void },
): DiffViewerHandle {
  const handle: DiffViewerHandle = {
    navigate: (direction) => step(direction),
    open: true,
    close: () => close(),
  };
  let current = Math.min(Math.max(opts.initial ?? 0, 0), Math.max(changes().length - 1, 0));
  let rows: HTMLElement[] = [];

  const backdrop = el('div', 'diff-viewer-backdrop');
  const panel = el('div', 'diff-viewer');
  panel.tabIndex = -1;
  const list = el('div', 'diff-viewer-rows');
  const head = el('div', 'diff-viewer-head', [el('span', '', [t('diff.action.accessibleViewer')])]);
  const closeButton = el('button', 'action-btn', [icon('close')]);
  closeButton.title = t('diff.viewer.close');
  closeButton.addEventListener('click', () => close());
  head.appendChild(closeButton);
  panel.append(head, list);

  const markCurrent = (): void => {
    rows.forEach((row, index) => row.classList.toggle('current', index === current));
    rows[current]?.scrollIntoView({ block: 'nearest' });
  };
  const render = (): void => {
    const changesNow = changes();
    list.textContent = '';
    rows = [];
    if (changesNow.length === 0) {
      list.appendChild(el('div', 'diff-viewer-empty', [t('diff.viewer.empty')]));
      return;
    }
    current = Math.min(Math.max(current, 0), changesNow.length - 1);
    changesNow.forEach((change, index) => {
      const title = el('span', 'diff-viewer-row-title', [
        tf('diff.viewer.difference', index + 1, changesNow.length),
        el('span', 'added', [`+${change.added}`]),
        el('span', 'deleted', [`\u2212${change.deleted}`]),
      ]);
      const preview = el('div', 'diff-viewer-preview');
      for (const line of change.preview) {
        preview.appendChild(el('div', `diff-viewer-line ${line.kind}`, [`${line.kind === 'add' ? '+' : '\u2212'}${line.text}`]));
      }
      if (change.hidden > 0) preview.appendChild(el('div', 'diff-viewer-line more', [tf('diff.viewer.moreLines', change.hidden)]));
      const row = el('div', 'diff-viewer-row', [title, preview]);
      row.addEventListener('click', () => {
        current = index;
        markCurrent();
      });
      row.addEventListener('dblclick', () => jumpAndClose(index));
      list.appendChild(row);
      rows.push(row);
    });
    markCurrent();
  };
  const step = (direction: 1 | -1): void => {
    const total = changes().length;
    if (total === 0) return;
    current = Math.min(Math.max(current + direction, 0), total - 1);
    markCurrent();
  };
  const jumpAndClose = (index: number): void => {
    close();
    opts.jump(index);
  };
  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.key === 'F7') {
      event.preventDefault();
      event.stopPropagation();
      step(event.shiftKey ? -1 : 1);
    } else if (event.key === 'ArrowDown') {
      event.preventDefault();
      step(1);
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      step(-1);
    } else if (event.key === 'Enter') {
      event.preventDefault();
      jumpAndClose(current);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      close();
    }
  };
  const close = (): void => {
    if (!handle.open) return;
    handle.open = false;
    panel.removeEventListener('keydown', onKeyDown);
    backdrop.removeEventListener('click', onBackdrop);
    backdrop.remove();
    panel.remove();
    opts.onClose();
  };
  const onBackdrop = (): void => close();

  panel.addEventListener('keydown', onKeyDown);
  backdrop.addEventListener('click', onBackdrop);
  render();
  host.appendChild(backdrop);
  host.appendChild(panel);
  panel.focus();
  return handle;
}
