// The media viewer (module 7): the mime classification that routes a video/audio open, the
// view itself — its toolbar (play, seek, mute, speed, loop), the container-facts panel the
// backend's parsers answer, the context menu, the system-player hand-off, the decode
// failure's fallback ladder (protocol → whole-file read → system player) — the open
// routing (a media file never reaches the binary probe), and the in-place reload.

import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { EditorGroup } from '../src/features/editor';
import { mediaMime } from '../src/platform/markdown';
import type { MediaView } from '../src/features/viewers/types';
import { backend } from './tauriMock';
import { click, flush, menuItem, menuLabels, rightClick } from './helpers';

const REPO = 'C:\\repo';

/** The container facts the backend's MP4 walk answers for a 1080p phone recording. */
const MP4_INFO = {
	format: 'MP4',
	durationMs: 65_000,
	bitrateBps: 4_200_000,
	sizeBytes: 34_125_000,
	video: { codec: 'H.264', width: 1920, height: 1080, fps: 29.97 },
	audio: { codec: 'AAC', sampleRate: 44100, channels: 2 }
};

const FLAC_INFO = {
	format: 'FLAC',
	durationMs: 187_000,
	bitrateBps: 890_000,
	sizeBytes: 20_800_000,
	audio: { codec: 'FLAC', sampleRate: 48_000, channels: 2, bitsPerSample: 16 }
};

beforeAll(() => {
	// jsdom neither decodes media nor hands out object URLs: the view's element answers
	// through what the tests set, the blob hop is a recorded stub.
	HTMLMediaElement.prototype.play = vi.fn(function (this: HTMLMediaElement) {
		this.dispatchEvent(new Event('play'));
		return Promise.resolve();
	});
	HTMLMediaElement.prototype.pause = vi.fn(function (this: HTMLMediaElement) {
		this.dispatchEvent(new Event('pause'));
	});
	HTMLMediaElement.prototype.load = vi.fn(function (this: HTMLMediaElement) {});
	URL.createObjectURL = vi.fn(() => 'blob:mocked');
	URL.revokeObjectURL = vi.fn();
});

beforeEach(() => {
	backend.on('media_info', ({ path } = {} as never) => (String(path).toLowerCase().endsWith('.flac') ? FLAC_INFO : MP4_INFO));
	backend.on('read_file_base64', () => 'AAAA');
	// No folder tree, no git: the open path is the media routing's alone here.
	backend.on('list_dir', () => []);
});

function openMedia(path: string): Promise<EditorGroup> {
	const group = new EditorGroup(document.getElementById('editorGroup')!);
	group.setRoot(REPO);
	return group.openFile(path).then(() => group);
}

function view(group: EditorGroup): MediaView {
	const editor = group.active!;
	return editor.media!;
}

describe('media mime routing', () => {
	it('answers the player mime for the video and audio extensions', () => {
		expect(mediaMime('clip.mp4')).toBe('video/mp4');
		expect(mediaMime('clip.m4v')).toBe('video/mp4');
		expect(mediaMime('PhoneRecording.MOV')).toBe('video/quicktime');
		expect(mediaMime('anim.webm')).toBe('video/webm');
		expect(mediaMime('tv.mkv')).toBe('video/x-matroska');
		expect(mediaMime('old.avi')).toBe('video/x-msvideo');
		expect(mediaMime('song.mp3')).toBe('audio/mpeg');
		expect(mediaMime('song.m4a')).toBe('audio/mp4');
		expect(mediaMime('song.flac')).toBe('audio/flac');
		expect(mediaMime('voice.opus')).toBe('audio/ogg');
		expect(mediaMime('beep.wav')).toBe('audio/wav');
		expect(mediaMime('notes.txt')).toBeNull();
		expect(mediaMime('noext')).toBeNull();
	});
});

