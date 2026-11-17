// The media viewer a video or audio file opens in (module 7): the webview's own decoder
// drives the picture, the app drives everything around it — a compact toolbar (play,
// seek, mute, speed, loop), the file's container facts in an information panel (the
// backend's header parsers answer format, duration, bitrate, codec, resolution, frame
// rate, sample rate, channels — facts a playing element never spells), and an "open in
// the system player" hand-off for every codec the webview build cannot decode.
//
// The bytes cross as the `ggsmedia://` protocol's Range windows, so playback streams and
// seeks without ever holding a whole film in memory; where no protocol handler exists
// (the remote shells, a browser page) the view falls back to one bounded byte read. A
// decode failure degrades honestly: the facts stay, the panel offers the system player.

import { openPath } from '@tauri-apps/plugin-opener';
import { writeText } from '@tauri-apps/plugin-clipboard-manager';
import { mediaInfo, mediaSrcUrl, type MediaInfo } from '../../platform/ipc/media';
import { readFileBytesRaw } from '../../platform/ipc/fs';
import { t, tf } from '../../platform/i18n';
import { mediaMime } from '../../platform/markdown';
import { actionButton, basename, dirname, el, formatBytes, notify, showContextMenu, type MenuEntry } from '../../platform/ui/index';

export interface MediaViewOptions {
	/** Open this file's bytes in the hex viewer. */
	onOpenHex?: () => void;
}

/** Past this size the no-protocol fallback (one base64 read) refuses — a remote shell's
 *  wire cannot carry a feature film whole, and the system player is the answer there. */
const BASE64_CAP = 128 * 1024 * 1024;
/** The seek steps the arrow keys and the back/forward doubles take, seconds. */
const SEEK_STEP = 5;
const RATES = [0.5, 0.75, 1, 1.25, 1.5, 2];

function remoteShell(): boolean {
	return typeof document !== 'undefined' && document.documentElement.hasAttribute('data-remote-shell');
}

/** m:ss, or h:mm:ss past an hour. */
function formatTime(seconds: number): string {
	if (!isFinite(seconds) || seconds < 0) seconds = 0;
	const total = Math.floor(seconds);
	const h = Math.floor(total / 3600);
	const m = Math.floor((total % 3600) / 60);
	const s = total % 60;
	const two = (n: number) => n.toString().padStart(2, '0');
	return h > 0 ? `${h}:${two(m)}:${two(s)}` : `${m}:${two(s)}`;
}

function formatBitrate(bps: number | undefined): string {
	if (!bps || bps <= 0) return '—';
	return bps >= 1_000_000 ? `${(bps / 1_000_000).toFixed(2)} Mbps` : `${Math.round(bps / 1000)} kbps`;
}

function formatFps(fps: number | undefined): string {
	return fps && fps > 0 ? `${fps.toFixed(fps < 100 ? 2 : 0)} fps` : '—';
}

function formatChannels(channels: number | undefined): string {
	if (!channels || channels <= 0) return '—';
	if (channels === 1) return t('media.channels.mono');
	if (channels === 2) return t('media.channels.stereo');
	return tf('media.channels.count', channels);
}

function formatRate(rate: number | undefined): string {
	return rate && rate > 0 ? `${rate >= 1000 ? (rate / 1000).toFixed(rate % 1000 === 0 ? 0 : 1) + ' kHz' : rate + ' Hz'}` : '—';
}

/** One information-panel row: the label, the value, and a click that copies it. */
function infoRow(label: string, value: string): HTMLElement {
	const row = el('div', 'media-info-row');
	const valueEl = el('span', 'media-info-value', [value || '—']);
	row.append(el('span', 'media-info-label', [label]), valueEl);
	if (value) {
		row.title = t('media.copyValue');
		row.addEventListener('click', () => {
			void writeText(value).then(() => notify('info', t('media.copied')));
		});
	}
	return row;
}

function infoSection(title: string, rows: HTMLElement[]): HTMLElement {
	const section = el('div', 'media-info-section');
	section.append(el('div', 'media-info-title', [title]));
	section.append(...rows);
	return section;
}

