// The typed IPC seam of the media viewer (module 7): a video/audio file's container-level
// facts (the ggs-fs media parsers behind the cmd_media adapter), and the streaming URL a
// player element loads the file from — the app's `ggsmedia://` protocol, which answers the
// element's HTTP Range requests in bounded windows, confined to the open workspace roots.
import { convertFileSrc, invoke } from './core';

export interface MediaVideoTrack {
	codec?: string;
	width?: number;
	height?: number;
	fps?: number;
}

export interface MediaAudioTrack {
	codec?: string;
	sampleRate?: number;
	channels?: number;
	bitsPerSample?: number;
}

export interface MediaInfo {
	/** The container format ("MP4", "WebM", "WAV", …), absent when unknown. */
	format?: string;
	/** Total duration, milliseconds. */
	durationMs?: number;
	/** The average bitrate over the whole file, bits per second. */
	bitrateBps?: number;
	sizeBytes: number;
	video?: MediaVideoTrack;
	audio?: MediaAudioTrack;
}

export const mediaInfo = (path: string) => invoke<MediaInfo>('media_info', { path });

/** The streaming URL the media element plays (`http://ggsmedia.localhost/…` on Windows,
 *  `ggsmedia://…` elsewhere), or null where no protocol handler exists — the remote
 *  shells and a browser page have none, and the view falls back to a byte read. */
export function mediaSrcUrl(path: string): string | null {
	if (typeof convertFileSrc !== 'function') return null;
	return convertFileSrc(path, 'ggsmedia');
}