describe('media viewer', () => {
	it('opens a video in the player without ever probing its bytes', async () => {
		const group = await openMedia(`${REPO}\\clip.mp4`);
		const editor = group.active!;
		expect(editor.media).toBeDefined();
		expect(editor.languageName).toBe('Media');
		expect(document.querySelector('.media-preview')).not.toBeNull();
		const video = document.querySelector<HTMLVideoElement>('.media-video')!;
		expect(video.hidden).toBe(false);
		// The audio art stays for audio only.
		expect(document.querySelector<HTMLElement>('.media-art')!.hidden).toBe(true);
		// The routing answered before the binary probe: no probe call happened.
		expect(backend.callsTo('file_probe')).toHaveLength(0);
		// The streaming source is the protocol URL, not a whole-file read.
		expect(video.src).toContain('ggsmedia.localhost');
		expect(backend.callsTo('read_file_base64')).toHaveLength(0);
	});

	it('answers the information panel from the container probe', async () => {
		await openMedia(`${REPO}\\clip.mp4`);
		const text = document.querySelector<HTMLElement>('.media-info')!.textContent!;
		expect(text).toContain('MP4');
		expect(text).toContain('H.264');
		expect(text).toContain('1920 × 1080');
		expect(text).toContain('29.97 fps');
		expect(text).toContain('AAC');
		expect(text).toContain('44.1 kHz');
		expect(text).toContain('Stereo');
		expect(text).toContain('1:05');
		expect(text).toContain('4.20 Mbps');
	});

	it('an audio file shows the art, hides the video layer, and skips the video section', async () => {
		await openMedia(`${REPO}\\song.flac`);
		const video = document.querySelector<HTMLVideoElement>('.media-video')!;
		expect(video.hidden).toBe(true);
		expect(document.querySelector<HTMLElement>('.media-art')!.hidden).toBe(false);
		const text = document.querySelector<HTMLElement>('.media-info')!.textContent!;
		expect(text).toContain('FLAC');
		expect(text).toContain('16 bit');
		expect(text).not.toContain('Resolution');
	});

	it('plays, pauses, seeks and mutes through the toolbar', async () => {
		await openMedia(`${REPO}\\clip.mp4`);
		const video = document.querySelector<HTMLVideoElement>('.media-video')!;
		Object.defineProperty(video, 'duration', { value: 65, configurable: true });
		// jsdom's paused never moves: the stubs drive it, the view reads it.
		let playing = false;
		Object.defineProperty(video, 'paused', { get: () => !playing, configurable: true });
		const play = (video.play as ReturnType<typeof vi.fn>).mockImplementation(function (this: HTMLMediaElement) {
			playing = true;
			this.dispatchEvent(new Event('play'));
			return Promise.resolve();
		});

		click(document.querySelector<HTMLButtonElement>('.media-toolbar .action-btn')!);
		expect(play).toHaveBeenCalled();
		expect(document.querySelector('.media-toolbar .codicon-debug-pause')).not.toBeNull();

		const seek = document.querySelector<HTMLInputElement>('.media-seek')!;
		seek.value = '500';
		seek.dispatchEvent(new Event('input'));
		expect(video.currentTime).toBe(32.5);

		Object.defineProperty(video, 'currentTime', { value: 32, configurable: true });
		video.dispatchEvent(new Event('timeupdate'));
		expect(document.querySelector<HTMLElement>('.media-time')!.textContent).toBe('0:32 / 1:05');

		const muteButton = document.querySelector<HTMLButtonElement>('.codicon-mute')!.closest('.action-btn')! as HTMLButtonElement;
		click(muteButton);
		expect(video.muted).toBe(true);
		expect(document.querySelector('.media-toolbar .codicon-unmute')).not.toBeNull();
	});

	it('copies the path from the context menu, and the menu names the player', async () => {
		const group = await openMedia(`${REPO}\\clip.mp4`);
		rightClick(document.querySelector<HTMLElement>('.media-stage')!);
		const labels = menuLabels();
		for (const label of ['Play', 'Loop', 'Open in System Player', 'Copy Path', 'Media Information', 'Open in Hex Viewer']) {
			expect(labels).toContain(label);
		}
		click(menuItem('Copy Path'));
		await flush();
		expect(backend.clipboard).toEqual([`${REPO}\\clip.mp4`]);
		expect(view(group)).toBeDefined();
	});

	it('hands a playback off to the system player through the opener', async () => {
		const group = await openMedia(`${REPO}\\clip.mp4`);
		const editor = group.active!;
		const viewer = editor.media as unknown as { openInSystemPlayer: () => void };
		viewer.openInSystemPlayer();
		await flush();
		expect(backend.openedPaths).toEqual([`${REPO}\\clip.mp4`]);
	});

	it('a decode failure retries over a whole read, then offers the system player', async () => {
		const group = await openMedia(`${REPO}\\clip.mp4`);
		const editor = group.active!;
		const video = document.querySelector<HTMLVideoElement>('.media-video')!;
		// The protocol URL was set; the element's error asks the byte read.
		video.dispatchEvent(new Event('error'));
		await flush();
		expect(backend.callsTo('read_file_base64')).toHaveLength(1);
		expect(video.src).toBe('blob:mocked');
		// A second failure past the byte read is a codec the webview lacks: the message
		// names the system player, and its action hands off.
		video.dispatchEvent(new Event('error'));
		await flush();
		const message = document.querySelector<HTMLElement>('.media-message')!;
		expect(message.hidden).toBe(false);
		expect(message.textContent).toContain('decoder');
		expect(backend.openedPaths).toHaveLength(0);
		click(message.querySelector<HTMLButtonElement>('.media-message-action')!);
		await flush();
		expect(backend.openedPaths).toEqual([`${REPO}\\clip.mp4`]);
		expect(view(group)).toBeDefined();
	});

	it('a file past the byte-read cap skips straight to the system player offer', async () => {
		backend.on('media_info', () => ({ ...MP4_INFO, sizeBytes: 200 * 1024 * 1024 }));
		const group = await openMedia(`${REPO}\\clip.mp4`);
		const video = document.querySelector<HTMLVideoElement>('.media-video')!;
		video.dispatchEvent(new Event('error')); // the protocol URL never answers
		await flush();
		const message = document.querySelector<HTMLElement>('.media-message')!;
		expect(message.hidden).toBe(false);
		expect(message.textContent).toContain('system player');
		expect(backend.callsTo('read_file_base64')).toHaveLength(0);
	});

	it('reloads in place when the file changes on disk', async () => {
		const group = await openMedia(`${REPO}\\clip.mp4`);
		const calls = () => backend.callsTo('media_info').length;
		const before = calls();
		await (group as unknown as { reloadIfClean: (p: string) => Promise<void> }).reloadIfClean(`${REPO}\\clip.mp4`);
		expect(calls()).toBe(before + 1);
	});

	it('a reload back to the protocol releases the byte fallback’s blob URL', async () => {
		const group = await openMedia(`${REPO}\\clip.mp4`);
		const video = document.querySelector<HTMLVideoElement>('.media-video')!;
		video.dispatchEvent(new Event('error')); // the protocol fails → the blob hop
		await flush();
		expect(video.src).toBe('blob:mocked');
		const revoke = URL.revokeObjectURL as ReturnType<typeof vi.fn>;
		revoke.mockClear();
		await (group as unknown as { reloadIfClean: (p: string) => Promise<void> }).reloadIfClean(`${REPO}\\clip.mp4`);
		// The protocol source is set again, and the fallback's blob went back.
		expect(video.src).not.toBe('blob:mocked');
		expect(revoke).toHaveBeenCalledWith('blob:mocked');
	});

	it("the explorer's context menu names the system player for a media file alone", async () => {
		backend.on('list_dir', () => [
			{ name: 'clip.mp4', path: `${REPO}\\clip.mp4`, isDir: false, size: 34_125_000 },
			{ name: 'notes.md', path: `${REPO}\\notes.md`, isDir: false, size: 300 }
		]);
		const { Explorer } = await import('../src/features/explorer/explorer');
		const explorer = new Explorer(document.getElementById('sidebar')!);
		explorer.setRoot(REPO);
		await flush();
		const rows = document.querySelectorAll('.tree .row');
		rightClick(rows[0]); // the video
		expect(menuLabels()).toContain('Open in System Player');
		rightClick(rows[1]); // the markdown
		expect(menuLabels()).not.toContain('Open in System Player');
	});
});