export class MediaView {
	readonly root: HTMLElement;
	private readonly stage: HTMLElement;
	private readonly art: HTMLElement;
	private readonly video: HTMLVideoElement;
	private readonly message: HTMLElement;
	private readonly toolbar: HTMLElement;
	private readonly playButton: HTMLButtonElement;
	private readonly muteButton: HTMLButtonElement;
	private readonly loopButton: HTMLButtonElement;
	private readonly timeLabel: HTMLElement;
	private readonly seek: HTMLInputElement;
	private readonly rateSelect: HTMLSelectElement;
	private readonly info: HTMLElement;
	private readonly infoBody: HTMLElement;
	private readonly infoButton: HTMLButtonElement;

	/** The probed container facts, and which rows the playing element has since refined. */
	private infoData: MediaInfo | null = null;
	private elementDuration: number | null = null;
	private isVideo = false;
	/** The source in use: the protocol URL, or a blob URL over one base64 read. */
	private usingProtocol = false;
	/** The decode-failure fallback already tried the byte read. */
	private bytesTried = false;
	private blobUrl: string | null = null;
	private loadToken = 0;
	private disposed = false;

	constructor(private readonly path: string, private readonly options: MediaViewOptions = {}) {
		const label = basename(path);
		this.isVideo = (mediaMime(label) ?? '').startsWith('video');

		this.video = el('video', 'media-video') as HTMLVideoElement;
		this.video.preload = 'metadata';
		this.video.playsInline = true;
		this.video.hidden = !this.isVideo;
		this.art = el('div', 'media-art', [el('span', 'codicon codicon-file-media media-art-icon'), el('span', 'media-art-name', [label])]);
		this.art.hidden = this.isVideo;
		this.message = el('div', 'media-message', [t('media.loading')]);
		this.stage = el('div', 'media-stage', [this.art, this.video, this.message]);

		this.playButton = actionButton('play', t('media.play'), () => this.togglePlay());
		this.muteButton = actionButton('mute', t('media.mute'), () => {
			this.video.muted = !this.video.muted;
		});
		this.loopButton = actionButton('sync', t('media.loop'), () => {
			this.video.loop = !this.video.loop;
			this.loopButton.classList.toggle('active', this.video.loop);
		});
		this.timeLabel = el('span', 'media-time', ['0:00 / 0:00']);
		this.seek = el('input', 'media-seek') as HTMLInputElement;
		this.seek.type = 'range';
		this.seek.min = '0';
		this.seek.max = '1000';
		this.seek.step = '1';
		this.seek.value = '0';
		this.seek.setAttribute('aria-label', t('media.seek'));
		this.seek.addEventListener('input', () => {
			const duration = this.video.duration;
			if (isFinite(duration) && duration > 0) this.video.currentTime = (Number(this.seek.value) / 1000) * duration;
		});
		this.rateSelect = el('select', 'media-rate') as HTMLSelectElement;
		this.rateSelect.setAttribute('aria-label', t('media.rate'));
		for (const rate of RATES) {
			const option = el('option', '', [`${rate}×`]) as HTMLOptionElement;
			option.value = String(rate);
			if (rate === 1) option.selected = true;
			this.rateSelect.append(option);
		}
		this.rateSelect.addEventListener('change', () => {
			this.video.playbackRate = Number(this.rateSelect.value);
		});

		const sep = () => el('span', 'media-sep');
		const systemButton = actionButton('desktop-download', t('media.systemPlayer'), () => this.openInSystemPlayer());
		// A browser page's "open" is a download shim, not a player: the row hides there.
		systemButton.hidden = remoteShell();
		const copyButton = actionButton('copy', t('media.copyPath'), () => {
			void writeText(this.path).then(() => notify('info', t('media.copied')));
		});
		const hexButton = actionButton('json', t('media.openHex'), () => this.options.onOpenHex?.());
		hexButton.hidden = !this.options.onOpenHex;
		this.infoButton = actionButton('info', t('media.info'), () => this.toggleInfo());
		this.infoButton.classList.add('active');
		this.toolbar = el('div', 'media-toolbar', [
			el('span', 'media-group', [this.playButton, this.timeLabel, this.seek, this.muteButton, this.rateSelect, this.loopButton]),
			sep(),
			el('span', 'media-group', [systemButton, copyButton, hexButton, this.infoButton])
		]);

		this.infoBody = el('div', 'media-info-body');
		this.info = el('div', 'media-info', [this.infoBody]);
		this.root = el('div', 'media-preview', [this.stage, this.toolbar, this.info]);

		// The element's own events: the playhead's motion, the metadata the probe missed,
		// and the decode failure the system player answers.
		this.video.addEventListener('loadedmetadata', () => this.onMetadata());
		this.video.addEventListener('timeupdate', () => this.onTime());
		this.video.addEventListener('play', () => this.syncPlayState());
		this.video.addEventListener('pause', () => this.syncPlayState());
		this.video.addEventListener('ended', () => this.syncPlayState());
		this.video.addEventListener('volumechange', () => this.syncMuteState());
		this.video.addEventListener('error', () => void this.onDecodeError());
		this.stage.addEventListener('dblclick', () => this.togglePlay());
		this.stage.addEventListener('contextmenu', (event) => {
			event.preventDefault();
			event.stopPropagation();
			showContextMenu(event.clientX, event.clientY, this.menuEntries());
		});
		this.root.addEventListener('keydown', (event) => this.onKey(event));
	}

