// The session's own traffic accounting (docs/ggs-remote-plan.md §10.5): what this browser
// put on and took off the WebSocket, by frame type and — where the frame names its subject —
// by command and event. Wire bytes are what the link actually carried (frame headers
// included, compression applied); plain bytes are the same payloads uncompressed, so the
// compression's saving reads against them. Transport fills the tables; the Traffic page
// (trafficPage.ts) renders them.
import { HEADER_LEN } from './frame';

export interface Bucket {
	/** Frame headers included. */
	bytes: number;
	frames: number;
}

export interface TrafficStats {
	/** Wire bytes, socket-side: every uplink frame's header + payload, every downlink
	 *  WebSocket message as it arrived. */
	up: number;
	down: number;
	/** The same traffic with the compression taken back out: uplink payloads before
	 *  deflating, downlink payloads after inflating. Uplink ≥ `up`, downlink ≥ `down`. */
	upPlain: number;
	downPlain: number;
	/** Per frame type, wire bytes — the uplink's own and the downlink's. */
	upByType: Map<number, Bucket>;
	downByType: Map<number, Bucket>;
	/** Per subject — `invoke <cmd>` for an invoke and its result, `event <name>` for an
	 *  event, `channel` for channel data — wire bytes and frames. */
	byName: Map<string, Bucket>;
	startedAt: number;
}

export function newTrafficStats(): TrafficStats {
	return {
		up: 0,
		down: 0,
		upPlain: 0,
		downPlain: 0,
		upByType: new Map(),
		downByType: new Map(),
		byName: new Map(),
		startedAt: Date.now()
	};
}

export function bucketOf(map: Map<number | string, Bucket>, key: number | string): Bucket {
	let entry = map.get(key);
	if (!entry) {
		entry = { bytes: 0, frames: 0 };
		map.set(key, entry);
	}
	return entry;
}

export function countBytes(map: Map<number | string, Bucket>, key: number | string, bytes: number): void {
	const entry = bucketOf(map, key);
	entry.bytes += bytes;
	entry.frames += 1;
}

/** One wire frame's accounted size: its payload plus the 20-byte header every frame wears. */
export function frameBytes(payloadLength: number): number {
	return payloadLength + HEADER_LEN;
}

/** The name bucket's key for a subject. */
export function nameKey(kind: 'invoke' | 'event', name: string): string {
	return `${kind} ${name}`;
}

/** The compression's saving, 0..1 — how much less crossed the wire than would have
 *  uncompressed; meaningless before anything compressed (answers 0). */
export function compressionSaved(stats: TrafficStats): number {
	const wire = stats.up + stats.down;
	const plain = stats.upPlain + stats.downPlain;
	return plain > 0 ? Math.max(0, 1 - wire / plain) : 0;
}