	/** Loads the file: the container facts first (they answer even when the codec does not
	 *  play), then the source. */
	async load(): Promise<void> {
		const token = ++this.loadToken;
		try {
			const info = await mediaInfo(this.path);
			if (token !== this.loadToken || this.disposed) return;
			this.infoData = info;
			this.renderInfo();
		} catch {
			// The panel stays with what the element answers; the source attempt reports its own failure.
		}
		if (token !== this.loadToken || this.disposed) return;
		// A remote shell's convertFileSrc spells a route the daemon does not serve (its
		// shim says so) — the whole-file read is the remote path, not a fallback to wait for.
		const protocol = remoteShell() ? null : mediaSrcUrl(this.path);
		if (protocol) {
			// A previous byte-fallback's blob (a decode error before this reload) goes back.
			this.releaseBlob();
			this.usingProtocol = true;
			this.video.src = protocol;
		} else {
			await this.loadAsBytes();
		}
	}

	/** One whole-file read into a blob URL — the no-protocol fallback (and the decode
	 *  failure's second attempt). False when the size cap or a read error refused. */
	private async loadAsBytes(): Promise<boolean> {
		const token = this.loadToken;
		const size = this.infoData?.sizeBytes ?? 0;
		if (size > BASE64_CAP) {
			this.showMessage(t('media.tooLarge'), [
				{ label: t('media.systemPlayer'), run: () => this.openInSystemPlayer() }
			]);
			return false;
		}
		try {
			// The bytes cross raw (no base64 text, no per-character decode loop): the file
			// lands as one ArrayBuffer, wrapped straight into the blob URL. The known size
			// rides as the length when the facts answered; without them the whole-file read
			// (backend-capped) still serves.
			const raw = size > 0 ? await readFileBytesRaw(this.path, 0, size) : await readFileBytesRaw(this.path);
			if (token !== this.loadToken || this.disposed) return false;
			this.releaseBlob();
			this.usingProtocol = false;
			this.bytesTried = true;
			const bytes = raw instanceof Uint8Array ? new Uint8Array(raw) : new Uint8Array(raw);
			this.blobUrl = URL.createObjectURL(new Blob([bytes], { type: mediaMime(basename(this.path)) ?? 'application/octet-stream' }));
			this.video.src = this.blobUrl;
			this.hideMessage();
			return true;
		} catch (error) {
			if (token !== this.loadToken || this.disposed) return false;
			this.showMessage(t('media.readFailed') + String(error), [
				{ label: t('media.systemPlayer'), run: () => this.openInSystemPlayer() }
			]);
			return false;
		}
	}

	private releaseBlob(): void {
		if (this.blobUrl) {
			URL.revokeObjectURL(this.blobUrl);
			this.blobUrl = null;
		}
	}

	/** A reload in place when the file changes on disk (the image viewer's contract): the
	 *  facts re-probed, the source re-fetched, the playhead back to the start. */
	async reload(): Promise<void> {
		const wasPlaying = !this.video.paused && !this.video.ended;
		const at = this.video.currentTime;
		this.bytesTried = false;
		this.elementDuration = null;
		await this.load();
		if (this.infoData && this.infoData.sizeBytes > 0 && at > 0) {
			// Resume where it was, unless the position outran the new file.
			this.video.addEventListener('loadedmetadata', () => {
				if (this.disposed) return;
				if (at < this.video.duration) this.video.currentTime = at;
				if (wasPlaying) void this.video.play().catch(() => undefined);
			}, { once: true });
		}
	}

	private onMetadata(): void {
		if (this.disposed) return;
		this.hideMessage();
		if (isFinite(this.video.duration)) this.elementDuration = this.video.duration * 1000;
		// The element's decoded dimensions are the truth when the container never said.
		if (this.video.videoWidth > 0) {
			this.infoData ??= { sizeBytes: 0 };
			this.infoData.video ??= {};
			this.infoData.video.width ??= this.video.videoWidth;
			this.infoData.video.height ??= this.video.videoHeight;
		}
		this.renderInfo();
		this.onTime();
	}

	private onTime(): void {
		const current = this.video.currentTime;
		const duration = this.video.duration;
		this.timeLabel.textContent = `${formatTime(current)} / ${formatTime(duration)}`;
		if (isFinite(duration) && duration > 0 && !this.seekDragging) {
			this.seek.value = String(Math.round((current / duration) * 1000));
		}
	}

	/** The seek bar is under the pointer's hand: timeupdate may not fight it. */
	private get seekDragging(): boolean {
		return this.seek.matches(':active');
	}

	private syncPlayState(): void {
		const playing = !this.video.paused && !this.video.ended;
		this.playButton.firstElementChild?.classList.toggle('codicon-play', !playing);
		this.playButton.firstElementChild?.classList.toggle('codicon-debug-pause', playing);
		this.playButton.title = playing ? t('media.pause') : t('media.play');
	}

	private syncMuteState(): void {
		const muted = this.video.muted || this.video.volume === 0;
		this.muteButton.firstElementChild?.classList.toggle('codicon-mute', !muted);
		this.muteButton.firstElementChild?.classList.toggle('codicon-unmute', muted);
		this.muteButton.title = muted ? t('media.unmute') : t('media.mute');
	}

	private togglePlay(): void {
		if (this.video.paused || this.video.ended) void this.video.play().catch(() => this.onDecodeError());
		else this.video.pause();
	}

	private async onDecodeError(): Promise<void> {
		if (this.disposed) return;
		// A protocol response that never came (no handler, a refused path) gets one retry
		// over a whole-file read; a decode failure past that is the webview build's codec
		// set, and the system player is the honest answer.
		if (this.usingProtocol && !this.bytesTried) {
			await this.loadAsBytes();
			return;
		}
		this.showMessage(t('media.decodeFailed'), [
			{ label: t('media.systemPlayer'), run: () => this.openInSystemPlayer() }
		]);
	}

	private openInSystemPlayer(): void {
		if (remoteShell()) return;
		void openPath(this.path).catch((error) => notify('error', String(error)));
	}

	private showMessage(text: string, actions: { label: string; run: () => void }[] = []): void {
		this.message.replaceChildren(el('span', '', [text]));
		for (const action of actions) {
			const button = el('button', 'media-message-action', [action.label]);
			button.addEventListener('click', (event) => {
				event.stopPropagation();
				action.run();
			});
			this.message.append(button);
		}
		this.message.hidden = false;
	}

	private hideMessage(): void {
		this.message.hidden = true;
	}

	private toggleInfo(): void {
		const showing = this.info.hidden;
		this.info.hidden = !showing;
		this.infoButton.classList.toggle('active', showing);
	}

	/** The container facts, laid out: the file row, the overall set, then each track the
	 *  container declared. Every value copies on click. */
	private renderInfo(): void {
		const data = this.infoData;
		const name = basename(this.path);
		const size = data?.sizeBytes ? formatBytes(data.sizeBytes) : '—';
		const durationMs = this.elementDuration ?? data?.durationMs;
		const rows: HTMLElement[] = [
			infoRow(t('media.info.name'), name),
			infoRow(t('media.info.folder'), dirname(this.path)),
			infoRow(t('media.info.format'), data?.format ?? t('media.info.unknownFormat')),
			infoRow(t('media.info.duration'), durationMs && durationMs > 0 ? formatTime(durationMs / 1000) : '—'),
			infoRow(t('media.info.size'), size),
			infoRow(t('media.info.bitrate'), formatBitrate(data?.bitrateBps))
		];
		const sections = [infoSection(t('media.info.file'), rows)];
		if (data?.video && (data.video.codec || data.video.width || data.video.height || data.video.fps)) {
			sections.push(infoSection(t('media.info.video'), [
				infoRow(t('media.info.codec'), data.video.codec ?? '—'),
				infoRow(t('media.info.resolution'), data.video.width && data.video.height ? `${data.video.width} × ${data.video.height}` : '—'),
				infoRow(t('media.info.frameRate'), formatFps(data.video.fps))
			]));
		}
		if (data?.audio && (data.audio.codec || data.audio.sampleRate || data.audio.channels)) {
			sections.push(infoSection(t('media.info.audio'), [
				infoRow(t('media.info.codec'), data.audio.codec ?? '—'),
				infoRow(t('media.info.sampleRate'), formatRate(data.audio.sampleRate)),
				infoRow(t('media.info.channels'), formatChannels(data.audio.channels)),
				infoRow(t('media.info.bits'), data.audio.bitsPerSample ? `${data.audio.bitsPerSample} bit` : '—')
			]));
		}
		this.infoBody.replaceChildren(...sections);
	}

	private menuEntries(): MenuEntry[] {
		const entries: MenuEntry[] = [
			{ label: this.video.paused ? t('media.play') : t('media.pause'), run: () => this.togglePlay() },
			{ label: this.video.muted ? t('media.unmute') : t('media.mute'), run: () => { this.video.muted = !this.video.muted; } },
			{ label: t('media.loop'), run: () => { this.video.loop = !this.video.loop; this.loopButton.classList.toggle('active', this.video.loop); } }
		];
		if (!remoteShell()) entries.push({ label: t('media.systemPlayer'), run: () => this.openInSystemPlayer() });
		entries.push(
			{ label: t('media.copyPath'), run: () => void writeText(this.path).then(() => notify('info', t('media.copied'))) },
			{ label: t('media.info'), run: () => this.toggleInfo() }
		);
		if (this.options.onOpenHex) entries.push({ label: t('media.openHex'), run: () => this.options.onOpenHex?.() });
		return entries;
	}

	/** The keyboard surface: space plays, the arrows step, M mutes, L loops, I the panel. */
	private onKey(event: KeyboardEvent): void {
		const target = event.target as HTMLElement | null;
		if (target && (target.tagName === 'INPUT' || target.tagName === 'SELECT') && target !== this.seek) return;
		// The focused seek slider moves itself with the arrows; stepping it again here
		// would double every press.
		if (target === this.seek && event.key.startsWith('Arrow')) return;
		switch (event.key) {
			case ' ':
			case 'k':
				event.preventDefault();
				this.togglePlay();
				break;
			case 'ArrowLeft':
				this.video.currentTime = Math.max(0, this.video.currentTime - SEEK_STEP);
				break;
			case 'ArrowRight':
				this.video.currentTime = Math.min(this.video.duration || Infinity, this.video.currentTime + SEEK_STEP);
				break;
			case 'm':
				this.video.muted = !this.video.muted;
				break;
			case 'l':
				this.loopButton.click();
				break;
			case 'i':
				this.toggleInfo();
				break;
		}
	}

	dispose(): void {
		this.disposed = true;
		this.loadToken++;
		this.video.pause();
		this.video.removeAttribute('src');
		this.video.load();
		this.releaseBlob();
		this.root.remove();
	}
}
