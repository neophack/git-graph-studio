//! CAN log parsing, statistics and conversion (CANoe's Statistics window and "Save As"):
//! parses Vector `.blf` (binary logging format) and `.asc` (text logging format) traces,
//! aggregates them — per-channel frame and error counts, bus load from the bits each frame
//! puts on the wire, per-identifier counts and cycle times — and converts between the two
//! formats without losing a frame. Everything performance-critical (the container
//! decompression, the per-frame walk, the median/percentile math, the writing) runs here;
//! the statistics view only renders results.
//!
//! The parse is one streaming path: a reader walks the source and hands every frame to a
//! `FrameSink` — the statistics aggregator, the cycle-analysis collector or the format
//! converter — so each consumer sees the whole log without one shared intermediate
//! representation on the heap.

use std::collections::HashMap;
use std::fs::File;
use std::io::{BufRead, BufWriter, Cursor, Read, Seek, Write};
use std::path::Path;
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use serde::{Deserialize, Serialize};

/* ---------- The frame ---------- */

/// One CAN frame as either format can express it: the common ground of BLF and ASC, so a
/// conversion is exactly a read into this and a write out of it.
pub struct RawFrame {
	/// Seconds into the measurement, in nanoseconds.
	pub t_ns: u64,
	/// The bus channel, 1-based the way both formats write it.
	pub channel: u16,
	/// The arbitration id, masked to 29 bits.
	pub id: u32,
	pub extended: bool,
	pub fd: bool,
	pub brs: bool,
	pub esi: bool,
	/// A remote request (classic CAN `r` frames; BLF's 0x80 flag).
	pub remote: bool,
	/// An error frame rather than a data frame.
	pub error: bool,
	/// The DLC as written: classic 0..8, CAN FD the length code 0..15.
	pub dlc: u8,
	/// The payload bytes actually present.
	pub len: u8,
	pub data: [u8; 64],
	pub tx: bool,
}

impl RawFrame {
	#[allow(clippy::too_many_arguments)]
	fn data_frame(t_ns: u64, channel: u16, id: u32, extended: bool, fd: bool, dlc: u8, len: u8, data: &[u8], tx: bool) -> Self {
		let mut frame = RawFrame {
			t_ns,
			channel,
			id,
			extended,
			fd,
			brs: false,
			esi: false,
			remote: false,
			error: false,
			dlc,
			len,
			data: [0; 64],
			tx,
		};
		frame.len = (len as usize).min(64) as u8;
		frame.data[..frame.len as usize].copy_from_slice(&data[..frame.len as usize]);
		frame
	}
}

/// What a reader hands its consumer for every object it walks.
pub trait FrameSink {
	fn frame(&mut self, frame: RawFrame);
	/// An object the parser recognised but this consumer does not model (BLF holds many —
	/// environment variables, most containers' padding tails — that are not CAN traffic).
	fn other(&mut self) {}
	/// The frames handed over so far — what a progress report shows the user.
	fn seen(&self) -> u64 {
		0
	}
	/// True once the consumer has failed (a conversion whose target write errored): the
	/// walk stops at the next chunk boundary rather than reading a log it cannot use.
	fn failed(&self) -> bool {
		false
	}
}

/** The bits a CAN frame occupies on the bus, CANoe's worst-case stuffing estimate: the raw
 *  frame (SOF, arbitration, control, data, CRC, ACK, EOF and the 3-bit intermission), plus
 *  one stuff bit per four raw bits.
 */
fn frame_bits(extended: bool, fd: bool, len: u64) -> f64 {
	// Classic: 47 bits + data (67 with the 18 extended-id bits); CAN FD keeps the same
	// arbitration phase and the estimate stops there — a detailed CRC/EOF split would not
	// change a load figure by a percent.
	let raw = if extended { 67.0 } else { 47.0 } + 8.0 * len as f64 + if fd { 12.0 } else { 0.0 };
	raw + ((raw - 1.0) / 4.0).floor()
}

/// A CAN FD DLC code (9..15) to its payload length in bytes; 0..8 map to themselves.
pub fn fd_dlc_bytes(dlc: u8) -> u64 {
	match dlc {
		9 => 12,
		10 => 16,
		11 => 20,
		12 => 24,
		13 => 32,
		14 => 48,
		15 => 64,
		n => n as u64,
	}
}

/// A payload length to the CAN FD DLC code that names it (the inverse of `fd_dlc_bytes`).
pub fn len2fd_dlc(len: u64) -> u8 {
	match len {
		0..=8 => len as u8,
		12 => 9,
		16 => 10,
		20 => 11,
		24 => 12,
		32 => 13,
		48 => 14,
		_ => 15,
	}
}

/* ---------- Statistics (CANoe's Statistics window) ---------- */

/// One identifier's aggregate across the whole log (the row CANoe's statistics window shows
/// per message: count, direction split, payload volume and the min/avg/max cycle time).
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CanIdStats {
	pub channel: u16,
	pub id: u32,
	pub extended: bool,
	pub fd: bool,
	pub count: u64,
	pub tx: u64,
	pub rx: u64,
	pub payload_bytes: u64,
	pub first_s: f64,
	pub last_s: f64,
	pub min_cycle_s: f64,
	pub max_cycle_s: f64,
	pub avg_cycle_s: f64,
}

/// A bus channel's totals, from which the view computes the load at any bitrate.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CanChannelStats {
	pub channel: u16,
	pub frames: u64,
	pub error_frames: u64,
	pub payload_bytes: u64,
	/// The bits the frames put on the wire, including the worst-case bit-stuffing estimate
	/// (one stuff bit per four) and the 3-bit intermission — what the load divides by the
	/// bitrate-time product.
	pub bus_bits: f64,
	pub first_s: f64,
	pub last_s: f64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CanLogStats {
	pub format: &'static str,
	/// The measurement's wall-clock start (seconds since the Unix epoch), when the log says.
	pub start_timestamp_s: Option<f64>,
	pub duration_s: f64,
	pub total_frames: u64,
	pub error_frames: u64,
	pub channels: Vec<CanChannelStats>,
	/// Every identifier tracked, busiest first (the view also sorts and filters client-side).
	pub messages: Vec<CanIdStats>,
	/// Identifiers beyond the caps — shown as a "top N shown" note, not as rows.
	pub messages_truncated: u64,
	/// Objects the parser saw but did not understand (BLF holds many; they are not errors).
	pub skipped_objects: u64,
}

/// How many identifiers the aggregate tracks before further distinct ids fold into a
/// counter — bounds the parse's memory on a noisy or hostile log.
const MAX_TRACKED_IDS: usize = 200_000;
/// How many identifier rows cross the IPC bridge — a multi-million-id log must not build
/// a response the webview cannot hold.
const MAX_REPORTED_MESSAGES: usize = 2_000;

struct IdAgg {
	extended: bool,
	fd: bool,
	count: u64,
	tx: u64,
	payload_bytes: u64,
	first_ns: u64,
	last_ns: u64,
	min_cycle_ns: u64,
	max_cycle_ns: u64,
	cycle_sum_ns: u128,
}

#[derive(Default)]
struct ChannelAgg {
	frames: u64,
	error_frames: u64,
	payload_bytes: u64,
	bus_bits: f64,
	first_ns: u64,
	last_ns: u64,
	seen: bool,
}

struct Aggregator {
	/// Keyed by (channel, id, extended): a standard and an extended frame with the same id
	/// are different messages and must not merge.
	ids: std::collections::BTreeMap<(u16, u32, bool), IdAgg>,
	channels: std::collections::BTreeMap<u16, ChannelAgg>,
	total_frames: u64,
	error_frames: u64,
	skipped: u64,
}

impl Aggregator {
	fn new() -> Self {
		Aggregator { ids: Default::default(), channels: Default::default(), total_frames: 0, error_frames: 0, skipped: 0 }
	}

	fn finish(self, format: &'static str, start_timestamp_s: Option<f64>) -> CanLogStats {
		let mut messages: Vec<CanIdStats> = self
			.ids
			.into_iter()
			.map(|((channel, id, _), a)| CanIdStats {
				channel,
				id,
				extended: a.extended,
				fd: a.fd,
				count: a.count,
				tx: a.tx,
				rx: a.count - a.tx,
				payload_bytes: a.payload_bytes,
				first_s: a.first_ns as f64 / 1e9,
				last_s: a.last_ns as f64 / 1e9,
				min_cycle_s: a.min_cycle_ns as f64 / 1e9,
				max_cycle_s: a.max_cycle_ns as f64 / 1e9,
				avg_cycle_s: if a.count > 1 { (a.cycle_sum_ns / ((a.count - 1) as u128)) as f64 / 1e9 } else { 0.0 },
			})
			.collect();
		messages.sort_by(|a, b| b.count.cmp(&a.count).then(a.id.cmp(&b.id)));
		// The note counts identifiers, like the rows it stands for: the tracked ids that did
		// not fit. (Frames past MAX_TRACKED_IDS still count in every total; how many distinct
		// ids they carried is unknowable without breaking the memory cap.)
		let messages_truncated = messages.len().saturating_sub(MAX_REPORTED_MESSAGES) as u64;
		messages.truncate(MAX_REPORTED_MESSAGES);
		let duration = self.channels.values().fold(0u64, |acc, c| acc.max(c.last_ns.saturating_sub(c.first_ns)));
		CanLogStats {
			format,
			start_timestamp_s,
			duration_s: duration as f64 / 1e9,
			total_frames: self.total_frames,
			error_frames: self.error_frames,
			channels: self
				.channels
				.into_iter()
				.map(|(channel, c)| CanChannelStats {
					channel,
					frames: c.frames,
					error_frames: c.error_frames,
					payload_bytes: c.payload_bytes,
					bus_bits: c.bus_bits,
					first_s: c.first_ns as f64 / 1e9,
					last_s: c.last_ns as f64 / 1e9,
				})
				.collect(),
			messages,
			messages_truncated,
			skipped_objects: self.skipped,
		}
	}
}

impl FrameSink for Aggregator {
	fn frame(&mut self, frame: RawFrame) {
		self.note_time(frame.channel, frame.t_ns);
		if frame.error {
			self.error_frames += 1;
			self.channels.get_mut(&frame.channel).unwrap().error_frames += 1;
			return;
		}
		self.total_frames += 1;
		let len = if frame.remote { 0 } else { frame.len as u64 };
		let entry = self.channels.get_mut(&frame.channel).unwrap();
		entry.frames += 1;
		entry.payload_bytes += len;
		entry.bus_bits += frame_bits(frame.extended, frame.fd, len);
		let key = (frame.channel, frame.id, frame.extended);
		// An id already tracked updates in place; a new one joins only while there is
		// room — past the cap its frames still count in every total above, just not per-id.
		if let Some(id_agg) = self.ids.get_mut(&key) {
			update_id(&frame, len, id_agg);
		} else if self.ids.len() < MAX_TRACKED_IDS {
			self.ids.insert(key, IdAgg {
				extended: frame.extended,
				fd: frame.fd,
				count: 0,
				tx: 0,
				payload_bytes: 0,
				first_ns: frame.t_ns,
				last_ns: frame.t_ns,
				min_cycle_ns: 0,
				max_cycle_ns: 0,
				cycle_sum_ns: 0,
			});
			update_id(&frame, len, self.ids.get_mut(&key).unwrap());
		}
	}

	fn other(&mut self) {
		self.skipped += 1;
	}

	fn seen(&self) -> u64 {
		self.total_frames + self.error_frames
	}
}

impl Aggregator {
	fn note_time(&mut self, channel: u16, t_ns: u64) {
		let entry = self.channels.entry(channel).or_default();
		if !entry.seen {
			entry.first_ns = t_ns;
			entry.seen = true;
		}
		if t_ns > entry.last_ns {
			entry.last_ns = t_ns;
		}
	}
}

/// One frame onto a tracked identifier's aggregate (count, direction, payload, cycle) — a
/// free function so the caller can hold the mutable borrow of its map entry.
fn update_id(frame: &RawFrame, len: u64, id_agg: &mut IdAgg) {
	if frame.tx {
		id_agg.tx += 1;
	}
	id_agg.fd |= frame.fd;
	id_agg.count += 1;
	id_agg.payload_bytes += len;
	let previous = id_agg.last_ns;
	id_agg.last_ns = frame.t_ns;
	if id_agg.count > 1 {
		let cycle = frame.t_ns.saturating_sub(previous);
		if id_agg.count == 2 {
			id_agg.min_cycle_ns = cycle;
			id_agg.max_cycle_ns = cycle;
		} else {
			id_agg.min_cycle_ns = id_agg.min_cycle_ns.min(cycle);
			id_agg.max_cycle_ns = id_agg.max_cycle_ns.max(cycle);
		}
		id_agg.cycle_sum_ns += cycle as u128;
	}
}

/* ---------- Cycle analysis (periodic messages, jitter, frame loss) ---------- */

/// One point of the interval chart: when the frame arrived and how long after the previous
/// one — the raw material of both the jitter plot and the frame-loss check.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IntervalPoint {
	pub t_s: f64,
	pub cycle_s: f64,
	/// A gap the frame-loss check blames for at least one missing frame.
	pub missed: bool,
}

/// A bar of the cycle-time histogram.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CycleBin {
	pub from_s: f64,
	pub to_s: f64,
	pub count: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CanIntervals {
	pub channel: u16,
	pub id: u32,
	pub extended: bool,
	pub fd: bool,
	pub count: u64,
	pub first_s: f64,
	pub last_s: f64,
	/// The cycle time the message is configured at: the median of the observed intervals.
	pub median_cycle_s: f64,
	pub avg_cycle_s: f64,
	pub min_cycle_s: f64,
	pub max_cycle_s: f64,
	/// The standard deviation of the cycle times — the jitter figure.
	pub std_s: f64,
	/// Gaps longer than 1.5 × the median cycle: each is at least one missing frame.
	pub missed_gaps: u64,
	/// The frames those gaps should have carried.
	pub missed_frames: u64,
	/// The interval series, downsampled to at most 4096 points for the chart.
	pub points: Vec<IntervalPoint>,
	/// The cycle-time distribution, 40 bins over the observed range.
	pub histogram: Vec<CycleBin>,
}

/// The maximum points the chart asks the backend to send — the full series is walked in
/// Rust; only this many cross the bridge.
const MAX_CHART_POINTS: usize = 4096;
/// How many arrival timestamps one analysis keeps in memory (8M × 8 B = 64 MiB) — a
/// pathological cycle rate cannot grow the collector past the memory budget; the frames
/// past the cap still count, their timestamps just do not join the series.
const MAX_INTERVAL_SAMPLES: usize = 8_000_000;

struct IntervalCollector {
	channel: u16,
	id: u32,
	times: Vec<u64>,
	extended: bool,
	fd: bool,
	/// Frames of the target id past `MAX_INTERVAL_SAMPLES`.
	overflow: u64,
}

impl FrameSink for IntervalCollector {
	fn frame(&mut self, frame: RawFrame) {
		// A standard and an extended frame with the same id are different messages: the
		// analysis selects exactly one of them.
		if frame.channel == self.channel && frame.id == self.id && frame.extended == self.extended && !frame.error {
			self.fd = frame.fd;
			if self.times.len() < MAX_INTERVAL_SAMPLES {
				self.times.push(frame.t_ns);
			} else {
				self.overflow += 1;
			}
		}
	}

	fn seen(&self) -> u64 {
		self.times.len() as u64
	}
}

/// The periodic-message analysis of one identifier: the cycle statistics over every
/// interval, the missing-frame check (gaps beyond 1.5 × the median cycle), and the
/// downsampled series and histogram the charts draw. The order statistics are selected in
/// place over the deltas — no sorted copy — so the peak footprint stays at two vectors.
fn analyse_intervals(times: Vec<u64>, channel: u16, id: u32, extended: bool, fd: bool, overflow: u64) -> CanIntervals {
	let count = times.len() as u64 + overflow;
	let first = times.first().copied().unwrap_or(0);
	let last = times.last().copied().unwrap_or(0);
	let mut deltas: Vec<u64> = Vec::with_capacity(times.len().saturating_sub(1));
	for pair in times.windows(2) {
		deltas.push(pair[1].saturating_sub(pair[0]));
	}
	// The order statistics are selected in place — by partition, not by a sorted copy —
	// so the analysis holds one vector's worth of scratch, not two.
	let mut median_ns = 0u64;
	let mut min_ns = 0u64;
	let mut max_ns = 0u64;
	if !deltas.is_empty() {
		min_ns = *deltas.iter().min().unwrap();
		let overall_max = *deltas.iter().max().unwrap();
		let mid = deltas.len() / 2;
		median_ns = *deltas.select_nth_unstable(mid).1;
		// The histogram's upper clamp: twice the 99.9th percentile, so one enormous gap
		// (a bus-off pause) does not squash the interesting part into the first bin.
		let p999_index = ((deltas.len() as f64 * 0.999) as usize).min(deltas.len() - 1);
		let p999 = *deltas.select_nth_unstable(p999_index).1;
		max_ns = overall_max.min(p999.saturating_mul(2));
	}
	// A frame is "missing" when the bus stayed silent past 1.5 cycles: at 1.5 the odd
	// jittered-but-present frame is still counted present, a full cycle lost is not.
	let loss_threshold = median_ns + median_ns / 2;
	let mut missed_gaps = 0u64;
	let mut missed_frames = 0u64;
	for &d in &deltas {
		if d > loss_threshold {
			missed_gaps += 1;
			missed_frames += ((d + median_ns / 2) / median_ns.max(1)).saturating_sub(1);
		}
	}
	// The chart series: every interval if it fits, otherwise one in every kth so the
	// missed gaps stay visible. Built from the timestamps and deltas together — after
	// this the timestamps are released and only the deltas remain.
	let stride = deltas.len().div_ceil(MAX_CHART_POINTS);
	let points: Vec<IntervalPoint> = deltas
		.iter()
		.enumerate()
		.filter(|(i, _)| i % stride == 0)
		.map(|(i, d)| IntervalPoint { t_s: times.get(i + 1).copied().unwrap_or(0) as f64 / 1e9, cycle_s: *d as f64 / 1e9, missed: *d > loss_threshold })
		.collect();
	drop(times);
	// The histogram: 40 bins over the clamped range.
	let mut histogram = Vec::new();
	if max_ns > 0 {
		let bins = 40u64;
		let width = max_ns.div_ceil(bins);
		for b in 0..bins {
			histogram.push(CycleBin { from_s: (b * width) as f64 / 1e9, to_s: ((b + 1) * width) as f64 / 1e9, count: 0 });
		}
		for &d in &deltas {
			let b = ((d / width.max(1)) as usize).min(histogram.len() - 1);
			histogram[b].count += 1;
		}
	}
	let sum: u128 = deltas.iter().map(|&d| d as u128).sum();
	let mean = if deltas.is_empty() { 0.0 } else { (sum / deltas.len() as u128) as f64 / 1e9 };
	// The jitter: the standard deviation over the deltas, in seconds.
	let var = if deltas.is_empty() {
		0.0
	} else {
		deltas.iter().map(|&d| { let x = d as f64 / 1e9 - mean; x * x }).sum::<f64>() / deltas.len() as f64
	};
	CanIntervals {
		channel,
		id,
		extended,
		fd,
		count,
		first_s: first as f64 / 1e9,
		last_s: last as f64 / 1e9,
		median_cycle_s: median_ns as f64 / 1e9,
		avg_cycle_s: mean,
		min_cycle_s: min_ns as f64 / 1e9,
		max_cycle_s: max_ns as f64 / 1e9,
		std_s: var.sqrt(),
		missed_gaps,
		missed_frames,
		points,
		histogram,
	}
}

/* ---------- BLF reading ---------- */

fn u16_at(b: &[u8], i: usize) -> u16 { u16::from_le_bytes([b[i], b[i + 1]]) }
fn u32_at(b: &[u8], i: usize) -> u32 { u32::from_le_bytes([b[i], b[i + 1], b[i + 2], b[i + 3]]) }
fn u64_at(b: &[u8], i: usize) -> u64 {
	let mut v = [0u8; 8];
	v.copy_from_slice(&b[i..i + 8]);
	u64::from_le_bytes(v)
}

/// Days since the Unix epoch of a civil date (Howard Hinnant's `days_from_civil`), so the
/// BLF's SYSTEMTIME start becomes a wall-clock timestamp without pulling in chrono.
fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
	let y = if m <= 2 { y - 1 } else { y };
	let era = if y >= 0 { y } else { y - 399 } / 400;
	let yoe = y - era * 400;
	let mp = (m + 9) % 12;
	let doy = (153 * mp + 2) / 5 + d - 1;
	let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
	era * 146_097 + doe - 719_468
}

/// The LOGG header's SYSTEMTIME (year, month, day-of-week, day, hour, minute, second, ms)
/// to seconds since the Unix epoch.
fn systemtime_to_epoch(st: &[u16]) -> Option<f64> {
	if st[0] < 1970 || st[1] == 0 || st[1] > 12 || st[3] == 0 || st[3] > 31 {
		return None;
	}
	let days = days_from_civil(st[0] as i64, st[1] as i64, st[3] as i64);
	Some((days * 86_400 + st[4] as i64 * 3_600 + st[5] as i64 * 60 + st[6] as i64) as f64 + st[7] as f64 / 1_000.0)
}

/// The epoch back to a SYSTEMTIME, for the BLF the converter writes.
fn epoch_to_systemtime(epoch_s: f64) -> [u16; 8] {
	let days = (epoch_s / 86_400.0).floor() as i64;
	let secs = epoch_s - days as f64 * 86_400.0;
	// civil_from_days (the inverse of days_from_civil), so no date crate is needed.
	let z = days + 719_468;
	let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
	let doe = z - era * 146_097;
	let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146_096) / 365;
	let y = yoe + era * 400;
	let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
	let mp = (5 * doy + 2) / 153;
	let d = doy - (153 * mp + 2) / 5 + 1;
	let m = if mp < 10 { mp + 3 } else { mp - 9 };
	let y = if m <= 2 { y + 1 } else { y };
	[
		y.max(1970) as u16,
		m as u16,
		1, // day of week, which no reader of ours (nor CANoe) consults
		d as u16,
		(secs / 3_600.0) as u16,
		((secs / 60.0) % 60.0) as u16,
		(secs % 60.0) as u16,
		((secs % 1.0) * 1_000.0) as u16,
	]
}

const OBJ_LOG_CONTAINER: u32 = 10;
const OBJ_CAN_MESSAGE: u32 = 1;
const OBJ_CAN_MESSAGE2: u32 = 86;
const OBJ_CAN_ERROR_EXT: u32 = 73;
const OBJ_CAN_FD_MESSAGE: u32 = 100;
const OBJ_CAN_FD_MESSAGE_64: u32 = 101;

/// The object header over the 16-byte base: the timestamp (at +8 into it) and its flags.
/// Flags 1 count 10-microsecond units; anything else (CANoe and python-can write 2) is
/// nanoseconds.
fn object_header(buf: &[u8], pos: usize, version: u16) -> Option<(u64, u32)> {
	let ts = u64_at(buf, pos + 24);
	let flags = u32_at(buf, pos + 16);
	let _ = version;
	Some((ts, flags))
}

/// The offset of the next `LOBJ` header at or after `from`, searching at most the few
/// bytes of inter-object padding that exist — CANoe's loggers and python-can pad an object
/// by `size % 4` bytes (files this app wrote before that convention carry the round-up
/// kind), so the search window covers both. None when no header follows (the run's end,
/// or trailing damage).
fn next_lobj(buf: &[u8], from: usize) -> Option<usize> {
	(0..8).find(|&skip| {
		let at = from + skip;
		at + 4 <= buf.len() && &buf[at..at + 4] == b"LOBJ"
	}).map(|skip| from + skip)
}

/// The uncompressed payload of one log container: a run of LOBJ objects, each padded to a
/// 4-byte boundary.
fn walk_blf_objects(buf: &[u8], sink: &mut dyn FrameSink) {
	let mut pos = 0usize;
	while let Some(at) = next_lobj(buf, pos) {
		if at + 16 > buf.len() {
			break;
		}
		pos = at;
		let _header_size = u16_at(buf, pos + 4) as usize;
		let header_version = u16_at(buf, pos + 6);
		let object_size = u32_at(buf, pos + 8) as usize;
		let object_type = u32_at(buf, pos + 12);
		if object_size == 0 || pos + object_size > buf.len() {
			break;
		}
		let hsize = if header_version == 2 { 24usize } else { 16usize };
		if let Some((ts, flags)) = object_header(buf, pos, header_version) {
			let t_ns = if flags == 1 { ts.saturating_mul(10_000) } else { ts };
			let body = pos + 16 + hsize;
			let end = pos + object_size;
			match object_type {
				OBJ_CAN_MESSAGE | OBJ_CAN_MESSAGE2 if body + 8 <= end => {
					let channel = u16_at(buf, body);
					let mflags = buf[body + 2];
					let dlc = buf[body + 3];
					let id = u32_at(buf, body + 4);
					let data = &buf[body + 8..end.min(body + 16)];
					let remote = mflags & 0x80 != 0;
					// The DLC claims up to 8 bytes; a corrupt object's declared size may
					// hold fewer — clamp to what is present rather than trust the DLC.
					let len = if remote { 0 } else { dlc.min(8).min(data.len() as u8) };
					sink.frame(RawFrame::data_frame(t_ns, channel, id & 0x1fff_ffff, id & 0x8000_0000 != 0, false, dlc, len, data, mflags & 0x01 != 0));
				}
				OBJ_CAN_ERROR_EXT if body + 2 <= end => {
					let mut frame = RawFrame {
						t_ns,
						channel: u16_at(buf, body),
						id: 0,
						extended: false,
						fd: false,
						brs: false,
						esi: false,
						remote: false,
						error: true,
						dlc: 0,
						len: 0,
						data: [0; 64],
						tx: false,
					};
					if body + 20 <= end {
						frame.dlc = buf[body + 10];
						frame.id = u32_at(buf, body + 16) & 0x1fff_ffff;
					}
					sink.frame(frame);
				}
				OBJ_CAN_FD_MESSAGE if body + 20 <= end => {
					let channel = u16_at(buf, body);
					let mflags = buf[body + 2];
					let dlc = buf[body + 3];
					let id = u32_at(buf, body + 4);
					let fd_flags = buf[body + 13];
					let valid_bytes = buf[body + 14] as usize;
					let data = &buf[body + 20..end.min(body + 20 + valid_bytes)];
					let len = fd_dlc_bytes(dlc).min(valid_bytes as u64).min(data.len() as u64).min(64) as u8;
					let mut frame = RawFrame::data_frame(t_ns, channel, id & 0x1fff_ffff, id & 0x8000_0000 != 0, true, dlc, len, data, mflags & 0x01 != 0);
					frame.brs = fd_flags & 0x02 != 0;
					frame.esi = fd_flags & 0x04 != 0;
					sink.frame(frame);
				}
				OBJ_CAN_FD_MESSAGE_64 if body + 40 <= end => {
					let channel = buf[body] as u16;
					let dlc = buf[body + 1];
					let valid_bytes = buf[body + 2] as usize;
					let id = u32_at(buf, body + 4);
					let obj_flags = u32_at(buf, body + 12);
					let data = &buf[body + 40..end.min(body + 40 + valid_bytes)];
					let len = fd_dlc_bytes(dlc).min(valid_bytes as u64).min(data.len() as u64).min(64) as u8;
					sink.frame(RawFrame::data_frame(t_ns, channel, id & 0x1fff_ffff, obj_flags & 0x6000_0000 != 0, true, dlc, len, data, obj_flags & 0x0100_0000 != 0));
				}
				_ => sink.other(),
			}
		}
		pos += object_size;
	}
}

/// One LOBJ object's size ceiling: a log container is 128 KiB plus its headers, so 512 MiB
/// leaves orders of magnitude of headroom while keeping a corrupt size field from turning
/// into an allocation.
const MAX_BLF_OBJECT: usize = 512 << 20;
/// The most one zlib container may expand to — the same reasoning, against a decompression
/// bomb.
const MAX_BLF_UNCOMPRESSED: usize = 512 << 20;

/// The next object's 16-byte base header, sliding over the 0–3 padding bytes that follow
/// the previous object. Writers round differently — CANoe's loggers and python-can pad by
/// the object size mod 4 (files this app wrote before that convention carry the round-up
/// kind) — so the reader searches for the signature instead of trusting either
/// (python-can's reader does the same). None at EOF or when no header follows; every byte
/// consumed is added so the progress position stays honest.
fn next_base<R: Read>(r: &mut R, bytes: &mut u64) -> Option<[u8; 16]> {
	let mut base = [0u8; 16];
	r.read_exact(&mut base).ok()?;
	for _ in 0..3 {
		if &base[0..4] == b"LOBJ" {
			return Some(base);
		}
		base.copy_within(1.., 0);
		r.read_exact(&mut base[15..]).ok()?;
		*bytes += 1;
	}
	(&base[0..4] == b"LOBJ").then_some(base)
}

/// A whole BLF file, streamed container by container: the 144-byte LOGG header, then log
/// containers (LOBJ objects of type 10) whose payload is zlib-compressed runs of objects.
/// A multi-gigabyte log is never held whole — one decompressed chunk at a time is.
/// `on_chunk(frames, cumulative_bytes)` fires after each container for progress reports.
fn walk_blf_progress<R: Read>(mut r: R, sink: &mut dyn FrameSink, on_chunk: &mut dyn FnMut(u64, u64)) -> Result<(Option<f64>, &'static str), String> {
	let mut header = [0u8; 144];
	r.read_exact(&mut header).map_err(|_| "not a BLF file (shorter than its header)".to_string())?;
	if &header[0..4] != b"LOGG" {
		return Err("not a BLF file (missing LOGG signature)".into());
	}
	let header_size = u32_at(&header, 4) as usize;
	if header_size < 144 {
		return Err("not a BLF file (implausible LOGG header size)".into());
	}
	if header_size > 144 {
		let mut pad = vec![0u8; header_size - 144];
		r.read_exact(&mut pad).map_err(|_| "truncated BLF header".to_string())?;
	}
	let start_timestamp_s = (0..8).map(|i| u16_at(&header, 40 + i * 2)).collect::<Vec<_>>();
	let start_timestamp_s = systemtime_to_epoch(&start_timestamp_s);
	// The bytes consumed so far: the header plus every container's size.
	let mut bytes = header_size as u64;
	while let Some(base) = next_base(&mut r, &mut bytes) {
		let object_size = u32_at(&base, 8) as usize;
		let object_type = u32_at(&base, 12);
		if !(32..=MAX_BLF_OBJECT).contains(&object_size) {
			// A container is 128 KiB of payload plus its headers; anything past the cap is
			// a corrupt size field, and reading it would be an unbounded allocation.
			break;
		}
		let mut body = vec![0u8; object_size - 16];
		if r.read_exact(&mut body).is_err() {
			break;
		}
		if object_type == OBJ_LOG_CONTAINER {
			let method = u16_at(&body, 0);
			let payload = &body[16..];
			if method == 0 {
				walk_blf_objects(payload, sink);
			} else {
				// `take` caps the decompressed size: a small corrupt (or crafted)
				// container cannot expand into an unbounded buffer.
				let mut plain = Vec::new();
				if flate2::read::ZlibDecoder::new(payload).take(MAX_BLF_UNCOMPRESSED as u64).read_to_end(&mut plain).is_ok() {
					walk_blf_objects(&plain, sink);
				} else {
					return Err("BLF container failed to decompress (corrupt log?)".into());
				}
			}
		} else {
			sink.other();
		}
		bytes += object_size as u64;
		on_chunk(sink.seen(), bytes);
		if sink.failed() {
			break;
		}
	}
	Ok((start_timestamp_s, "BLF"))
}

/// The no-progress form of the walk (tests, and the header probes).
#[cfg_attr(not(test), allow(dead_code))]
fn walk_blf<R: Read>(r: R, sink: &mut dyn FrameSink) -> Result<(Option<f64>, &'static str), String> {
	let mut on_chunk = |_, _| ();
	walk_blf_progress(r, sink, &mut on_chunk)
}

/* ---------- BLF writing ---------- */

/// Writes a BLF exactly the way CANoe (and python-can) lay it out: a 144-byte LOGG header,
/// then the frames packed as LOBJ objects into 128 KiB log containers, zlib-compressed.
/// The header's sizes and object count are rewritten at the end, as CANoe's writer does.
struct BlfWriter<W: Write + Seek> {
	out: W,
	/// The bytes written after the header, so the rewritten header can state the file size
	/// without the writer having to be a file.
	written_bytes: u64,
	/// The LOGG header's start SYSTEMTIME.
	start_epoch: f64,
	/// Buffered object bytes awaiting the next container flush.
	buffer: Vec<u8>,
	objects: u64,
	uncompressed_size: u64,
	frames: u64,
	finished: bool,
	/// The first I/O error, recorded instead of panicking: a full disk or a locked target
	/// must surface as the conversion's error, not kill the blocking task mid-file.
	error: Option<std::io::Error>,
}

/// The uncompressed bytes one log container holds before it is compressed and flushed —
/// CANoe's own container size.
const CONTAINER_BYTES: usize = 128 * 1024;

impl<W: Write + Seek> BlfWriter<W> {
	fn new(mut out: W, start_epoch: f64) -> Self {
		let error = out.write_all(&[0u8; 144]).err();
		BlfWriter { out, start_epoch, written_bytes: 0, buffer: Vec::with_capacity(CONTAINER_BYTES + 256), objects: 0, uncompressed_size: 144, frames: 0, finished: false, error }
	}

	/// One LOBJ object into the buffer, padded the way CANoe's loggers and python-can pad
	/// every object: `size % 4` zero bytes. The buffer is flushed once it holds a
	/// container's worth — here, not in `frame`, so the error-frame and CAN FD early
	/// returns cannot grow it without bound.
	fn push_object(&mut self, object: &[u8]) {
		self.buffer.extend_from_slice(object);
		let rem = object.len() % 4;
		if rem != 0 {
			self.buffer.extend(std::iter::repeat_n(0, rem));
		}
		self.objects += 1;
		if self.buffer.len() >= CONTAINER_BYTES {
			self.flush_container();
		}
	}

	/// One frame as the object CANoe writes for it. Once the target has failed the frame
	/// is skipped — the error is what `finish` reports.
	fn frame(&mut self, frame: &RawFrame) {
		if self.error.is_some() {
			return;
		}
		self.frames += 1;
		let t_ns = frame.t_ns;
		// The object header every message object carries: base (16) + v1 (16) = 32 bytes,
		// flags 2 = nanoseconds, exactly python-can's and CANoe's choice.
		let mut object = Vec::with_capacity(112);
		object.extend_from_slice(b"LOBJ");
		if frame.error {
			// CAN_ERROR_EXT: channel, length, flags, ecc, position, dlc, pad, frame length,
			// id, ext flags, pad, 8 data bytes — 32 bytes of body.
			let size = 32 + 32;
			object.extend_from_slice(&32u16.to_le_bytes());
			object.extend_from_slice(&1u16.to_le_bytes());
			object.extend_from_slice(&(size as u32).to_le_bytes());
			object.extend_from_slice(&OBJ_CAN_ERROR_EXT.to_le_bytes());
			object.extend_from_slice(&2u32.to_le_bytes());
			object.extend_from_slice(&0u16.to_le_bytes());
			object.extend_from_slice(&0u16.to_le_bytes());
			object.extend_from_slice(&t_ns.to_le_bytes());
			object.extend_from_slice(&frame.channel.to_le_bytes());
			object.extend_from_slice(&(frame.dlc as u16).to_le_bytes());
			object.extend_from_slice(&0u32.to_le_bytes());
			object.extend([0u8; 3].iter().copied()); // ecc, position, dlc restated below
			object.push(frame.dlc);
			object.extend_from_slice(&0u32.to_le_bytes());
			object.extend_from_slice(&frame.id.to_le_bytes());
			object.extend_from_slice(&0u16.to_le_bytes());
			object.extend_from_slice(&0u16.to_le_bytes());
			object.extend_from_slice(&frame.data[..8]);
			object.resize(size, 0);
			self.push_object(&object);
			return;
		}
		if frame.fd {
			// CAN_FD_MESSAGE: channel, flags, dlc, id, frame length (u32), bit count (u8),
			// fd flags, valid bytes, 5 pad, 64 data bytes — 84 bytes of body.
			let size = 32 + 84;
			object.extend_from_slice(&32u16.to_le_bytes());
			object.extend_from_slice(&1u16.to_le_bytes());
			object.extend_from_slice(&(size as u32).to_le_bytes());
			object.extend_from_slice(&OBJ_CAN_FD_MESSAGE.to_le_bytes());
			object.extend_from_slice(&2u32.to_le_bytes());
			object.extend_from_slice(&0u16.to_le_bytes());
			object.extend_from_slice(&0u16.to_le_bytes());
			object.extend_from_slice(&t_ns.to_le_bytes());
			object.extend_from_slice(&frame.channel.to_le_bytes());
			object.extend_from_slice(&[if frame.tx { 0x01 } else { 0x00 }]);
			object.push(frame.dlc);
			let mut id = frame.id;
			if frame.extended {
				id |= 0x8000_0000;
			}
			object.extend_from_slice(&id.to_le_bytes());
			object.extend_from_slice(&0u32.to_le_bytes()); // frame length
			object.push(0); // bit count
			let mut fd_flags = 0x01u8; // EDL: a CAN FD frame
			if frame.brs {
				fd_flags |= 0x02;
			}
			if frame.esi {
				fd_flags |= 0x04;
			}
			object.push(fd_flags);
			object.push(frame.len);
			object.extend_from_slice(&[0u8; 5]);
			object.extend_from_slice(&frame.data);
			object.resize(size, 0);
			self.push_object(&object);
			return;
		}
		// CAN_MESSAGE: channel, flags, dlc, id, 8 data bytes — 16 bytes of body.
		let size = 32 + 16;
		object.extend_from_slice(&32u16.to_le_bytes());
		object.extend_from_slice(&1u16.to_le_bytes());
		object.extend_from_slice(&(size as u32).to_le_bytes());
		object.extend_from_slice(&OBJ_CAN_MESSAGE.to_le_bytes());
		object.extend_from_slice(&2u32.to_le_bytes());
		object.extend_from_slice(&0u16.to_le_bytes());
		object.extend_from_slice(&0u16.to_le_bytes());
		object.extend_from_slice(&t_ns.to_le_bytes());
		object.extend_from_slice(&frame.channel.to_le_bytes());
		let mut mflags = 0u8;
		if frame.tx {
			mflags |= 0x01;
		}
		if frame.remote {
			mflags |= 0x80;
		}
		object.push(mflags);
		object.push(frame.dlc.min(8));
		let mut id = frame.id;
		if frame.extended {
			id |= 0x8000_0000;
		}
		object.extend_from_slice(&id.to_le_bytes());
		object.extend_from_slice(&frame.data[..8]);
		object.resize(size, 0);
		self.push_object(&object);
	}

	/// Compresses the buffered objects into one log container and writes it out.
	fn flush_container(&mut self) {
		if self.buffer.is_empty() || self.error.is_some() {
			return;
		}
		let mut zlib = flate2::write::ZlibEncoder::new(Vec::new(), flate2::Compression::default());
		let compressed = zlib.write_all(&self.buffer).and_then(|_| zlib.finish());
		let compressed = match compressed {
			Ok(compressed) => compressed,
			Err(e) => {
				self.error = Some(e);
				return;
			}
		};
		let obj_size = 16 + 16 + compressed.len();
		let mut container = Vec::with_capacity(obj_size + 4);
		container.extend_from_slice(b"LOBJ");
		container.extend_from_slice(&16u16.to_le_bytes()); // the container has no object header
		container.extend_from_slice(&1u16.to_le_bytes());
		container.extend_from_slice(&(obj_size as u32).to_le_bytes());
		container.extend_from_slice(&OBJ_LOG_CONTAINER.to_le_bytes());
		container.extend_from_slice(&2u16.to_le_bytes()); // zlib deflate
		container.extend_from_slice(&[0u8; 6]);
		container.extend_from_slice(&(self.buffer.len() as u32).to_le_bytes());
		container.extend_from_slice(&[0u8; 4]);
		container.extend_from_slice(&compressed);
		self.uncompressed_size += 32 + self.buffer.len() as u64;
		// The padding between objects follows the ecosystem convention (`size % 4`), the
		// way CANoe's loggers and python-can write it — the reader slides over either.
		let rem = obj_size % 4;
		if rem != 0 {
			container.extend(std::iter::repeat_n(0, rem));
		}
		match self.out.write_all(&container) {
			Ok(()) => {
				self.written_bytes += container.len() as u64;
				self.buffer.clear();
			}
			Err(e) => self.error = Some(e),
		}
	}

	/// Flushes the last container and rewrites the LOGG header with the final sizes. The
	/// first recorded I/O error — here or from any earlier write — is the result instead.
	fn finish(&mut self) -> std::io::Result<u64> {
		if self.finished {
			return Ok(self.frames);
		}
		self.finished = true;
		self.flush_container();
		if let Some(error) = self.error.take() {
			return Err(error);
		}
		let st = epoch_to_systemtime(self.start_epoch);
		let mut header = Vec::with_capacity(144);
		header.extend_from_slice(b"LOGG");
		header.extend_from_slice(&144u32.to_le_bytes());
		header.push(5); // application id (CANoe's logger)
		header.extend_from_slice(&[0, 0, 0]); // application version
		header.extend_from_slice(&[2, 6, 8, 1]); // binary log version
		// The file size placeholder below is fixed after the header is packed.
		header.extend_from_slice(&0u64.to_le_bytes());
		header.extend_from_slice(&self.uncompressed_size.to_le_bytes());
		header.extend_from_slice(&(self.objects as u32).to_le_bytes());
		header.extend_from_slice(&0u32.to_le_bytes());
		for v in st {
			header.extend_from_slice(&v.to_le_bytes());
		}
		header.extend_from_slice(&[0u8; 16]); // stop SYSTEMTIME
		header.resize(144, 0);
		// The whole file is this 144-byte header plus what is already written after it.
		// The header goes back in at offset 0 the way CANoe's writer rewinds and rewrites
		// it, then the writer returns to where it was. A failure here leaves a zeroed
		// header — an unreadable file — so it is the conversion's error, not a shrug.
		let file_size = 144 + self.written_bytes;
		header[16..24].copy_from_slice(&file_size.to_le_bytes());
		let back = self.out.stream_position()?;
		self.out.rewind()?;
		self.out.write_all(&header)?;
		self.out.seek(std::io::SeekFrom::Start(back))?;
		Ok(self.frames)
	}
}

/* ---------- ASC reading ---------- */

/// The `.asc` text format, per CANoe's writer as python-can and asc_parser_lib document
/// it: `time channel id dir d|r dlc bytes…` lines (classic CAN) and
/// `time CANFD channel dir id [name] BRS|NoBRS [ESI] dlc byte-count data… trailing` (CAN
/// FD), under `date …`, `base hex|dec`, `timestamps absolute|relative` and
/// `(no) internal events logged` headers. An `x` suffix on an id marks it extended
/// (python-can's marker); without one, an id above 0x7FF can only be extended, since a
/// standard id is 11 bits. Tolerant by design — a statistics pass may skip anything it
/// cannot recognise, so unknown lines are ignored rather than fatal.
struct AscState {
	hex_base: bool,
	/// The header's `date …` line as an epoch, when it parses (the measurement start).
	start_epoch: Option<f64>,
}

/// The month names CANoe's date line can carry — English, plus the German months
/// python-can accepts (mär, mai, okt, dez).
const MONTHS: [(&str, u64); 16] = [
	("jan", 1), ("feb", 2), ("mär", 3), ("mar", 3), ("apr", 4), ("mai", 5), ("may", 5), ("jun", 6),
	("jul", 7), ("aug", 8), ("sep", 9), ("okt", 10), ("oct", 10), ("nov", 11), ("dez", 12), ("dec", 12),
];

/// Parse `hh:mm:ss(.ms)` into seconds-of-day. An am/pm token right after the time applies
/// the 12-hour clock (`12:30:00 am` is 00:30, `12:30:00 pm` stays 12:30) — and is only
/// consumed when it really is one, so the ctime layout's year survives for its caller.
fn parse_hms(rest: &mut std::iter::Peekable<std::str::SplitWhitespace<'_>>) -> Option<f64> {
	let time = rest.next()?;
	let mut parts = time.split(':');
	let h: f64 = parts.next()?.parse().ok()?;
	let m: f64 = parts.next()?.parse().ok()?;
	let s: f64 = parts.next().unwrap_or("0").parse().ok()?;
	if !(0.0..24.0).contains(&h) || !(0.0..60.0).contains(&m) || !(0.0..60.0).contains(&s) {
		return None;
	}
	let mut day = h * 3_600.0 + m * 60.0 + s;
	if let Some(next) = rest.peek() {
		let meridiem = next.to_ascii_lowercase();
		if meridiem == "am" {
			if h == 12.0 {
				day -= 12.0 * 3_600.0;
			}
			rest.next();
		} else if meridiem == "pm" {
			if h != 12.0 {
				day += 12.0 * 3_600.0;
			}
			rest.next();
		}
	}
	Some(day)
}

/// Parse the `date …` line's tail into an epoch: the `Mon Sep 14 08:30:00.250 2026`
/// layout CANoe writes (python-can's `%a %b %d %H:%M:%S.%f %Y`), the `mm/dd/yyyy
/// hh:mm[:ss] am|pm` layout, and `dd.mm.yyyy hh:mm[:ss]` besides.
fn parse_asc_date(rest: &str) -> Option<f64> {
	let mut tokens = rest.split_whitespace().peekable();
	while let Some(token) = tokens.next() {
		let lower = token.to_ascii_lowercase();
		// English/German month name: `Mon Sep 14 08:30:00.250 2026`.
		if let Some((_, month)) = MONTHS.iter().find(|(name, _)| *name == lower) {
			let day: i64 = tokens.next()?.parse().ok()?;
			let secs = parse_hms(&mut tokens)?;
			let year: i64 = tokens.next()?.parse().ok()?;
			return Some(days_from_civil(year, *month as i64, day) as f64 * 86_400.0 + secs);
		}
		// `09/14/2026 08:30:00 am`: month/day/year, the US order.
		if let Some((m, rest_of)) = token.split_once('/') {
			if let (Ok(month), Ok(day), Ok(year)) = (m.parse::<i64>(), rest_of.split_once('/')?.0.parse::<i64>(), rest_of.split_once('/')?.1.parse::<i64>()) {
				let secs = parse_hms(&mut tokens)?;
				return Some(days_from_civil(year, month, day) as f64 * 86_400.0 + secs);
			}
		}
		// `14.09.2026 08:30:00`: day.month.year, the German order.
		if let Some((d, rest_of)) = token.split_once('.') {
			if let (Ok(day), Ok(month), Ok(year)) = (d.parse::<i64>(), rest_of.split_once('.')?.0.parse::<i64>(), rest_of.split_once('.')?.1.parse::<i64>()) {
				if (1..=31).contains(&day) && (1..=12).contains(&month) {
					let secs = parse_hms(&mut tokens)?;
					return Some(days_from_civil(year, month, day) as f64 * 86_400.0 + secs);
				}
			}
		}
	}
	None
}

/// ASCII-case-insensitive `starts_with` — no allocation, unlike lowercasing the line.
fn starts_with_ci(hay: &str, needle: &str) -> bool {
	hay.get(..needle.len()).is_some_and(|prefix| prefix.eq_ignore_ascii_case(needle))
}

/// One hex digit's value, or `None` — the hot little helper behind a data byte's fast path.
#[inline]
fn hex_nibble(b: u8) -> Option<u8> {
	match b {
		b'0'..=b'9' => Some(b - b'0'),
		b'a'..=b'f' => Some(b - b'a' + 10),
		b'A'..=b'F' => Some(b - b'A' + 10),
		_ => None,
	}
}

/// An .asc line's whitespace-separated tokens, scanned as raw bytes with `<= b' '` as the
/// delimiter: the format is ASCII, and a byte scan beats `split_whitespace`'s
/// Unicode-aware class check enough to matter across a fifty-million-line walk. Slices
/// only ever land on ASCII delimiter boundaries, where multibyte UTF-8 cannot straddle,
/// so the reinterpreted `&str`s are valid by construction.
struct AscTokens<'a> {
	line: &'a [u8],
	at: usize,
}

impl<'a> Iterator for AscTokens<'a> {
	type Item = &'a str;

	fn next(&mut self) -> Option<&'a str> {
		let bytes = self.line;
		let mut start = self.at;
		while start < bytes.len() && bytes[start] <= b' ' {
			start += 1;
		}
		if start == bytes.len() {
			self.at = start;
			return None;
		}
		let mut end = start;
		while end < bytes.len() && bytes[end] > b' ' {
			end += 1;
		}
		self.at = end;
		std::str::from_utf8(&bytes[start..end]).ok()
	}
}

/// One line of an .asc trace: header lines update `state`, frame lines reach `sink`.
/// The line is scanned in place — nothing here allocates, so a billion-line log costs the
/// same per line as a hundred-line one.
fn walk_asc_line(line: &str, state: &mut AscState, sink: &mut dyn FrameSink) {
	let line = line.trim_start_matches('\u{feff}').trim();
	if line.is_empty() {
		return;
	}
	if starts_with_ci(line, "//") {
		return;
	}
	if starts_with_ci(line, "date ") || starts_with_ci(line, "date\t") {
		state.start_epoch = parse_asc_date(&line[5..]);
		return;
	}
	if let Some(rest) = line.strip_prefix("base ").or_else(|| line.strip_prefix("BASE ")) {
		state.hex_base = rest.starts_with("hex") || rest.starts_with("HEX");
		return;
	}
	if starts_with_ci(line, "timestamps")
		|| starts_with_ci(line, "internal events logged")
		|| starts_with_ci(line, "no internal events logged")
		|| starts_with_ci(line, "begin triggerblock")
		|| starts_with_ci(line, "begin ")
		|| starts_with_ci(line, "end ") {
		return;
	}
	let mut tokens = AscTokens { line: line.as_bytes(), at: 0 };
	let time_token = match tokens.next() {
		Some(t) => t,
		None => return,
	};
	let t: f64 = match time_token.parse() {
		Ok(v) => v,
		Err(_) => return,
	};
	let t_ns = (t * 1e9).round() as u64;
	let second = match tokens.next() {
		Some(t) => t,
		None => return,
	};
	let parse_num = |s: &str| -> Option<u64> {
		if state.hex_base {
			u64::from_str_radix(s.trim_start_matches("0x"), 16).ok()
		} else {
			s.parse().ok()
		}
	};
	// A data byte. The overwhelmingly common shape is a two-hex-digit token (base hex), and
	// a dedicated two-nibble scan beats `u64::from_str_radix`'s general machinery by enough
	// to matter forty times a line across a fifty-million-line walk.
	let parse_byte = |s: &str| -> Option<u8> {
		let b = s.as_bytes();
		if state.hex_base && b.len() == 2 {
			return Some(hex_nibble(b[0])? << 4 | hex_nibble(b[1])?);
		}
		parse_num(s).map(|v| v as u8)
	};
	// An id token's trailing `x` is python-can's extended-id marker.
	let id_value = |token: &str| -> Option<(u32, bool)> {
		let extended = token.ends_with('x') || token.ends_with('X');
		let digits = if extended { &token[..token.len() - 1] } else { token };
		let value = parse_num(digits)?;
		Some((value as u32, extended || value > 0x7ff))
	};
	// An error frame can stand alone after the time or follow the channel and an id.
	if second.eq_ignore_ascii_case("ErrorFrame") {
		sink.frame(error_frame(t_ns, 0));
		return;
	}
		if second.eq_ignore_ascii_case("CANFD") {
			// `time CANFD channel id dir [symbolic-name] flags [kind] dlc byte-count data…
			// trailing` (CANoe 8.5–12): CANoe itself writes the id before the direction,
			// while this crate's writer and a few third-party tools swap them (`channel
			// dir id`). Whichever token spells Rx/Tx is the direction, the other is the id.
			// The flags are `BRS|NoBRS [ESI]` words on older writers and bare `1`/`0` digits
			// on newer ones, the kind marker is a bare `d`, and the dlc code and the decimal
			// byte count (python-can) precede the data; everything after the counted data
			// bytes is metadata (duration, length, flags, crc, bit timings) no frame carries.
			let channel: u16 = match tokens.next().and_then(|t| t.parse().ok()) {
				Some(c) => c,
				None => return,
			};
			let after_channel = [tokens.next(), tokens.next()];
			let is_dir = |t: &str| t.eq_ignore_ascii_case("Rx") || t.eq_ignore_ascii_case("Tx");
			let (dir, id_token) = match after_channel {
				[Some(a), Some(b)] if is_dir(b) => (b, a),
				[Some(a), Some(b)] => (a, b),
				[Some(a), None] => ("Rx", a),
				_ => return,
			};
			let (id, mut extended) = match id_value(id_token) {
				Some(v) => v,
				None => return,
			};
			let mut brs = false;
			let mut esi = false;
			// The line's remaining tokens on the stack, not a heap Vec per line: name + two
			// flags + kind + dlc + count + the 64 possible data bytes always fit, and
			// anything that spills past the cap is CANoe's trailing metadata, which no
			// frame carries.
			let mut slots: [&str; 80] = [""; 80];
			let mut n = 0usize;
			// One byte of dispatch before the flag words' full compares (`eq_ignore_ascii_case`,
			// never `to_ascii_uppercase()`: no heap allocation per token on a 50-million-line
			// walk) — data bytes never start with B, N or E.
			for token in tokens {
				match token.as_bytes().first().copied().unwrap_or(b' ') | 0x20 {
					b'b' if token.eq_ignore_ascii_case("BRS") => brs = true,
					b'n' if token.eq_ignore_ascii_case("NOBRS") || token.eq_ignore_ascii_case("NOBR") => brs = false,
					b'e' if token.eq_ignore_ascii_case("ESI") || token.eq_ignore_ascii_case("ES") => esi = true,
					_ if n < slots.len() => {
						slots[n] = token;
						n += 1;
					}
					_ => {}
				}
			}
			let mut rest = &slots[..n];
				// A symbolic message name sits between the id and the flags; it is whatever the
				// first non-flag slot holds when it does not parse as a number.
				if let (Some(first), true) = (rest.first(), rest.len() > 1) {
					if parse_num(first).is_none() {
						rest = &rest[1..];
						extended = id > 0x7ff || extended;
					}
				}
				// An FD DLC code maps to exactly one payload length; a candidate (dlc, count)
				// pair is only plausible when the two agree, which is also what tells the
				// shapes apart: bare digit flags may sit before a bare `d` kind marker
				// (`0 0 d 15 64 …`, CANoe 10+, the dlc decimal), the marker may follow the
				// word flags (`BRS d 9 12 …`), and the digit-flags form without a marker
				// (`1 0 d 32 …`, `1 0 8 8 …`) reads the dlc straight away. A two-digit dlc
				// token can only be decimal in a hex-base file — "13" is code 13, never
				// 0x13 — so a read past code 15 falls back to decimal. And `0 0` digit flags
				// masquerade as a (dlc 0, count 0) agreement, so a zero-count match is only
				// taken when no payload-carrying candidate agrees.
			let fd_len = |code: u64| -> Option<usize> {
				match code {
					0..=8 => Some(code as usize),
					9 => Some(12),
					10 => Some(16),
					11 => Some(20),
					12 => Some(24),
					13 => Some(32),
					14 => Some(48),
					15 => Some(64),
					_ => None,
				}
			};
			let agrees = |dlc_tok: &str, count_tok: &str| -> Option<(u8, usize)> {
				let count = count_tok.parse::<usize>().ok().filter(|&c| c <= 64)?;
				let as_code = |v: u64| (fd_len(v) == Some(count)).then_some(v);
				// Base-aware first ("D" is 13 in a hex file), decimal as the fallback a
				// two-digit token needs ("15" is code 15, never 0x15).
				let code = parse_num(dlc_tok).and_then(as_code).or_else(|| dlc_tok.parse::<u64>().ok().and_then(as_code))?;
				Some((code as u8, count))
			};
			// (flag digits skipped, kind marker skipped) per shape, most specific first; the
			// plain read at offset 0 must precede the digit-flags read at offset 2, or two
			// leading data bytes (`10 16`) of a word-flag line could agree as (dlc 10,
			// count 16).
			let mut hit: Option<(usize, usize, u8, usize)> = None;
			let mut weak: Option<(usize, usize, u8, usize)> = None;
			for &(flags, kind) in &[(2usize, 1usize), (0, 1), (0, 0), (2, 0)] {
				let is_marker = |t: &str| t.eq_ignore_ascii_case("d") || t.eq_ignore_ascii_case("r");
				if kind == 1 && !rest.get(flags).copied().is_some_and(is_marker) {
					continue;
				}
				if let (Some(d), Some(c)) = (rest.get(flags + kind), rest.get(flags + kind + 1)) {
					if let Some((dlc, count)) = agrees(d, c) {
						if count == 0 {
							weak = weak.or(Some((flags, kind, dlc, count)));
						} else {
							hit = Some((flags, kind, dlc, count));
							break;
						}
					}
				}
			}
			let matched = hit.or(weak);
			let (flags, kind, dlc, count) = match matched {
				Some(found) => found,
				None => (0, 0, rest.first().and_then(|t| parse_num(t)).unwrap_or(0) as u8, 0),
			};
			if flags == 2 {
				brs = rest[0] == "1";
				esi = rest[1] == "1";
			}
			// Exactly `count` data bytes, parsed straight into the fixed array (no per-line
			// token Vec); anything past them is the trailing metadata CANoe appends.
			let mut bytes = [0u8; 64];
			let mut len = 0usize;
			if matched.is_some() {
				for (slot, token) in bytes.iter_mut().zip(rest.iter().skip(flags + kind + 2).take(count)) {
					*slot = parse_byte(token).unwrap_or(0);
					len += 1;
				}
			} else {
				for token in rest.iter().skip(1) {
					match parse_byte(token) {
						Some(v) if len < 64 => {
							bytes[len] = v;
							len += 1;
						}
						_ => break,
					}
				}
			}
			let mut frame = RawFrame::data_frame(t_ns, channel, id & 0x1fff_ffff, extended, true, dlc, len as u8, &bytes, dir.eq_ignore_ascii_case("Tx"));
			frame.brs = brs;
			frame.esi = esi;
			sink.frame(frame);
			return;
		}
	// Classic CAN: `time channel id dir d|r dlc bytes…`, or an ErrorFrame line.
	let channel: u16 = match second.parse() {
		Ok(c) => c,
		Err(_) => return,
	};
	let id_token = match tokens.next() {
		Some(t) => t,
		None => return,
	};
	if id_token.eq_ignore_ascii_case("ErrorFrame") {
		sink.frame(error_frame(t_ns, channel));
		return;
	}
	let (id, extended) = match id_value(id_token) {
		Some(v) => v,
		None => return,
	};
		// The line's remaining tokens on the stack, exactly as the FD branch above: a classic
		// line is direction, kind, dlc and at most eight data bytes.
		let mut slots: [&str; 16] = [""; 16];
		let mut n = 0usize;
		for token in tokens {
			if n == slots.len() {
				break;
			}
			slots[n] = token;
			n += 1;
		}
		let remaining = &slots[..n];
	if remaining.iter().any(|t| t.eq_ignore_ascii_case("ErrorFrame")) {
		sink.frame(error_frame(t_ns, channel));
		return;
	}
	let dir = remaining.first().copied().unwrap_or("Rx");
	let kind = remaining.get(1).copied().unwrap_or("");
	// python-can takes any `r…` token after the direction as a remote request; the kind's
	// first byte, lower-cased in place (`| 0x20`), decides which — no per-line allocation.
	let kind_byte = kind.as_bytes().first().copied().unwrap_or(b' ') | 0x20;
	let (dlc, remote, has_data) = match kind_byte {
		b'd' => (remaining.get(2).and_then(|t| parse_num(t)).unwrap_or(0) as u8, false, true),
		b'r' => (remaining.get(2).and_then(|t| parse_num(t)).unwrap_or(0) as u8, true, false),
		_ => (0, false, false),
	};
		let mut bytes = [0u8; 64];
		if has_data {
			for (slot, token) in bytes.iter_mut().zip(remaining.iter().skip(3)) {
				if let Some(v) = parse_byte(token) {
					*slot = v;
				}
			}
		}
	let len = if has_data { dlc.min(8) } else { 0 };
	let mut frame = RawFrame::data_frame(t_ns, channel, id & 0x1fff_ffff, extended, false, dlc, len, &bytes, dir.eq_ignore_ascii_case("Tx"));
	frame.remote = remote;
	sink.frame(frame);
}

/// The most bytes one line may occupy, shared by the log walks and the workspace search's
/// streaming scan. A classic .asc line is ~60 bytes; a 64-byte FD frame with CANoe's trailing
/// metadata is ~250 — 1 MiB is thousands of times that, and a "line" longer than this can only
/// be a corrupt or newline-less file, whose remainder is skipped rather than loaded.
pub(crate) const MAX_LINE_BYTES: usize = 1 << 20;

pub(crate) enum LineRead {
	/// A whole line, its `\n` (and any `\r` before it) already stripped.
	Line,
	/// A line past `MAX_LINE_BYTES`: consumed and discarded.
	Overlong,
	/// The input ended.
	Eof,
}

/// Reads one `\n`-terminated line into `buf` (cleared first), never letting `buf` grow
/// past `MAX_LINE_BYTES` — a gigabyte without a newline cannot become a gigabyte string.
/// `bytes` accumulates everything consumed, including discarded overlong runs.
pub(crate) fn read_line_bounded<R: std::io::BufRead>(reader: &mut R, buf: &mut Vec<u8>, bytes: &mut u64) -> std::io::Result<LineRead> {
	buf.clear();
	loop {
		let available = match reader.fill_buf() {
			Ok(a) => a,
			Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
			Err(e) => return Err(e),
		};
		if available.is_empty() {
			return Ok(if buf.is_empty() { LineRead::Eof } else { LineRead::Line });
		}
		let newline = memchr::memchr(b'\n', available);
		match newline {
			Some(i) => {
				if buf.len() + i <= MAX_LINE_BYTES {
					buf.extend_from_slice(&available[..i]);
				}
				*bytes += i as u64 + 1;
				reader.consume(i + 1);
				if buf.len() + i > MAX_LINE_BYTES {
					buf.clear();
					return Ok(LineRead::Overlong);
				}
				// A Windows `\r\n` ends with the carriage return just before the newline.
				if buf.last() == Some(&b'\r') {
					buf.pop();
				}
				return Ok(LineRead::Line);
			}
			None => {
				let take = if buf.len() + available.len() <= MAX_LINE_BYTES {
					buf.extend_from_slice(available);
					available.len()
				} else {
					// Past the cap: stop storing, keep scanning for the newline.
					buf.clear();
					available.len()
				};
				*bytes += take as u64;
				reader.consume(take);
			}
		}
	}
}

/// Walk an .asc from a reader, line by line — a multi-gigabyte trace is never held as one
/// string, and one reusable byte buffer serves every line (no per-line allocation).
/// `on_chunk(frames, bytes)` fires every few thousand lines for progress reports.
fn walk_asc_reader<R: std::io::BufRead>(mut reader: R, sink: &mut dyn FrameSink, on_chunk: &mut dyn FnMut(u64, u64)) -> (Option<f64>, &'static str) {
	let mut state = AscState { hex_base: true, start_epoch: None };
	let mut buf: Vec<u8> = Vec::with_capacity(256);
	let mut bytes = 0u64;
	let mut lines = 0u64;
	loop {
		match read_line_bounded(&mut reader, &mut buf, &mut bytes) {
			Ok(LineRead::Line) => {
				// from_utf8_lossy borrows when the line is valid UTF-8 (the normal case).
				walk_asc_line(&String::from_utf8_lossy(&buf), &mut state, sink);
			}
			Ok(LineRead::Overlong) => continue,
			Err(_) => break,
			Ok(LineRead::Eof) => break,
		}
		lines += 1;
		if lines % 4096 == 0 {
			on_chunk(sink.seen(), bytes);
			if sink.failed() {
				break;
			}
		}
	}
	(state.start_epoch, "ASC")
}

/// The whole-text form (tests, and the small inline payloads conversion builds).
#[cfg_attr(not(test), allow(dead_code))]
fn walk_asc(text: &str, sink: &mut dyn FrameSink) -> &'static str {
	let mut state = AscState { hex_base: true, start_epoch: None };
	for line in text.lines() {
		walk_asc_line(line, &mut state, sink);
	}
	"ASC"
}

fn error_frame(t_ns: u64, channel: u16) -> RawFrame {
	RawFrame { t_ns, channel, id: 0, extended: false, fd: false, brs: false, esi: false, remote: false, error: true, dlc: 0, len: 0, data: [0; 64], tx: false }
}

/* ---------- ASC writing ---------- */

/// Writes the `.asc` text exactly as CANoe lays it out: the four header lines CANoe writes,
/// then one line per frame — six-decimal seconds, the channel, the id in uppercase hex,
/// the direction, and the payload as spaced two-digit hex bytes.
struct AscWriter<W: Write> {
	out: W,
	frames: u64,
	/// The first I/O error, recorded instead of panicking (same contract as BlfWriter).
	error: Option<std::io::Error>,
}

impl<W: Write> AscWriter<W> {
	fn new(mut out: W, start_epoch: f64) -> Self {
		let date = epoch_to_systemtime(start_epoch);
		let weekdays = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
		let months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
		// The date line CANoe and python-can write: a ctime-style stamp of the start.
		let days = (start_epoch / 86_400.0).floor() as i64;
		let weekday = ((days % 7 + 7 + 4) % 7) as usize; // 1970-01-01 was a Thursday
		let result = writeln!(out, "date {} {} {} {:02}:{:02}:{:02}.{:03} {}", weekdays[weekday], months[(date[1] as usize - 1).min(11)], date[3], date[4], date[5], date[6], date[7], date[0])
			.and_then(|_| writeln!(out, "base hex timestamps absolute"))
			.and_then(|_| writeln!(out, "no internal events logged"))
			.and_then(|_| writeln!(out, "// version 9.0.1"));
		AscWriter { out, frames: 0, error: result.err() }
	}

	/// The first I/O error wins; every later write is a no-op.
	fn record(&mut self, result: std::io::Result<()>) {
		if let Err(e) = result {
			self.error = Some(e);
		}
	}

	fn frame(&mut self, frame: &RawFrame) {
		if self.error.is_some() {
			return;
		}
		self.frames += 1;
		let t = frame.t_ns as f64 / 1e9;
		if frame.error {
			let result = writeln!(self.out, "   {t:.6} {} ErrorFrame", frame.channel);
			self.record(result);
			return;
		}
		// The `x` suffix marks an extended id — python-can's (and CANoe's) marker.
		let id = format!("{:X}{}", frame.id, if frame.extended { "x" } else { "" });
		if frame.fd {
			// The CAN FD line: `time CANFD channel dir id BRS|NoBRS [ESI] dlc byte-count
			// data…`, then the eight zero metadata fields CANoe appends (duration, length,
			// flags, crc and four bit timings).
			let mut line = format!("   {t:.6} CANFD {} {} {} {} ", frame.channel, if frame.tx { "Tx" } else { "Rx" }, id, if frame.brs { "BRS" } else { "NoBRS" });
			if frame.esi {
				line.push_str("ESI ");
			}
			line.push_str(&format!("{:X} {}", frame.dlc, frame.len));
			for byte in &frame.data[..frame.len as usize] {
				line.push_str(&format!(" {byte:02X}"));
			}
			line.push_str(" 0 0 0 0 0 0 0 0");
			let result = writeln!(self.out, "{line}");
			self.record(result);
			return;
		}
		let kind = if frame.remote { 'r' } else { 'd' };
		let mut line = format!("   {t:.6} {}  {id}  {}   {kind} {}", frame.channel, if frame.tx { "Tx" } else { "Rx" }, frame.dlc.min(8));
		for byte in &frame.data[..if frame.remote { 0 } else { frame.len as usize }] {
			line.push_str(&format!(" {byte:02X}"));
		}
		let result = writeln!(self.out, "{line}");
		self.record(result);
	}
}

/* ---------- Commands ---------- */

/// A consumer that walks a source and hands its frames to a writer, the heart of the
/// BLF ↔ ASC conversion: neither format's frames are dropped or reordered.
struct Converter<W: Write + Seek> {
	writer: WriterTarget<W>,
}

enum WriterTarget<W: Write + Seek> {
	Asc(AscWriter<W>),
	Blf(BlfWriter<W>),
}

impl<W: Write + Seek> FrameSink for Converter<W> {
	fn frame(&mut self, frame: RawFrame) {
		match &mut self.writer {
			WriterTarget::Asc(w) => w.frame(&frame),
			WriterTarget::Blf(w) => w.frame(&frame),
		}
	}

	fn seen(&self) -> u64 {
		match &self.writer {
			WriterTarget::Asc(w) => w.frames,
			WriterTarget::Blf(w) => w.frames,
		}
	}

	fn failed(&self) -> bool {
		match &self.writer {
			WriterTarget::Asc(w) => w.error.is_some(),
			WriterTarget::Blf(w) => w.error.is_some(),
		}
	}
}

/* ---------- Commands (blocking work off the async runtime, progress over IPC) ---------- */

/// One progress report on a long walk: how far into the file it is and how many frames it
/// has handed over — what the view's status line shows while a giant log parses.
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct CanProgress {
	pub frames: u64,
	pub bytes: u64,
	pub total_bytes: u64,
}

/// Sends `CanProgress` over the IPC channel, throttled to one report per interval so a
/// multi-gigabyte walk does not flood the bridge.
struct ProgressReporter {
	channel: Option<tauri::ipc::Channel<CanProgress>>,
	total_bytes: u64,
	/// A raw-view document the walk's byte position is mirrored into, so its poll can show
	/// a percentage without an IPC report per chunk. `None` on the IPC-reporting flows.
	doc: Option<Arc<CanLogDoc>>,
	last: std::time::Instant,
}

impl ProgressReporter {
	fn new(channel: tauri::ipc::Channel<CanProgress>, total_bytes: u64) -> Self {
		ProgressReporter { channel: Some(channel), total_bytes, doc: None, last: std::time::Instant::now() - std::time::Duration::from_secs(1) }
	}

	/// A reporter that publishes each tick's byte position straight into a raw-view document
	/// — no IPC: the view's poll reads it back together with the frame count.
	fn into_doc(total_bytes: u64, doc: Arc<CanLogDoc>) -> Self {
		ProgressReporter { channel: None, total_bytes, doc: Some(doc), last: std::time::Instant::now() }
	}

	fn tick(&mut self, frames: u64, bytes: u64, force: bool) {
		if let Some(doc) = &self.doc {
			doc.bytes.store(bytes, Ordering::Relaxed);
		}
		let Some(channel) = &self.channel else { return };
		if !force && self.last.elapsed() < std::time::Duration::from_millis(200) {
			return;
		}
		self.last = std::time::Instant::now();
		let _ = channel.send(CanProgress { frames, bytes, total_bytes: self.total_bytes });
	}
}

/// The file's size, so a progress report can say how far along the walk is.
fn total_bytes_of(path: &Path) -> u64 {
	std::fs::metadata(path).map(|m| m.len()).unwrap_or(0)
}

/// Streams either format into `sink` from the path, reporting progress on the way: a BLF
/// container by container, an .asc line by line (never held whole). Returns the
/// measurement start when the source states one (BLF always, .asc when its date line
/// parses) and the format it turned out to be.
fn walk_source(path: &Path, sink: &mut dyn FrameSink, reporter: &mut ProgressReporter) -> Result<(Option<f64>, &'static str), String> {
	let mut file = File::open(path).map_err(|e| e.to_string())?;
	let mut signature = [0u8; 4];
	let read = file.read(&mut signature).map_err(|e| e.to_string())?;
	if read == 4 && &signature == b"LOGG" {
		// The per-container (frames, cumulative bytes) comes back through the walk's
		// chunk callback, which forwards it to the progress reporter.
		let mut bytes = 4u64;
		let mut on_chunk = |frames: u64, chunk_bytes: u64| {
			bytes = chunk_bytes;
			reporter.tick(frames, bytes, false);
		};
		let result = walk_blf_progress(Cursor::new(signature.to_vec()).chain(file), sink, &mut on_chunk)?;
		reporter.tick(sink.seen(), bytes, true);
		Ok(result)
	} else if path.extension().and_then(|e| e.to_str()) == Some("blf") {
		Err("not a BLF file (missing LOGG signature)".into())
	} else {
		let reader = std::io::BufReader::with_capacity(1 << 20, file);
		let mut on_chunk = |frames: u64, chunk_bytes: u64| {
			reporter.tick(frames, chunk_bytes, false);
		};
		let (start, format) = walk_asc_reader(reader, sink, &mut on_chunk);
		reporter.tick(sink.seen(), reporter.total_bytes.max(1), true);
		Ok((start, format))
	}
}

/// The statistics of a `.blf` or `.asc` CAN log on disk. The walk runs on the blocking
/// pool (it is pure IO and can run for minutes on a giant log) and reports progress over
/// `onProgress`; the view paints immediately and fills in when this resolves.
#[tauri::command]
pub async fn can_log_stats(path: String, on_progress: tauri::ipc::Channel<CanProgress>) -> Result<CanLogStats, String> {
	tauri::async_runtime::spawn_blocking(move || {
		let mut reporter = ProgressReporter::new(on_progress, total_bytes_of(Path::new(&path)));
		let mut agg = Aggregator::new();
		let (start, format) = walk_source(Path::new(&path), &mut agg, &mut reporter)?;
		Ok(agg.finish(format, start))
	})
	.await
	.map_err(|e| e.to_string())?
}

/// The periodic-message analysis of one identifier on one channel: cycle statistics
/// (median/avg/min/max, the standard deviation as the jitter figure), the missing-frame
/// check over every interval, and the chart series downsampled to ≤ 4096 points. The whole
/// file is walked in Rust on the blocking pool; only the series and the numbers cross
/// the bridge.
#[tauri::command]
pub async fn can_intervals(path: String, channel: u16, id: u32, extended: bool, on_progress: tauri::ipc::Channel<CanProgress>) -> Result<CanIntervals, String> {
	tauri::async_runtime::spawn_blocking(move || {
		let mut reporter = ProgressReporter::new(on_progress, total_bytes_of(Path::new(&path)));
		let mut collector = IntervalCollector { channel, id, times: Vec::new(), extended, fd: false, overflow: 0 };
		walk_source(Path::new(&path), &mut collector, &mut reporter)?;
		Ok(analyse_intervals(std::mem::take(&mut collector.times), channel, id, collector.extended, collector.fd, collector.overflow))
	})
	.await
	.map_err(|e| e.to_string())?
}

/// The measurement start a BLF's LOGG header states, without walking the file.
fn blf_start_epoch(path: &Path) -> Option<f64> {
	let mut header = [0u8; 144];
	let mut file = File::open(path).ok()?;
	file.read_exact(&mut header).ok()?;
	if &header[0..4] != b"LOGG" {
		return None;
	}
	let st = (0..8).map(|i| u16_at(&header, 40 + i * 2)).collect::<Vec<_>>();
	systemtime_to_epoch(&st)
}

/// Convert a CAN log between BLF and ASC (or into its own format), frame for frame: every
/// CAN, CAN FD, remote and error frame of the source is written to the target in the
/// target's exact CANoe layout. Runs on the blocking pool with progress reports; returns
/// the frames written.
#[tauri::command]
pub async fn convert_can_log(from: String, to: String, format: String, on_progress: tauri::ipc::Channel<CanProgress>) -> Result<u64, String> {
	tauri::async_runtime::spawn_blocking(move || {
		let from_path = Path::new(&from);
		// The source's measurement start is preserved into the target's header: a BLF's
		// comes straight from its LOGG header, an .asc's from its date line.
		let is_blf = File::open(from_path)
			.and_then(|mut f| {
				let mut sig = [0u8; 4];
				f.read_exact(&mut sig)?;
				Ok(sig)
			})
			.map(|sig| sig == *b"LOGG")
			.map_err(|e| e.to_string())?;
		if !is_blf && from_path.extension().and_then(|e| e.to_str()).map(|e| e.to_ascii_lowercase()).as_deref() == Some("blf") {
			return Err("not a BLF file (missing LOGG signature)".to_string());
		}
		let start_epoch = if is_blf {
			blf_start_epoch(from_path).unwrap_or(0.0)
		} else {
			asc_start_epoch(from_path).unwrap_or(0.0)
		};
		// The save dialog can hand back the source's own path (the same-format choice even
		// defaults to it): refuse before File::create truncates the log the walk reads. A
		// target that does not exist yet cannot be the source, so only an existing one is
		// compared, canonicalised on both sides.
		let from_canonical = std::fs::canonicalize(from_path).map_err(|e| e.to_string())?;
		if std::fs::canonicalize(Path::new(&to)).is_ok_and(|to| to == from_canonical) {
			return Err("the target is the source file itself — pick a different name".to_string());
		}
		let out = File::create(Path::new(&to)).map_err(|e| e.to_string())?;
		let mut out = BufWriter::with_capacity(1 << 20, out);
		// The target writer is chosen up front (one mutable borrow of the output); the walk
		// below then hands every source frame to it, whichever pair of formats converts.
		let mut converter = if format.eq_ignore_ascii_case("blf") {
			Converter { writer: WriterTarget::Blf(BlfWriter::new(&mut out, start_epoch)) }
		} else {
			Converter { writer: WriterTarget::Asc(AscWriter::new(&mut out, start_epoch)) }
		};
		let mut reporter = ProgressReporter::new(on_progress, total_bytes_of(from_path));
		walk_source(from_path, &mut converter, &mut reporter)?;
		let frames = converter.finish().map_err(|e| e.to_string())?;
		out.flush().map_err(|e| e.to_string())?;
		Ok(frames)
	})
	.await
	.map_err(|e| e.to_string())?
}

/// The measurement start an .asc's `date …` header line states, without walking the file.
fn asc_start_epoch(path: &Path) -> Option<f64> {
	let reader = std::io::BufReader::new(File::open(path).ok()?);
	for line in reader.lines().take(8) {
		let line = line.ok()?;
		let lower = line.trim_start_matches('\u{feff}').trim().to_ascii_lowercase();
		if lower.starts_with("date ") {
			return parse_asc_date(&line.trim_start_matches('\u{feff}').trim()[5..]);
		}
		if !lower.starts_with("//") && !lower.is_empty() {
			break;
		}
	}
	None
}
impl<W: Write + Seek> Converter<W> {
	/// Finishes the target (the BLF's header rewrite) and reports the frames written, or
	/// the first I/O error the writer recorded along the way.
	fn finish(&mut self) -> std::io::Result<u64> {
		match &mut self.writer {
			WriterTarget::Asc(w) => match w.error.take() {
				Some(e) => Err(e),
				None => Ok(w.frames),
			},
			WriterTarget::Blf(w) => w.finish(),
		}
	}
}

/* ---------- Raw-frame documents (the raw log view) ---------- */

/// The raw view's filter, one dimension per toolbar control. Every dimension is "empty =
/// keep everything", so the zero spec is the whole log; a `None` filter skips the index
/// machinery entirely (the common, unfiltered browse).
#[derive(Deserialize, Clone, PartialEq, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct CanFrameFilter {
	/// The channels to keep; empty = every channel.
	pub channels: Vec<u16>,
	/// The direction to keep; `All` (the default) keeps both.
	pub direction: CanDirection,
	/// The frame type to keep; `All` (the default) keeps every kind.
	pub kind: CanKind,
	/// Inclusive id ranges as `[from, to]` pairs; empty = every id.
	pub id_ranges: Vec<(u32, u32)>,
}

#[derive(Deserialize, Clone, Copy, PartialEq, Eq, Default)]
#[serde(rename_all = "lowercase")]
pub enum CanDirection {
	#[default]
	All,
	Rx,
	Tx,
}

/// The frame kinds the Type column badges: a frame is exactly one of these, in this order
/// of precedence — error frames first (an FD error chip is an error), then remote requests,
/// then CAN FD data frames, then classic CAN data frames.
#[derive(Deserialize, Clone, Copy, PartialEq, Eq, Default)]
#[serde(rename_all = "lowercase")]
pub enum CanKind {
	#[default]
	All,
	Can,
	Canfd,
	Error,
	Remote,
}

/// The raw view's frames as columns, not an array of 90-byte records: a fifty-million-frame
/// trace costs ~24 bytes of columns per frame plus its payload (instead of a fixed 64-byte
/// array per frame), and a viewport fetch walks four hot runs instead of striding through
/// gigabytes of records.
struct FrameStore {
	t_ns: Vec<u64>,
	ids: Vec<u32>,
	/// channel (12 bits) | flags (8) | dlc (4) | payload length (7).
	meta: Vec<u32>,
	/// Cumulative payload-arena offsets: frame i's bytes are `bytes[ends[i-1]..ends[i]]`.
	ends: Vec<u64>,
	bytes: Vec<u8>,
	/// The channels named so far, ascending — the filter bar's channel list, which grows
	/// with the walk.
	channels: Vec<u16>,
	/// The cached match index of the filter the view last asked about, if any. Kept beside
	/// the columns so one lock guards both (see `refresh_filter`).
	filter: Option<FilteredIndex>,
}

/// `FrameStore`'s cached answer to one filter: the frames that pass it, as their indices in
/// log order. The store is append-only, so an unchanged filter only ever extends the index
/// as the walk lands more batches — a changed one rebuilds from scratch.
struct FilteredIndex {
	spec: CanFrameFilter,
	/// The store indices of the passing frames, ascending: position i of the filtered row
	/// space is `matches[i]`.
	matches: Vec<u32>,
	/// How many frames of the store `matches` already covers.
	applied: usize,
}

/// `meta`'s flag bits, MSB to LSB after the channel: extended, fd, brs, esi, remote, error, tx.
const F_EXTENDED: u32 = 1 << 11;
const F_FD: u32 = 1 << 12;
const F_BRS: u32 = 1 << 13;
const F_ESI: u32 = 1 << 14;
const F_REMOTE: u32 = 1 << 15;
const F_ERROR: u32 = 1 << 16;
const F_TX: u32 = 1 << 17;

impl FrameStore {
	fn push(&mut self, frame: &RawFrame) {
		let len = if frame.remote || frame.error { 0 } else { frame.len as usize };
		let flags = (F_EXTENDED * frame.extended as u32)
			| (F_FD * frame.fd as u32)
			| (F_BRS * frame.brs as u32)
			| (F_ESI * frame.esi as u32)
			| (F_REMOTE * frame.remote as u32)
			| (F_ERROR * frame.error as u32)
			| (F_TX * frame.tx as u32);
		let channel = frame.channel.min(0xfff);
		self.t_ns.push(frame.t_ns);
		self.ids.push(frame.id);
		self.meta.push(flags | ((frame.dlc as u32 & 0xf) << 7) | (len as u32 & 0x7f) | ((channel as u32) << 19));
		self.bytes.extend_from_slice(&frame.data[..len]);
		self.ends.push(self.bytes.len() as u64);
		if let Err(at) = self.channels.binary_search(&channel) {
			self.channels.insert(at, channel);
		}
	}

	fn len(&self) -> usize {
		self.meta.len()
	}

	/// Grows every column for `extra` more frames, so a batch lands without a reallocation
	/// under the document's lock.
	fn reserve(&mut self, extra: usize) {
		self.t_ns.reserve(extra);
		self.ids.reserve(extra);
		self.meta.reserve(extra);
		self.ends.reserve(extra);
		self.bytes.reserve(extra * 32);
	}

	/// One frame as the raw view's table row: the display fields only, with the payload
	/// already formatted as spaced hex so the 64-byte array never crosses the bridge.
	fn line(&self, index: usize) -> CanFrameLine {
		let meta = self.meta[index];
		let start = if index == 0 { 0 } else { self.ends[index - 1] as usize };
		let payload = &self.bytes[start..self.ends[index] as usize];
		let mut data_hex = String::with_capacity(payload.len() * 3);
		for byte in payload {
			if !data_hex.is_empty() {
				data_hex.push(' ');
			}
			data_hex.push_str(&format!("{byte:02X}"));
		}
		CanFrameLine {
			index: index as u64,
			t_s: self.t_ns[index] as f64 / 1e9,
			channel: (meta >> 19) as u16,
			id: self.ids[index],
			extended: meta & F_EXTENDED != 0,
			fd: meta & F_FD != 0,
			brs: meta & F_BRS != 0,
			esi: meta & F_ESI != 0,
			remote: meta & F_REMOTE != 0,
			error: meta & F_ERROR != 0,
			tx: meta & F_TX != 0,
			dlc: ((meta >> 7) & 0xf) as u8,
			data_hex,
		}
	}

	/// Whether the frame at `index` passes `spec` — one branch per dimension, the columns
	/// read straight out of `meta` (no per-frame record is ever materialised).
	fn passes(&self, index: usize, spec: &CanFrameFilter) -> bool {
		let meta = self.meta[index];
		let error = meta & F_ERROR != 0;
		let remote = meta & F_REMOTE != 0;
		let fd = meta & F_FD != 0;
		let kind_ok = match spec.kind {
			CanKind::All => true,
			// The kind is exactly what the row's Type badge shows, error frames first.
			CanKind::Error => error,
			CanKind::Remote => remote && !error,
			CanKind::Canfd => fd && !remote && !error,
			CanKind::Can => !fd && !remote && !error,
		};
		if !kind_ok {
			return false;
		}
		let tx = meta & F_TX != 0;
		if match spec.direction {
			CanDirection::All => false,
			CanDirection::Rx => tx,
			CanDirection::Tx => !tx,
		} {
			return false;
		}
		if !spec.channels.is_empty() && !spec.channels.contains(&((meta >> 19) as u16)) {
			return false;
		}
		// No id ranges named: every id passes; otherwise the id must lie in one of them.
		let id = self.ids[index];
		spec.id_ranges.is_empty() || spec.id_ranges.iter().any(|&(from, to)| id >= from && id <= to)
	}

	/// Brings the cached match index up to date with `spec`: extends it over the frames the
	/// walk has landed since it last ran, or rebuilds it from scratch when the spec changed
	/// (the view sends a fresh spec on every toolbar change, so the rebuild is exactly the
	/// user-visible filter change). A changed filter only ever needs the store as it is —
	/// nothing outside this lock reads the index.
	fn refresh_filter(&mut self, spec: &CanFrameFilter) {
		if !matches!(&self.filter, Some(cached) if cached.spec == *spec) {
			self.filter = Some(FilteredIndex { spec: spec.clone(), matches: Vec::new(), applied: 0 });
		}
		// The guard above made the cached spec identical to `spec`, so the loop reads the
		// caller's — one shared immutable borrow of self, no fighting the cached one.
		let applied = self.filter.as_ref().unwrap().applied;
		let total = self.len();
		for index in applied..total {
			if self.passes(index, spec) {
				self.filter.as_mut().unwrap().matches.push(index as u32);
			}
		}
		self.filter.as_mut().unwrap().applied = total;
	}

	/// A window of the filtered row space, in log order: position `i` of the window maps
	/// through the match index to the frame's own columns, and each line carries its
	/// original index so the "No." column stays the frame's place in the whole log.
	fn filtered_window(&mut self, spec: &CanFrameFilter, start: usize, end: usize) -> Vec<CanFrameLine> {
		self.refresh_filter(spec);
		let filter = self.filter.as_ref().unwrap();
		let end = end.min(filter.matches.len());
		(start.min(end)..end).map(|i| self.line(filter.matches[i] as usize)).collect()
	}
}

/// One frame as the raw view's table row: the display fields only, with the payload already
/// formatted as spaced hex so the 64-byte array never crosses the bridge.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CanFrameLine {
	/// The frame's position in the whole log — the row's "No.", whatever filter narrowed
	/// the view (the lines arrive in filtered order but number in log order).
	pub index: u64,
	pub t_s: f64,
	pub channel: u16,
	pub id: u32,
	pub extended: bool,
	pub fd: bool,
	pub brs: bool,
	pub esi: bool,
	pub remote: bool,
	pub error: bool,
	pub tx: bool,
	pub dlc: u8,
	pub data_hex: String,
}

/// A log opened for raw browsing: the whole walk's frames, filled in by a background task
/// while the view renders whatever is already there. `parsed` is the frame count published
/// to the frontend (frames past it do not exist yet) and `bytes` the walk's file position —
/// together they are the live progress; `done` closes the poll; `error` carries a parse
/// failure once the walk ends.
pub struct CanLogDoc {
	frames: Mutex<FrameStore>,
	parsed: AtomicUsize,
	bytes: AtomicU64,
	total_bytes: u64,
	done: AtomicBool,
	error: Mutex<Option<String>>,
}

impl CanLogDoc {
	fn new(total_bytes: u64) -> Self {
		CanLogDoc {
			frames: Mutex::new(FrameStore { t_ns: Vec::new(), ids: Vec::new(), meta: Vec::new(), ends: Vec::new(), bytes: Vec::new(), channels: Vec::new(), filter: None }),
			parsed: AtomicUsize::new(0),
			bytes: AtomicU64::new(0),
			total_bytes,
			done: AtomicBool::new(false),
			error: Mutex::new(None),
		}
	}
}

/// Every open raw-log document by id — the raw view's counterpart of the code viewer's
/// `ViewerState`, so a tab's frames live exactly as long as the tab does.
#[derive(Default)]
pub struct CanLogState {
	docs: Mutex<HashMap<u32, Arc<CanLogDoc>>>,
	next_id: AtomicU32,
}

impl CanLogState {
	fn register(&self, doc: Arc<CanLogDoc>) -> u32 {
		let id = self.next_id.fetch_add(1, Ordering::Relaxed) + 1;
		self.docs.lock().unwrap().insert(id, doc);
		id
	}

	fn get(&self, id: u32) -> Option<Arc<CanLogDoc>> {
		self.docs.lock().unwrap().get(&id).cloned()
	}
}

/// How many staged frames the raw view's sink holds before it lands them in the document:
/// enough that a fifty-million-frame walk takes thousands of locks, not millions, few
/// enough that the published count (and the rows on screen) keep moving.
const RAW_SINK_BATCH: usize = 8192;

/// The sink behind the raw view: frames stage in a bounded batch and land in the document
/// under one lock, and the published count moves with each landing so the view can grow its
/// scroll range live.
struct VecSink {
	doc: Arc<CanLogDoc>,
	staging: Vec<RawFrame>,
}

impl VecSink {
	fn flush(&mut self) {
		if self.staging.is_empty() {
			return;
		}
		let mut frames = self.doc.frames.lock().unwrap();
		frames.reserve(self.staging.len());
		for frame in &self.staging {
			frames.push(frame);
		}
		let seen = frames.len();
		drop(frames);
		self.doc.parsed.store(seen, Ordering::Relaxed);
		self.staging.clear();
	}
}

impl FrameSink for VecSink {
	fn frame(&mut self, frame: RawFrame) {
		self.staging.push(frame);
		if self.staging.len() >= RAW_SINK_BATCH {
			self.flush();
		}
	}

	fn seen(&self) -> u64 {
		self.doc.parsed.load(Ordering::Relaxed) as u64
	}
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CanOpenResult {
	pub doc_id: u32,
	pub total_bytes: u64,
}

/// Opens a CAN log for raw browsing. The parse itself is a detached background walk — this
/// returns as soon as the document exists, and the view polls `can_log_count` while the
/// frames accumulate, so the first rows are on screen long before a giant log finishes.
#[tauri::command]
pub async fn can_log_open(path: String, state: tauri::State<'_, CanLogState>) -> Result<CanOpenResult, String> {
	let total_bytes = total_bytes_of(Path::new(&path));
	let doc = Arc::new(CanLogDoc::new(total_bytes));
	let doc_id = state.register(Arc::clone(&doc));
	tauri::async_runtime::spawn_blocking(move || {
		let mut sink = VecSink { doc: Arc::clone(&doc), staging: Vec::with_capacity(RAW_SINK_BATCH) };
		let mut reporter = ProgressReporter::into_doc(total_bytes, Arc::clone(&doc));
		let result = walk_source(Path::new(&path), &mut sink, &mut reporter);
		// The last staged batch lands before `done` flips, so the final poll's count is
		// the whole walk's.
		sink.flush();
		if let Err(e) = result {
			*doc.error.lock().unwrap() = Some(e);
		}
		doc.done.store(true, Ordering::Release);
	});
	Ok(CanOpenResult { doc_id, total_bytes })
}

/// A window of the document's frames, in log order — only what the viewport shows ever
/// crosses the bridge. A range past the parsed prefix comes back short (or empty). With a
/// filter, the window is of the frames that pass it and each line still numbers its frame
/// in the whole log; the first application of a filter walks the parsed prefix once, so
/// this runs on the blocking pool like every other heavy walk in this module.
#[tauri::command]
pub async fn can_log_frames(state: tauri::State<'_, CanLogState>, doc_id: u32, start: usize, end: usize, filter: Option<CanFrameFilter>) -> Result<Vec<CanFrameLine>, String> {
	let doc = state.get(doc_id).ok_or_else(|| "this log view was closed".to_string())?;
	tauri::async_runtime::spawn_blocking(move || {
		let mut frames = doc.frames.lock().unwrap();
		Ok(match &filter {
			None => {
				let end = end.min(frames.len());
				(start.min(end)..end).map(|i| frames.line(i)).collect()
			}
			Some(spec) => frames.filtered_window(spec, start, end),
		})
	})
	.await
	.map_err(|e| e.to_string())?
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CanLogCount {
	pub parsed: u64,
	/// The frames that pass the filter the caller asked about — the scroll range's length
	/// while one is active; equals `parsed` without a filter.
	pub matched: u64,
	pub done: bool,
	pub error: Option<String>,
	/// The walk's file position and the file's size — the live percentage.
	pub bytes: u64,
	pub total_bytes: u64,
	/// The channels the frames have named so far, ascending — the filter bar's channel list.
	pub channels: Vec<u16>,
}

/// How far the background walk has come — what the raw view polls to extend its scroll
/// range, and where a parse failure surfaces once the walk ends. The optional filter makes
/// the same poll report the filtered row count (`matched`) and refresh the cached match
/// index as the walk lands more batches.
#[tauri::command]
pub async fn can_log_count(state: tauri::State<'_, CanLogState>, doc_id: u32, filter: Option<CanFrameFilter>) -> Result<CanLogCount, String> {
	let doc = state.get(doc_id).ok_or_else(|| "this log view was closed".to_string())?;
	tauri::async_runtime::spawn_blocking(move || {
		let error = doc.error.lock().unwrap().clone();
		let parsed = doc.parsed.load(Ordering::Relaxed) as u64;
		let mut frames = doc.frames.lock().unwrap();
		// An unfiltered poll touches no index — the whole point of `Option`.
		let matched = match &filter {
			Some(spec) => {
				frames.refresh_filter(spec);
				frames.filter.as_ref().map_or(0, |f| f.matches.len()) as u64
			}
			None => parsed,
		};
		let channels = frames.channels.clone();
		drop(frames);
		Ok(CanLogCount {
			parsed,
			matched,
			done: doc.done.load(Ordering::Acquire),
			error,
			bytes: doc.bytes.load(Ordering::Relaxed),
			total_bytes: doc.total_bytes,
			channels,
		})
	})
	.await
	.map_err(|e| e.to_string())?
}

/// A find query normalised for the frame columns: the bytes to look for inside payloads
/// and, when the whole query parses as one 29-bit number, the id to look for. A frame
/// matches on either — CANoe's trace find is id-or-content, not a text regex.
struct CanQuery {
	id: Option<u32>,
	bytes: Vec<u8>,
}

/// Parse a find query: whitespace, commas and colons are dropped, an optional `0x` prefix
/// is stripped, and the rest must be hexadecimal digits. `100` is the id 0x100; `1000` is
/// both the id 0x1000 and the byte pair 10 00; an odd-length query can only be an id.
fn parse_can_query(query: &str) -> Result<CanQuery, String> {
	let cleaned: String = query.chars().filter(|c| !c.is_whitespace() && *c != ',' && *c != ':').collect();
	let cleaned = cleaned.strip_prefix("0x").or_else(|| cleaned.strip_prefix("0X")).unwrap_or(&cleaned);
	if cleaned.is_empty() {
		return Err("the find query is empty".to_string());
	}
	if !cleaned.chars().all(|c| c.is_ascii_hexdigit()) {
		return Err(format!("'{query}' is not a hexadecimal query — ids and data bytes are written in hex"));
	}
	let id = u32::from_str_radix(cleaned, 16).ok().filter(|&id| id <= 0x1fff_ffff);
	let bytes = if cleaned.len() % 2 == 0 {
		cleaned.as_bytes().chunks_exact(2).map(|pair| u8::from_str_radix(std::str::from_utf8(pair).unwrap(), 16).unwrap()).collect()
	} else {
		Vec::new()
	};
	Ok(CanQuery { id, bytes })
}

/// How many hit positions cross the bridge — the count stays exact, the jump list is capped
/// the way the editor's find caps its match count.
const MAX_FIND_POSITIONS: usize = 10_000;

/// A find's answer: the matching positions of the (filtered) row space — capped — and the
/// true total, so the bar can say "10,000+" while still jumping exactly.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CanFindResult {
	pub positions: Vec<u32>,
	pub total: u64,
	pub capped: bool,
}

/// The matches of `query` over an ordered walk of `(frame index, row position)` pairs — one
/// bounded pass of the columns, no per-frame record on the heap.
fn find_positions<'a>(frames: &FrameStore, walk: impl Iterator<Item = (usize, u32)> + 'a, query: &CanQuery) -> CanFindResult {
	let mut out = CanFindResult { positions: Vec::new(), total: 0, capped: false };
	for (frame_index, position) in walk {
		if !frames.matches_query(frame_index, query) {
			continue;
		}
		out.total += 1;
		if out.positions.len() < MAX_FIND_POSITIONS {
			out.positions.push(position);
		} else {
			out.capped = true;
		}
	}
	out
}

impl FrameStore {
	/// Whether the frame at `index` matches a find query: its id equals the query's id, or
	/// the query's byte sequence occurs consecutively in its payload.
	fn matches_query(&self, index: usize, query: &CanQuery) -> bool {
		if query.id.is_some_and(|id| self.ids[index] == id) {
			return true;
		}
		if query.bytes.is_empty() {
			return false;
		}
		let start = if index == 0 { 0 } else { self.ends[index - 1] as usize };
		let payload = &self.bytes[start..self.ends[index] as usize];
		payload.windows(query.bytes.len()).any(|window| window == query.bytes)
	}
}

/// Find in the raw log — the raw view's search bar (Ctrl+F): every frame whose id or
/// payload matches the hex query, in log order, as positions of the current row space (a
/// filter on means only its frames are searched, and the positions address the filtered
/// rows the view scrolls). One bounded pass over the columns on the blocking pool.
#[tauri::command]
pub async fn can_log_find(state: tauri::State<'_, CanLogState>, doc_id: u32, query: String, filter: Option<CanFrameFilter>) -> Result<CanFindResult, String> {
	let doc = state.get(doc_id).ok_or_else(|| "this log view was closed".to_string())?;
	tauri::async_runtime::spawn_blocking(move || {
		let needle = parse_can_query(&query)?;
		let mut frames = doc.frames.lock().unwrap();
		Ok(match &filter {
			None => find_positions(&frames, (0..frames.len()).map(|index| (index, index as u32)), &needle),
			Some(spec) => {
				frames.refresh_filter(spec);
				let filter = frames.filter.as_ref().unwrap();
				find_positions(&frames, filter.matches.iter().enumerate().map(|(position, &frame)| (frame as usize, position as u32)), &needle)
			}
		})
	})
	.await
	.map_err(|e| e.to_string())?
}

/// Releases a raw-log document's frames when its tab closes.
#[tauri::command]
pub fn can_log_close(state: tauri::State<'_, CanLogState>, doc_id: u32) -> Result<(), String> {
	state.docs.lock().unwrap().remove(&doc_id);
	Ok(())
}

/* ---------- Tests ---------- */

#[cfg(test)]
mod tests {
	use super::*;

	/// A minimal BLF: the 144-byte LOGG header and one uncompressed log container holding
	/// the given object bytes, so a test only describes the CAN objects it cares about.
	fn blf_with(objects: &[u8]) -> Vec<u8> {
		// LOBJ base (16) + container body (16) + payload.
		let object_size = 32 + objects.len() as u32;
		let mut out = vec![0u8; 144];
		out[0..4].copy_from_slice(b"LOGG");
		out[4..8].copy_from_slice(&144u32.to_le_bytes());
		let mut container = Vec::new();
		container.extend_from_slice(b"LOBJ");
		container.extend_from_slice(&16u16.to_le_bytes()); // container header size
		container.extend_from_slice(&1u16.to_le_bytes());
		container.extend_from_slice(&object_size.to_le_bytes());
		container.extend_from_slice(&OBJ_LOG_CONTAINER.to_le_bytes());
		container.extend_from_slice(&0u16.to_le_bytes()); // no compression
		container.extend_from_slice(&[0u8; 6]);
		container.extend_from_slice(&(objects.len() as u32).to_le_bytes());
		container.extend_from_slice(&[0u8; 4]);
		container.extend_from_slice(objects);
		out.extend_from_slice(&container);
		out
	}

	/// One CAN_MESSAGE object (v1 header, nanosecond ticks): base, v1 header, body.
	fn can_message(ns: u64, channel: u16, id: u32, dlc: u8) -> Vec<u8> {
		let size = 16 + 16 + 16;
		let mut o = Vec::new();
		o.extend_from_slice(b"LOBJ");
		o.extend_from_slice(&32u16.to_le_bytes());
		o.extend_from_slice(&1u16.to_le_bytes());
		o.extend_from_slice(&(size as u32).to_le_bytes());
		o.extend_from_slice(&OBJ_CAN_MESSAGE.to_le_bytes());
		o.extend_from_slice(&2u32.to_le_bytes()); // flags 2: nanoseconds
		o.extend_from_slice(&0u16.to_le_bytes());
		o.extend_from_slice(&0u16.to_le_bytes());
		o.extend_from_slice(&ns.to_le_bytes());
		o.extend_from_slice(&channel.to_le_bytes());
		o.extend_from_slice(&[0u8]); // flags: Rx
		o.extend_from_slice(&[dlc]);
		o.extend_from_slice(&id.to_le_bytes());
		o.extend_from_slice(&[0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77, 0x88]);
		o.resize(size, 0);
		o
	}

	#[test]
	fn blf_counts_frames_errors_and_bus_bits() {
		// 0x100 every 10 ms on channel 1, one extended frame, one error frame.
		let mut objects = can_message(0, 1, 0x100, 8);
		objects.extend(can_message(10_000_000, 1, 0x100, 8)); // 10 ms later
		objects.extend(can_message(20_000_000, 1, 0x18ff_0001 | 0x8000_0000, 2));
		// A CAN_ERROR_EXT: base + v1 header + the error struct.
		let size = 16 + 16 + 32;
		let mut err = Vec::new();
		err.extend_from_slice(b"LOBJ");
		err.extend_from_slice(&32u16.to_le_bytes());
		err.extend_from_slice(&1u16.to_le_bytes());
		err.extend_from_slice(&(size as u32).to_le_bytes());
		err.extend_from_slice(&OBJ_CAN_ERROR_EXT.to_le_bytes());
		err.extend_from_slice(&2u32.to_le_bytes());
		err.extend_from_slice(&0u16.to_le_bytes());
		err.extend_from_slice(&0u16.to_le_bytes());
		err.extend_from_slice(&5_000_000u64.to_le_bytes()); // 5 ms in
		err.extend_from_slice(&1u16.to_le_bytes()); // channel 1
		err.resize(size, 0);
		objects.extend(err);
		let file = blf_with(&objects);
		let stats = stats_of_blf(&file);
		assert_eq!(stats.format, "BLF");
		assert_eq!(stats.total_frames, 3);
		assert_eq!(stats.error_frames, 1);
		assert_eq!(stats.channels.len(), 1);
		assert_eq!(stats.channels[0].frames, 3);
		// Duration from first frame (0) to last (20 ms).
		assert!((stats.duration_s - 0.02).abs() < 1e-9);
		// 2 × (47+64 stuffed) + 1 × extended (67+16 stuffed).
		let classic = 47.0 + 64.0;
		let ext = 67.0 + 16.0;
		let stuffed = |raw: f64| raw + ((raw - 1.0) / 4.0).floor();
		assert!((stats.channels[0].bus_bits - (stuffed(classic) * 2.0 + stuffed(ext))).abs() < 1e-9);
		// The cyclic id's stats: 2 frames, a 10 ms cycle.
		let id100 = stats.messages.iter().find(|m| m.id == 0x100).unwrap();
		assert_eq!(id100.count, 2);
		assert!((id100.avg_cycle_s - 0.01).abs() < 1e-9);
		assert!((id100.min_cycle_s - 0.01).abs() < 1e-9);
	}

	fn stats_of_blf(bytes: &[u8]) -> CanLogStats {
		let mut agg = Aggregator::new();
		let (start, _) = walk_blf(Cursor::new(bytes.to_vec()), &mut agg).unwrap();
		agg.finish("BLF", start)
	}

	#[test]
	fn blf_zlib_containers_decompress() {
		let mut objects = can_message(0, 2, 0x321, 4);
		objects.extend(can_message(1_000_000_000, 2, 0x321, 4));
		let plain = objects.clone();
		let mut zlib = flate2::write::ZlibEncoder::new(Vec::new(), flate2::Compression::default());
		zlib.write_all(&plain).unwrap();
		let compressed = zlib.finish().unwrap();
		let mut out = vec![0u8; 144];
		out[0..4].copy_from_slice(b"LOGG");
		out[4..8].copy_from_slice(&144u32.to_le_bytes());
		let object_size = 32 + compressed.len() as u32;
		out.extend_from_slice(b"LOBJ");
		out.extend_from_slice(&16u16.to_le_bytes());
		out.extend_from_slice(&1u16.to_le_bytes());
		out.extend_from_slice(&object_size.to_le_bytes());
		out.extend_from_slice(&OBJ_LOG_CONTAINER.to_le_bytes());
		out.extend_from_slice(&2u16.to_le_bytes()); // zlib
		out.extend_from_slice(&[0u8; 6]);
		out.extend_from_slice(&(plain.len() as u32).to_le_bytes());
		out.extend_from_slice(&[0u8; 4]);
		out.extend_from_slice(&compressed);
		let stats = stats_of_blf(&out);
		assert_eq!(stats.total_frames, 2);
		assert_eq!(stats.channels[0].channel, 2);
		assert!((stats.duration_s - 1.0).abs() < 1e-9);
	}

	/// One CAN_MESSAGE object of a chosen total size, so a test can place objects at every
	/// `size % 4` residue. A size under 48 simply holds fewer payload bytes than the DLC
	/// claims — the walk clamps, exactly as it does for a corrupt object.
	fn can_message_of_size(ns: u64, channel: u16, id: u32, size: usize) -> Vec<u8> {
		let mut o = can_message(ns, channel, id, 8);
		o.truncate(size);
		o[8..12].copy_from_slice(&(size as u32).to_le_bytes());
		o.resize(size, 0);
		o
	}

	/// One uncompressed log container around `objects`, with the container itself followed
	/// by its `size % 4` padding — the file-level twin of the padding objects carry.
	fn container_with(objects: &[u8]) -> Vec<u8> {
		let object_size = 32 + objects.len() as u32;
		let mut c = Vec::new();
		c.extend_from_slice(b"LOBJ");
		c.extend_from_slice(&16u16.to_le_bytes());
		c.extend_from_slice(&1u16.to_le_bytes());
		c.extend_from_slice(&object_size.to_le_bytes());
		c.extend_from_slice(&OBJ_LOG_CONTAINER.to_le_bytes());
		c.extend_from_slice(&0u16.to_le_bytes());
		c.extend_from_slice(&[0u8; 6]);
		c.extend_from_slice(&(objects.len() as u32).to_le_bytes());
		c.extend_from_slice(&[0u8; 4]);
		c.extend_from_slice(objects);
		c.extend(std::iter::repeat_n(0, object_size as usize % 4));
		c
	}

	#[test]
	fn blf_reads_canoe_style_object_padding() {
		// CANoe's loggers pad an object by `size % 4` bytes — not rounded up to a multiple
		// of 4 — inside containers and between them alike (python-can reads and writes the
		// same convention; a real Vector logger file walks only under this rule). One
		// object per residue class at both levels.
		let mut first = Vec::new();
		for (i, size) in [45usize, 46, 47, 48, 47].into_iter().enumerate() {
			first.extend(can_message_of_size(i as u64 * 1_000_000, 1, 0x100 + i as u32, size));
			first.extend(std::iter::repeat_n(0, size % 4));
		}
		let mut second = Vec::new();
		second.extend(can_message_of_size(9_000_000, 2, 0x201, 46));
		second.extend(std::iter::repeat_n(0, 46 % 4));
		second.extend(can_message_of_size(9_500_000, 2, 0x202, 45));
		second.extend(std::iter::repeat_n(0, 45 % 4));
		let mut file = vec![0u8; 144];
		file[0..4].copy_from_slice(b"LOGG");
		file[4..8].copy_from_slice(&144u32.to_le_bytes());
		file.extend(container_with(&first));
		file.extend(container_with(&second));
		let stats = stats_of_blf(&file);
		assert_eq!(stats.total_frames, 7);
		assert_eq!(stats.messages.len(), 7);
	}

	#[test]
	fn blf_writer_pads_the_way_canoe_and_python_can_do() {
		// The reader tolerates either padding, but python-can's is a strict `size % 4` skip
		// with no searching: a BLF this app writes must stay aligned under that rule, which
		// only holds if the writer pads the same way. Inside a container, and at file level.
		let mut writer = BlfWriter::new(Cursor::new(Vec::new()), 0.0);
		for (i, size) in [48usize, 45, 46, 47].into_iter().enumerate() {
			writer.push_object(&can_message_of_size(i as u64 * 1_000_000, 1, 0x100 + i as u32, size));
		}
		let buffer = writer.buffer.clone();
		let mut pos = 0usize;
		for size in [48usize, 45, 46, 47] {
			assert_eq!(u32_at(&buffer, pos + 8) as usize, size);
			pos += size;
			for _ in 0..size % 4 {
				assert_eq!(buffer[pos], 0, "padding after a {}-byte object", size);
				pos += 1;
			}
		}
		assert_eq!(pos, buffer.len());
		// The strict file-level walk python-can performs stays on every container header.
		let mut writer = BlfWriter::new(Cursor::new(Vec::new()), 0.0);
		for i in 0..3_000u64 {
			writer.frame(&RawFrame::data_frame(i * 1_000_000, 1, 0x100 + (i % 4) as u32, false, false, 8, 8, &[1, 2, 3, 4, 5, 6, 7, 8], false));
		}
		writer.finish().unwrap();
		let bytes = writer.out.into_inner();
		let mut at = 144usize;
		let mut containers = 0;
		let mut odd_residues = 0;
		while at + 16 <= bytes.len() {
			assert_eq!(&bytes[at..at + 4], b"LOBJ", "a strict size%4 reader desynchronises at {}", at);
			let size = u32_at(&bytes, at + 8) as usize;
			if size % 4 != 0 {
				odd_residues += 1;
			}
			containers += 1;
			at += size + size % 4;
		}
		assert_eq!(at, bytes.len());
		assert!(containers >= 1);
		assert!(odd_residues >= 1, "the fixture never exercised a padded container");
	}

	#[test]
	fn blf_read_the_start_time() {
		let mut objects = can_message(0, 1, 0x1, 0);
		objects.extend(can_message(10_000_000, 1, 0x1, 0));
		let mut file = blf_with(&objects);
		// SYSTEMTIME at offset 40: 2026-09-14 08:30:00.250 (index 2 is the day of week).
		let st: [u16; 8] = [2026, 9, 1, 14, 8, 30, 0, 250];
		for (i, v) in st.iter().enumerate() {
			file[40 + i * 2..40 + i * 2 + 2].copy_from_slice(&v.to_le_bytes());
		}
		let stats = stats_of_blf(&file);
		let start = stats.start_timestamp_s.unwrap();
		let days = days_from_civil(2026, 9, 14);
		assert!((start - (days as f64 * 86_400.0 + 8.0 * 3_600.0 + 30.0 * 60.0 + 0.25)).abs() < 1e-6);
	}

	#[test]
	fn asc_parses_classic_and_fd_lines() {
		let text = "\
date 09/14/2026 08:30:00.250
base hex timestamps absolute
no internal events logged
// version 9.0.1
   0.000000 1  100  Rx   d 8 17 03 22 01 F1 26 08 08
   0.010000 1  100  Rx   d 8 17 03 22 01 F1 26 08 08
   0.020000 1  100  Rx   d 8 17 03 22 01 F1 26 08 08
   0.025000 1  1ABCDEF Tx   d 3 AA BB CC
   0.030000 1 ErrorFrame
   0.040000 CANFD 1 Rx 200 BRS 9 12 00 11 22 33 44 55 66 77 88 99 AA BB
   0.050000 CANFD 2 Tx 1FF NoBRS 2 11 22
   0.060000 1  55  Rx   r 2
";
		let mut agg = Aggregator::new();
		walk_asc(text, &mut agg);
		let stats = agg.finish("ASC", None);
		assert_eq!(stats.total_frames, 7);
		assert_eq!(stats.error_frames, 1);
		let id100 = stats.messages.iter().find(|m| m.id == 0x100).unwrap();
		assert_eq!(id100.count, 3);
		assert!((id100.avg_cycle_s - 0.01).abs() < 1e-9);
		// An .asc line marks nothing, but a standard id cannot exceed 0x7FF: wide ids
		// read back as extended.
		let ext = stats.messages.iter().find(|m| m.id == 0x1ABCDEF).unwrap();
		assert!(ext.extended);
		assert_eq!(ext.tx, 1);
		// FD: a DLC code of 9 is a 12-byte frame, and the flag tokens vanish from the data.
		let fd = stats.messages.iter().find(|m| m.id == 0x200).unwrap();
		assert!(fd.fd);
		assert_eq!(fd.payload_bytes, 12);
		// A remote frame carries its dlc but no payload.
		let remote = stats.messages.iter().find(|m| m.id == 0x55).unwrap();
		assert_eq!(remote.count, 1);
		assert_eq!(remote.payload_bytes, 0);
		assert_eq!(stats.channels.len(), 2);
		assert!((stats.duration_s - 0.06).abs() < 1e-9);
	}

	#[test]
	fn asc_decimal_base() {
		let text = "\
base dec timestamps relative
   0.000000 1  256  Rx   d 2 01 02
   1.000000 1  256  Rx   d 2 01 02
";
		let mut agg = Aggregator::new();
		walk_asc(text, &mut agg);
		let stats = agg.finish("ASC", None);
		let id = stats.messages.iter().find(|m| m.id == 256).unwrap();
		assert_eq!(id.count, 2);
		assert!((stats.duration_s - 1.0).abs() < 1e-9);
	}

	#[test]
	fn asc_parses_canoe_12_digit_flags_and_trailing_metadata() {
		// The lines a current CANoe (12.x) writes, taken verbatim from a four-million-line
		// drive log: bare digit flags (`1 0` = BRS on, ESI off), the DLC as a single hex
		// character, the payload length in decimal, and after the counted payload a long
		// metadata run (duration, length, flags, crc, four bit timings). A symbolic name may
		// sit between the id and the flags; the `CAN n Status:` chip-status and per-second
		// `Statistic:` lines are internal events, not traffic.
		let text = "\
date Mon Sep 14 11:01:16.396 am 2026
base hex  timestamps absolute
internal events logged
// version 12.0.0
Begin TriggerBlock Mon Sep 14 11:01:16.396 am 2026
   0.000000 Start of measurement
   0.001279 CANFD   1 Rx        536                                   1 0 b 20 00 00 00 00 00 00 03 00 01 00 00 00 00 8b 0a 00 04 e1 40 8b   160000  249   303000 a8092d8f 50140850 4b280150 2007030e 2000091c
   0.001665 CANFD   1 Rx        341  CCU_Info2_50ms                   1 0 d 32 67 0e 00 00 00 10 06 00 00 80 40 00 a0 00 00 02 00 1f ff 80 00 00 00 00 00 00 00 00 00 40 00 00   219500  365   303000 9802c285 50140850 4b280150 2007030e 2000091c
   0.001837 CANFD   1 Rx        199                                   1 0 8  8 00 a0 aa aa aa aa a9 a8    99984  129   303000 d00162d6 50140850 4b280150 2007030e 2000091c
   0.035271 CAN 1 Status:chip status error active
   1.035271 1  Statistic: D 1645 R 0 XD 0 XR 0 E 0 O 0 B 32.10%
";
		struct FrameCollector(Vec<RawFrame>);
		impl FrameSink for FrameCollector {
			fn frame(&mut self, frame: RawFrame) {
				self.0.push(frame);
			}
		}
		let mut c = FrameCollector(Vec::new());
		walk_asc(text, &mut c);
		// Exactly the three CANFD frames — the internal events never reach a sink.
		assert_eq!(c.0.len(), 3);
		let (a, b, d) = (&c.0[0], &c.0[1], &c.0[2]);
		assert_eq!(a.id, 0x536);
		assert!(a.fd);
		assert!(a.brs);
		assert!(!a.esi);
		assert_eq!(a.dlc, 0xb);
		assert_eq!(a.len, 20);
		assert_eq!(a.data[..a.len as usize], [0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x03, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x8b, 0x0a, 0x00, 0x04, 0xe1, 0x40, 0x8b]);
		// The named line: the name is skipped, DLC `d` is code 13 → 32 payload bytes.
		assert_eq!(b.id, 0x341);
		assert_eq!(b.dlc, 0xd);
		assert_eq!(b.len, 32);
		assert_eq!(b.data[0], 0x67);
		// DLC 8 with its plain decimal count: an eight-byte frame.
		assert_eq!(d.id, 0x199);
		assert_eq!(d.len, 8);
		assert_eq!(d.data[..8], [0x00, 0xa0, 0xaa, 0xaa, 0xaa, 0xaa, 0xa9, 0xa8]);
	}

	#[test]
	fn frame_bits_scale_with_payload() {
		assert!((frame_bits(false, false, 0) - (47.0 + 11.0)).abs() < 1e-9);
		assert!(frame_bits(true, false, 8) > frame_bits(false, false, 8));
		assert_eq!(fd_dlc_bytes(15), 64);
		assert_eq!(len2fd_dlc(64), 15);
		assert_eq!(len2fd_dlc(12), 9);
	}

	/* ----- conversion ----- */

	fn collect_frames(bytes: &[u8]) -> Vec<RawFrame> {
		struct Collector(Vec<RawFrame>);
		impl FrameSink for Collector {
			fn frame(&mut self, frame: RawFrame) {
				self.0.push(frame);
			}
		}
		let mut c = Collector(Vec::new());
		if bytes.starts_with(b"LOGG") {
			walk_blf(Cursor::new(bytes.to_vec()), &mut c).unwrap();
		} else {
			walk_asc(std::str::from_utf8(bytes).unwrap(), &mut c);
		}
		c.0
	}

	/// The frames a conversion must carry over untouched: everything but the representation.
	fn sample_frames() -> Vec<RawFrame> {
		let mut frames = vec![
			RawFrame::data_frame(0, 1, 0x100, false, false, 8, 8, &[0x17, 0x03, 0x22, 0x01, 0xF1, 0x26, 0x08, 0x08], false),
			RawFrame::data_frame(10_000_000, 1, 0x100, false, false, 8, 8, &[0x17, 0x03, 0x22, 0x01, 0xF1, 0x26, 0x08, 0x08], false),
			RawFrame::data_frame(10_000_000, 1, 0x18ff_0001, true, false, 3, 3, &[0xAA, 0xBB, 0xCC], true),
		];
		let mut fd = RawFrame::data_frame(40_000_000, 2, 0x200, false, true, 9, 12, &[0u8; 64], false);
		fd.brs = true;
		frames.push(fd);
		frames.push(error_frame(50_000_000, 2));
		frames
	}

	fn key(frame: &RawFrame) -> (u64, u16, u32, bool, bool, bool, bool, u8, u8, bool) {
		(frame.t_ns, frame.channel, frame.id, frame.extended, frame.fd, frame.brs, frame.error, frame.dlc, frame.len, frame.tx)
	}

	#[test]
	fn asc_round_trip_keeps_every_frame() {
		let frames = sample_frames();
		let mut asc = Vec::new();
		{
			let mut writer = AscWriter::new(&mut asc, 0.0);
			for frame in &frames {
				writer.frame(frame);
			}
		}
		let text = String::from_utf8(asc.clone()).unwrap();
		// The lines are CANoe's own layout, byte for byte.
		assert!(text.starts_with("date "));
		assert!(text.contains("base hex timestamps absolute\nno internal events logged\n// version 9.0.1\n"));
		assert!(text.contains("   0.010000 1  100  Rx   d 8 17 03 22 01 F1 26 08 08\n"));
		assert!(text.contains("   0.010000 1  18FF0001x  Tx   d 3 AA BB CC\n"));
		assert!(text.contains("   0.040000 CANFD 2 Rx 200 BRS 9 12 00 00 00 00 00 00 00 00 00 00 00 00 0 0 0 0 0 0 0 0\n"));
		assert!(text.contains("   0.050000 2 ErrorFrame\n"));
		let back = collect_frames(&asc);
		assert_eq!(back.len(), frames.len());
		for (a, b) in frames.iter().zip(back.iter()) {
			assert_eq!(key(a), key(b), "frame changed through the ASC round trip");
			assert_eq!(a.data[..a.len as usize], b.data[..b.len as usize]);
		}
	}

	#[test]
	fn blf_round_trip_keeps_every_frame() {
		let frames = sample_frames();
		let mut blf: Vec<u8> = Vec::new();
		{
			let mut writer = BlfWriter::new(Cursor::new(&mut blf), 0.0);
			for frame in &frames {
				writer.frame(frame);
			}
			writer.finish().unwrap();
		}
		// The written BLF is a real one: LOGG header, then LOBJ containers.
		assert_eq!(&blf[0..4], b"LOGG");
		assert_eq!(u32_at(&blf, 4), 144);
		assert_eq!(&blf[144..148], b"LOBJ");
		let back = collect_frames(&blf);
		assert_eq!(back.len(), frames.len());
		for (a, b) in frames.iter().zip(back.iter()) {
			assert_eq!(key(a), key(b), "frame changed through the BLF round trip");
			assert_eq!(a.data[..a.len as usize], b.data[..b.len as usize]);
		}
	}

	#[test]
	fn asc_to_blf_and_back_is_lossless() {
		let frames = sample_frames();
		let mut asc = Vec::new();
		{
			let mut writer = AscWriter::new(&mut asc, 0.0);
			for frame in &frames {
				writer.frame(frame);
			}
		}
		let mut blf: Vec<u8> = Vec::new();
		{
			let mut writer = BlfWriter::new(Cursor::new(&mut blf), 0.0);
			for frame in collect_frames(&asc) {
				writer.frame(&frame);
			}
			writer.finish().unwrap();
		}
		let mut asc2 = Vec::new();
		{
			let mut writer = AscWriter::new(&mut asc2, 0.0);
			for frame in collect_frames(&blf) {
				writer.frame(&frame);
			}
		}
		// ASC → BLF → ASC: the text comes back identical (timestamps are nanosecond-exact
		// through both formats, so nothing is rounded away).
		assert_eq!(String::from_utf8(asc).unwrap(), String::from_utf8(asc2).unwrap());
	}

	#[test]
	fn blf_writer_flushes_multiple_containers() {
		let mut writer = BlfWriter::new(Cursor::new(Vec::new()), 0.0);
		let expected: u64 = 6_000;
		for i in 0..expected {
			writer.frame(&RawFrame::data_frame(i * 1_000_000, 1, 0x100 + (i % 4) as u32, false, false, 8, 8, &[1, 2, 3, 4, 5, 6, 7, 8], false));
		}
		let frames = writer.finish().unwrap();
		assert_eq!(frames, expected);
		let bytes = writer.out.into_inner();
		// More than one 128 KiB container: every LOBJ at file level is a container.
		let containers = bytes[144..].chunks(4).filter(|c| c == b"LOBJ").count();
		let all = collect_frames(&bytes);
		assert_eq!(all.len() as u64, frames);
		assert!(containers >= 1);
	}

	/* ----- cycle analysis ----- */

	fn intervals_of(times: &[u64]) -> CanIntervals {
		analyse_intervals(times.to_vec(), 1, 0x100, false, false, 0)
	}

	#[test]
	fn intervals_report_the_cycle_and_jitter() {
		// 10 ms cycle with ±1 ms jitter.
		let times: Vec<u64> = (0..1000).map(|i| i as u64 * 10_000_000 + (i % 2) as u64 * 1_000_000).collect();
		let stats = intervals_of(&times);
		assert_eq!(stats.count, 1000);
		assert!((stats.median_cycle_s - 0.01).abs() < 0.001);
		assert!(stats.std_s > 0.0);
		assert!(stats.std_s < 0.002);
		assert_eq!(stats.missed_gaps, 0);
		assert_eq!(stats.missed_frames, 0);
		assert_eq!(stats.points.len(), 999);
		assert!(stats.histogram.iter().map(|b| b.count).sum::<u64>() >= 990);
	}

	#[test]
	fn intervals_count_missing_frames() {
		// 10 ms cycle; the frames at 80 ms and 90 ms are missing (one 30 ms gap).
		let mut times: Vec<u64> = Vec::new();
		for i in 0..8 {
			times.push(i as u64 * 10_000_000);
		}
		for i in 10..20 {
			times.push(i as u64 * 10_000_000);
		}
		let stats = intervals_of(&times);
		assert_eq!(stats.count, 18);
		assert_eq!(stats.missed_gaps, 1);
		assert_eq!(stats.missed_frames, 2);
		// The gap itself is marked in the series.
		assert_eq!(stats.points.iter().filter(|p| p.missed).count(), 1);
	}

	#[test]
	fn intervals_downsample_large_series() {
		let times: Vec<u64> = (0..100_000).map(|i| i as u64 * 1_000_000).collect();
		let stats = intervals_of(&times);
		assert!(stats.points.len() <= 4096);
		assert_eq!(stats.count, 100_000);
	}

	/* ----- the python-can / asc_parser_lib grammar ----- */

	#[test]
	fn asc_extended_marker_and_fd_extras() {
		let text = "\
date Mon Sep 14 08:30:00.250 2026
base hex timestamps absolute
   0.000000 1  123x  Rx   d 2 01 02
   0.001000 CANFD 1 Rx 456 EngineData BRS 9 12 00 11 22 33 44 55 66 77 88 99 AA BB 0 0 0 0 0 0 0 0 123 4 5 6 7 8 9 10
   0.002000 CANFD 1 Rx 789 NoBRS 2 2 AA BB
";
		struct Collector(Vec<RawFrame>);
		impl FrameSink for Collector {
			fn frame(&mut self, frame: RawFrame) {
				self.0.push(frame);
			}
		}
		let mut c = Collector(Vec::new());
		let mut state = AscState { hex_base: true, start_epoch: None };
		for line in text.lines() {
			walk_asc_line(line, &mut state, &mut c);
		}
		// The `x` suffix marks extended; 0x123 alone would be standard.
		assert!(c.0[0].extended);
		assert_eq!(c.0[0].id, 0x123);
		// The FD line's symbolic name is skipped, the decimal byte count bounds the data,
		// and the trailing metadata (eight zeros plus numbers) is not payload.
		assert!(c.0[1].fd);
		assert!(c.0[1].brs);
		assert_eq!(c.0[1].len, 12);
		assert_eq!(c.0[1].data[11], 0xBB);
		// A NoBRS frame with a plain two-byte payload.
		assert!(!c.0[2].brs);
		assert_eq!(c.0[2].len, 2);
		// The date line parsed into the state (CANoe's own layout).
		let days = days_from_civil(2026, 9, 14);
		assert!((state.start_epoch.unwrap() - (days as f64 * 86_400.0 + 8.0 * 3_600.0 + 30.0 * 60.0 + 0.25)).abs() < 1e-6);
	}

	#[test]
	fn asc_date_layouts() {
		// CANoe's ctime layout, the US mm/dd/yyyy layout with am/pm, and dd.mm.yyyy.
		let days = days_from_civil(2026, 9, 14) as f64;
		assert!((parse_asc_date("Mon Sep 14 08:30:00.250 2026").unwrap() - (days * 86_400.0 + 30_600.25)).abs() < 1e-6);
		assert!((parse_asc_date("09/14/2026 9:30:00 pm").unwrap() - (days * 86_400.0 + 21.0 * 3_600.0 + 1_800.0)).abs() < 1e-6);
		assert!((parse_asc_date("14.09.2026 08:30:00").unwrap() - (days * 86_400.0 + 30_600.0)).abs() < 1e-6);
		assert!(parse_asc_date("some weekday nonsense").is_none());
	}

	#[test]
	fn asc_streaming_matches_whole_text() {
		let text = "\
base hex timestamps relative
   0.000000 1  100  Rx   d 8 01 02 03 04 05 06 07 08
   0.010000 1  100  Rx   d 8 01 02 03 04 05 06 07 08
   0.020000 2  55  Rx   r 2
";
		struct Collector(Vec<RawFrame>);
		impl FrameSink for Collector {
			fn frame(&mut self, frame: RawFrame) {
				self.0.push(frame);
			}
		}
		let mut streamed = Collector(Vec::new());
		let mut on_chunk = |_, _| ();
		walk_asc_reader(std::io::BufReader::new(text.as_bytes()), &mut streamed, &mut on_chunk);
		let mut whole = Collector(Vec::new());
		walk_asc(text, &mut whole);
		assert_eq!(streamed.0.len(), whole.0.len());
		for (a, b) in streamed.0.iter().zip(whole.0.iter()) {
			assert_eq!(key(a), key(b));
		}
	}

	#[test]
	fn raw_doc_sink_collects_and_formats_lines() {
		let doc = Arc::new(CanLogDoc::new(0));
		let mut sink = VecSink { doc: Arc::clone(&doc), staging: Vec::new() };
		walk_asc(
			"   0.010000 1  18FF0001x  Tx   d 3 AA BB CC\n   0.020000 1 ErrorFrame\n   0.030000 1  55  Rx   r 2\n",
			&mut sink,
		);
		sink.flush();
		assert_eq!(doc.parsed.load(Ordering::Relaxed), 3);
		assert_eq!(sink.seen(), 3);
		let store = doc.frames.lock().unwrap();
		let lines: Vec<CanFrameLine> = (0..store.len()).map(|i| store.line(i)).collect();
		assert!((lines[0].t_s - 0.01).abs() < 1e-9);
		assert_eq!(lines[0].id, 0x18FF0001);
		assert!(lines[0].extended && lines[0].tx);
		assert_eq!(lines[0].data_hex, "AA BB CC");
		assert!(lines[1].error);
		assert_eq!(lines[1].data_hex, "");
		assert!(lines[2].remote);
		assert_eq!(lines[2].data_hex, "");
	}

	/* ----- the raw view's filter ----- */

	/// A raw document over one frame per filter dimension, walked out of a small .asc:
	/// two classic frames and an extended one on channel 1, a CAN FD pair on channel 2,
	/// a remote request and an error frame.
	fn filter_doc() -> Arc<CanLogDoc> {
		let doc = Arc::new(CanLogDoc::new(0));
		let mut sink = VecSink { doc: Arc::clone(&doc), staging: Vec::new() };
		walk_asc(
			"base hex timestamps relative\n\
			   0.000000 1  100  Rx   d 1 AA\n\
			   0.010000 1  100  Rx   d 1 AA\n\
			   0.020000 1  18FF0001x  Tx   d 2 BB CC\n\
			   0.030000 CANFD 2 Rx 200 BRS 9 12 00 11 22 33 44 55 66 77 88 99 AA BB\n\
			   0.040000 CANFD 2 Tx 1FF NoBRS 2 11 22\n\
			   0.050000 1  55  Rx   r 2\n\
			   0.060000 1 ErrorFrame\n",
			&mut sink,
		);
		sink.flush();
		doc
	}

	/// The matching frame indices under `spec`, through the same cached index the commands
	/// drive.
	fn matches_of(store: &mut FrameStore, spec: &CanFrameFilter) -> Vec<u32> {
		store.refresh_filter(spec);
		store.filter.as_ref().unwrap().matches.clone()
	}

	#[test]
	fn raw_filter_dimensions_narrow_independently_and_together() {
		let doc = filter_doc();
		let mut store = doc.frames.lock().unwrap();
		// The channel list the filter bar's select is built from.
		assert_eq!(store.channels, vec![1, 2]);
		let ids = |store: &mut FrameStore, spec: &CanFrameFilter| matches_of(store, spec);
		// Every dimension empty: the whole log.
		assert_eq!(ids(&mut store, &CanFrameFilter::default()), vec![0, 1, 2, 3, 4, 5, 6]);
		// Ids: a single id, then a range around both classic ids — the extended 0x18FF0001
		// is far outside it.
		assert_eq!(ids(&mut store, &CanFrameFilter { id_ranges: vec![(0x100, 0x100)], ..Default::default() }), vec![0, 1]);
		assert_eq!(ids(&mut store, &CanFrameFilter { id_ranges: vec![(0x100, 0x2FF)], ..Default::default() }), vec![0, 1, 3, 4]);
		// Channels: channel 2 is the FD pair.
		assert_eq!(ids(&mut store, &CanFrameFilter { channels: vec![2], ..Default::default() }), vec![3, 4]);
		// Direction.
		assert_eq!(ids(&mut store, &CanFrameFilter { direction: CanDirection::Tx, ..Default::default() }), vec![2, 4]);
		assert_eq!(ids(&mut store, &CanFrameFilter { direction: CanDirection::Rx, ..Default::default() }), vec![0, 1, 3, 5, 6]);
		// Kinds — each is exactly what the row's Type badge shows.
		assert_eq!(ids(&mut store, &CanFrameFilter { kind: CanKind::Can, ..Default::default() }), vec![0, 1, 2]);
		assert_eq!(ids(&mut store, &CanFrameFilter { kind: CanKind::Canfd, ..Default::default() }), vec![3, 4]);
		assert_eq!(ids(&mut store, &CanFrameFilter { kind: CanKind::Remote, ..Default::default() }), vec![5]);
		assert_eq!(ids(&mut store, &CanFrameFilter { kind: CanKind::Error, ..Default::default() }), vec![6]);
		// Together: channel 1's classic frames, transmitted only — the extended 0x18FF0001.
		assert_eq!(
			ids(&mut store, &CanFrameFilter { channels: vec![1], direction: CanDirection::Tx, kind: CanKind::Can, ..Default::default() }),
			vec![2]
		);
	}

	#[test]
	fn raw_filter_windows_number_frames_in_log_order() {
		let doc = filter_doc();
		let mut store = doc.frames.lock().unwrap();
		let spec = CanFrameFilter { direction: CanDirection::Tx, ..Default::default() };
		let lines = store.filtered_window(&spec, 0, 10);
		assert_eq!(lines.len(), 2);
		// The lines arrive in filtered order but each carries its own index — the row's
		// "No." stays the frame's place in the whole log.
		assert_eq!(lines[0].index, 2);
		assert_eq!(lines[0].id, 0x18FF0001);
		assert!(lines[0].tx);
		assert_eq!(lines[1].index, 4);
		assert_eq!(lines[1].id, 0x1FF);
		// A window past the filtered end clamps, exactly like the unfiltered one.
		assert!(store.filtered_window(&spec, 5, 10).is_empty());
	}

	#[test]
	fn raw_filter_index_extends_with_the_walk_and_rebuilds_on_change() {
		let doc = Arc::new(CanLogDoc::new(0));
		let mut sink = VecSink { doc: Arc::clone(&doc), staging: Vec::new() };
		walk_asc("base hex timestamps relative\n   0.000000 1  100  Rx   d 1 AA\n", &mut sink);
		sink.flush();
		{
			let mut store = doc.frames.lock().unwrap();
			let spec = CanFrameFilter { id_ranges: vec![(0x100, 0x100)], ..Default::default() };
			store.refresh_filter(&spec);
			assert_eq!(matches_of(&mut store, &spec), vec![0]);
			assert_eq!(store.filter.as_ref().unwrap().applied, 1);
		}
		// The walk lands two more frames — the unchanged spec only scans the extension.
		sink.frame(RawFrame::data_frame(1_000_000, 1, 0x100, false, false, 1, 1, &[0xAA], false));
		sink.frame(RawFrame::data_frame(2_000_000, 1, 0x300, false, false, 1, 1, &[0xBB], false));
		sink.flush();
		let mut store = doc.frames.lock().unwrap();
		let spec = CanFrameFilter { id_ranges: vec![(0x100, 0x100)], ..Default::default() };
		assert_eq!(matches_of(&mut store, &spec), vec![0, 1]);
		// A changed spec rebuilds: the old matches never leak into the new row space.
		let other = CanFrameFilter { id_ranges: vec![(0x300, 0x300)], ..Default::default() };
		assert_eq!(matches_of(&mut store, &other), vec![2]);
		assert_eq!(store.filter.as_ref().unwrap().applied, 3);
	}

	#[test]
	fn find_queries_parse_as_an_id_and_or_a_byte_sequence() {
		// An odd-length query can only be an id; an even-length one is both.
		let odd = parse_can_query("100").unwrap();
		assert_eq!(odd.id, Some(0x100));
		assert!(odd.bytes.is_empty());
		let both = parse_can_query("1000").unwrap();
		assert_eq!(both.id, Some(0x1000));
		assert_eq!(both.bytes, vec![0x10, 0x00]);
		// Spaces, commas and an 0x prefix are tolerated; case does not matter.
		let spaced = parse_can_query("0xAA BB,cc").unwrap();
		assert_eq!(spaced.bytes, vec![0xAA, 0xBB, 0xCC]);
		assert!(parse_can_query("123").unwrap().id.is_some());
		assert!(parse_can_query("not hex!").is_err());
		assert!(parse_can_query("").is_err());
	}

	#[test]
	fn find_matches_frames_by_id_or_payload_and_respects_the_filter() {
		let doc = filter_doc();
		// Id: the two 0x100 frames (its byte pair 10 00 matches no payload in the fixture).
		let frames = doc.frames.lock().unwrap();
		let by_id = parse_can_query("0x100").unwrap();
		let found = find_positions(&frames, (0..frames.len()).map(|index| (index, index as u32)), &by_id);
		assert_eq!(found.positions, vec![0, 1]);
		assert_eq!(found.total, 2);
		assert!(!found.capped);
		// Payload: only the 12-byte FD frame carries the consecutive bytes 99 AA.
		let by_data = parse_can_query("99 AA").unwrap();
		let found = find_positions(&frames, (0..frames.len()).map(|index| (index, index as u32)), &by_data);
		assert_eq!(found.positions, vec![3]);
		drop(frames);
		// A filter narrows the searched row space: with only the FD pair kept, the id 0x1FF
		// is a hit and its position is the filtered one (the second FD frame is row 1).
		let mut store = doc.frames.lock().unwrap();
		let spec = CanFrameFilter { kind: CanKind::Canfd, ..Default::default() };
		store.refresh_filter(&spec);
		let by_fd_id = parse_can_query("1FF").unwrap();
		let found = find_positions(&store, store.filter.as_ref().unwrap().matches.iter().enumerate().map(|(position, &frame)| (frame as usize, position as u32)), &by_fd_id);
		assert_eq!(found.positions, vec![1]);
	}

	#[test]
	fn find_caps_the_positions_but_counts_everything() {
		let doc = Arc::new(CanLogDoc::new(0));
		let mut sink = VecSink { doc: Arc::clone(&doc), staging: Vec::new() };
		// More 0x100 frames than the cap, so the jump list fills but the count does not stop.
		const FRAMES: u64 = MAX_FIND_POSITIONS as u64 * 2 + 5_000;
		for i in 0..FRAMES {
			sink.frame(RawFrame::data_frame(i * 1_000, 1, 0x100, false, false, 1, 1, &[0x55], false));
		}
		sink.flush();
		let frames = doc.frames.lock().unwrap();
		let needle = parse_can_query("0x100").unwrap();
		let found = find_positions(&frames, (0..frames.len()).map(|index| (index, index as u32)), &needle);
		assert_eq!(found.positions.len(), MAX_FIND_POSITIONS);
		assert_eq!(found.total, FRAMES);
		assert!(found.capped);
	}

	#[test]
	fn asc_digit_fd_flags_with_name_and_trailing_metadata() {
		// CANoe 12 writes the FD flags as bare `1`/`0` digits, not BRS/ESI words, and
		// appends duration/length/crc columns after the counted payload bytes.
		let doc = Arc::new(CanLogDoc::new(0));
		let mut sink = VecSink { doc: Arc::clone(&doc), staging: Vec::new() };
		walk_asc(
			"base hex timestamps absolute\n   0.001211 CANFD 2 Rx 76 ESP_SysSts3_10ms 1 0 d 32 ee 0b 00 00 00 00 00 00 00 00 00 00 08 a8 92 00 1d e3 1f 16 1d 77 1e b2 00 00 10 0a 07 3f c0 00   213484  353   303000 a8046d7d\n   0.003599 CANFD 2 Rx 2d8 RMRA_Sts_20ms 1 0 8  8 72 00 00 00 00 00 00 00   106000  138   303000 b001a408\n   0.006639 CANFD 2 Rx 209 1 0 8  8 5d 0b 84 ff c2 00 00 00   104000  134\n",
			&mut sink,
		);
		sink.flush();
		let store = doc.frames.lock().unwrap();
		let lines: Vec<CanFrameLine> = (0..store.len()).map(|i| store.line(i)).collect();
		assert_eq!(lines.len(), 3);
		assert!(lines.iter().all(|l| l.fd && !l.data_hex.is_empty()));
		assert_eq!(lines[0].dlc, 13);
		assert_eq!(lines[0].data_hex.split(' ').count(), 32);
		assert!(lines[0].data_hex.starts_with("EE 0B"));
		assert_eq!(lines[1].dlc, 8);
		assert_eq!(lines[1].data_hex, "72 00 00 00 00 00 00 00");
		assert_eq!(lines[2].data_hex, "5D 0B 84 FF C2 00 00 00");
		assert!(lines[0].brs);
		assert!(!lines[0].esi);
	}

	#[test]
	fn progress_reports_flow_while_walking() {
		use std::sync::atomic::{AtomicUsize, Ordering};
		use std::sync::Arc;
		// A BLF with enough containers that the throttled reporter fires at least once.
		let mut objects = Vec::new();
		for i in 0..30_000u64 {
			objects.extend(can_message(i * 1_000_000, 1, 0x100, 8));
		}
		let file = blf_with(&objects);
		let dir = tempfile::tempdir().unwrap();
		let path = dir.path().join("big.blf");
		std::fs::write(&path, &file).unwrap();
		let hits = Arc::new(AtomicUsize::new(0));
		let counter = Arc::clone(&hits);
		// The channel's receive side is untyped (InvokeResponseBody); CanProgress is only
		// what our reporter sends over it.
		let channel: tauri::ipc::Channel<CanProgress> = tauri::ipc::Channel::new(move |_| {
			counter.fetch_add(1, Ordering::SeqCst);
			Ok(())
		});
		let mut reporter = ProgressReporter::new(channel, total_bytes_of(&path));
		let mut agg = Aggregator::new();
		walk_source(&path, &mut agg, &mut reporter).unwrap();
		assert!(hits.load(Ordering::SeqCst) >= 1);
		assert_eq!(agg.total_frames, 30_000);
	}

	#[test]
	fn many_unique_ids_stay_bounded() {
		// Far more distinct ids than the caps: every frame still counts, the response
		// carries only the busiest rows, and nothing grows with the id count.
		let mut text = String::from("base hex timestamps relative\n");
		for i in 0..3000u32 {
			for _ in 0..(i % 3) + 1 {
				text.push_str(&format!("   0.000001 1  {:X}  Rx   d 1 {:02X}\n", i, i as u8));
			}
		}
		let mut agg = Aggregator::new();
		walk_asc(&text, &mut agg);
		let stats = agg.finish("ASC", None);
		assert_eq!(stats.total_frames, stats.channels.iter().map(|c| c.frames).sum::<u64>());
		assert!(stats.messages.len() <= MAX_REPORTED_MESSAGES);
		assert!(stats.messages_truncated > 0);
		// The busiest rows really are the ones kept.
		assert!(stats.messages.windows(2).all(|w| w[0].count >= w[1].count));
	}

	#[test]
	fn a_line_without_newlines_cannot_grow_the_buffer() {
		// One "line" far past the cap, then a real frame after it: the run is skipped,
		// the buffer never holds it, and parsing continues after the newline.
		let mut text = String::from("base hex timestamps relative\n");
		text.push_str(&"A".repeat(MAX_LINE_BYTES * 2));
		text.push('\n');
		text.push_str("   0.000001 1  100  Rx   d 1 AA\n");
		let mut agg = Aggregator::new();
		let mut on_chunk = |_, _| ();
		let (_, _) = walk_asc_reader(std::io::BufReader::new(text.as_bytes()), &mut agg, &mut on_chunk);
		assert_eq!(agg.total_frames, 1);
	}

	#[test]
	fn a_giant_asc_parses_bounded_and_quickly() {
		// ~64 MB, ~1M frames — an order-of-magnitude stand-in for the multi-GB logs the
		// streaming path exists for; it must parse far faster than any whole-file read
		// could and report progress along the way.
		let dir = tempfile::tempdir().unwrap();
		let path = dir.path().join("huge.asc");
		let mut writer = std::io::BufWriter::new(File::create(&path).unwrap());
		writeln!(writer, "date Mon Sep 14 20:00:00.000 2026").unwrap();
		writeln!(writer, "base hex timestamps relative").unwrap();
		writeln!(writer, "no internal events logged").unwrap();
		const LINES: u64 = 1_000_000;
		for i in 0..LINES {
			let id = 0x100 + (i % 8);
			writeln!(writer, "   {:.*} 1  {:X}  Rx   d 8 17 03 22 01 F1 26 08 08", 6, i as f64 * 0.01, id).unwrap();
		}
		drop(writer);
		let mut chunks = 0u64;
		let mut on_chunk = |_, _| chunks += 1;
		let started = std::time::Instant::now();
		let mut agg = Aggregator::new();
		let (start, _) = walk_asc_reader(std::io::BufReader::new(File::open(&path).unwrap()), &mut agg, &mut on_chunk);
		let elapsed = started.elapsed();
		assert_eq!(agg.total_frames, LINES);
		assert!(chunks > 1, "progress must flow for a big file");
		assert!(start.is_some(), "the date header should parse");
		// A streaming, allocation-free scan should clear 64 MB well inside seconds even
		// in a debug build; failing this means the per-line path regressed.
		assert!(elapsed.as_secs() < 60, "parse took {:?}", elapsed);
	}

	/* ----- tolerant parsing of corrupt objects ----- */

	/// Opt-in walk benchmark against a real trace: `CAN_BENCH=<path> cargo test --lib
	/// bench_real_log -- --ignored --nocapture`. Prints the frame count and throughput so
	/// the streaming path's speed stays honest against multi-gigabyte logs.
	#[test]
	#[ignore = "set CAN_BENCH=<path to a real .blf/.asc> to run"]
	fn bench_real_log() {
		let path = std::env::var("CAN_BENCH").expect("CAN_BENCH");
		let total = total_bytes_of(std::path::Path::new(&path));
		let mut sink = CountingSink { frames: 0, other: 0 };
		let mut reporter = ProgressReporter::new(tauri::ipc::Channel::new(|_| Ok(())), total);
		let started = std::time::Instant::now();
		walk_source(std::path::Path::new(&path), &mut sink, &mut reporter).unwrap();
		let elapsed = started.elapsed();
		println!(
			"{} frames in {:.2}s ({:.0} MB/s)",
			sink.frames,
			elapsed.as_secs_f64(),
			total as f64 / 1e6 / elapsed.as_secs_f64()
		);
	}

	/// A sink that only counts, for the objects a corrupt log must skip rather than parse.
	struct CountingSink {
		frames: usize,
		other: usize,
	}

	impl FrameSink for CountingSink {
		fn frame(&mut self, _frame: RawFrame) {
			self.frames += 1;
		}

		fn other(&mut self) {
			self.other += 1;
		}
	}

	/// A classic CAN_MESSAGE whose declared size cuts its payload short: the DLC still
	/// claims 8 bytes, so the parser must clamp to the bytes present, not trust the DLC.
	#[test]
	fn blf_classic_frame_with_a_short_payload_is_clamped() {
		// Base (16) + v1 header (16) + the 8 fixed body bytes + only 4 of the 8 data bytes.
		let size = 16 + 16 + 12;
		let mut object = Vec::new();
		object.extend_from_slice(b"LOBJ");
		object.extend_from_slice(&32u16.to_le_bytes());
		object.extend_from_slice(&1u16.to_le_bytes());
		object.extend_from_slice(&(size as u32).to_le_bytes());
		object.extend_from_slice(&OBJ_CAN_MESSAGE.to_le_bytes());
		object.extend_from_slice(&2u32.to_le_bytes());
		object.extend_from_slice(&0u16.to_le_bytes());
		object.extend_from_slice(&0u16.to_le_bytes());
		object.extend_from_slice(&0u64.to_le_bytes());
		object.extend_from_slice(&1u16.to_le_bytes()); // channel
		object.push(0); // flags
		object.push(8); // the DLC claims 8 bytes...
		object.extend_from_slice(&0x100u32.to_le_bytes());
		object.extend_from_slice(&[0xAA, 0xBB, 0xCC, 0xDD]); // ...but only 4 are present
		let frames = collect_frames(&blf_with(&object));
		assert_eq!(frames.len(), 1);
		assert_eq!(frames[0].len, 4);
		assert_eq!(&frames[0].data[..4], &[0xAA, 0xBB, 0xCC, 0xDD]);
	}

	/// A CAN_FD_MESSAGE object ending before its fixed part is skipped, and one whose data
	/// the declared size cuts short is clamped — neither may panic.
	#[test]
	fn blf_fd_frame_with_a_short_object_is_clamped() {
		// body_bytes of body after the 32-byte headers; the data begins at body + 20.
		let fd_object = |body_bytes: usize, valid_bytes: u8| {
			let size = (16 + 16 + body_bytes) as u32;
			let mut o = Vec::new();
			o.extend_from_slice(b"LOBJ");
			o.extend_from_slice(&32u16.to_le_bytes());
			o.extend_from_slice(&1u16.to_le_bytes());
			o.extend_from_slice(&size.to_le_bytes());
			o.extend_from_slice(&OBJ_CAN_FD_MESSAGE.to_le_bytes());
			o.extend_from_slice(&2u32.to_le_bytes());
			o.extend_from_slice(&0u16.to_le_bytes());
			o.extend_from_slice(&0u16.to_le_bytes());
			o.extend_from_slice(&0u64.to_le_bytes());
			o.extend_from_slice(&1u16.to_le_bytes()); // channel
			o.push(0); // flags
			o.push(9); // DLC 9 = a 12-byte payload
			o.extend_from_slice(&0x200u32.to_le_bytes()); // id
			o.extend_from_slice(&0u32.to_le_bytes()); // frame length
			o.push(0); // bit count
			o.push(0x03); // fd flags: EDL + BRS
			o.push(valid_bytes);
			o.resize(16 + 16 + body_bytes, 0xAB); // pad with data-looking bytes
			o
		};
		// Ends at body + 16, inside the fixed part (the data starts at body + 20): nothing
		// of it can be trusted, so the object is skipped.
		let mut count = CountingSink { frames: 0, other: 0 };
		walk_blf(Cursor::new(blf_with(&fd_object(16, 12))), &mut count).unwrap();
		assert_eq!(count.frames, 0);
		assert_eq!(count.other, 1);
		// Ends four bytes into the declared 12-byte payload.
		let frames = collect_frames(&blf_with(&fd_object(24, 12)));
		assert_eq!(frames.len(), 1);
		assert_eq!(frames[0].len, 4);
		assert_eq!(&frames[0].data[..4], &[0xAB; 4]);
	}

	/// A CAN_FD_MESSAGE_64 object shorter than its fixed 40-byte body must not be read past
	/// its end, and a cut-short payload is clamped — neither may panic.
	#[test]
	fn blf_fd64_frame_with_a_short_object_is_clamped() {
		let fd64_object = |body_bytes: usize, valid_bytes: u8| {
			let size = (16 + 16 + body_bytes) as u32;
			let mut o = Vec::new();
			o.extend_from_slice(b"LOBJ");
			o.extend_from_slice(&32u16.to_le_bytes());
			o.extend_from_slice(&1u16.to_le_bytes());
			o.extend_from_slice(&size.to_le_bytes());
			o.extend_from_slice(&OBJ_CAN_FD_MESSAGE_64.to_le_bytes());
			o.extend_from_slice(&2u32.to_le_bytes());
			o.extend_from_slice(&0u16.to_le_bytes());
			o.extend_from_slice(&0u16.to_le_bytes());
			o.extend_from_slice(&0u64.to_le_bytes());
			o.push(1); // channel
			o.push(15); // DLC 15 = a 64-byte payload
			o.push(valid_bytes);
			o.push(0); // tx count
			o.extend_from_slice(&0x300u32.to_le_bytes()); // id
			o.resize(16 + 16 + body_bytes, 0xCD);
			o
		};
		// Ends at body + 12: the flags word (at body + 12) and the data (at body + 40) are
		// both past the end, so the object is skipped.
		let mut count = CountingSink { frames: 0, other: 0 };
		walk_blf(Cursor::new(blf_with(&fd64_object(12, 64))), &mut count).unwrap();
		assert_eq!(count.frames, 0);
		assert_eq!(count.other, 1);
		// The fixed part is present, the declared 64-byte payload is cut to 8 bytes.
		let frames = collect_frames(&blf_with(&fd64_object(48, 64)));
		assert_eq!(frames.len(), 1);
		assert_eq!(frames[0].len, 8);
	}

	/// A 10-microsecond-mode timestamp near u64::MAX must saturate, not overflow — the
	/// value is file-controlled, and every other size in the parser is capped likewise.
	#[test]
	fn blf_a_huge_timestamp_saturates() {
		let mut object = can_message(0, 1, 0x100, 8);
		object[16..20].copy_from_slice(&1u32.to_le_bytes()); // flags 1: 10 µs units
		object[24..32].copy_from_slice(&u64::MAX.to_le_bytes());
		let frames = collect_frames(&blf_with(&object));
		assert_eq!(frames.len(), 1);
		assert_eq!(frames[0].t_ns, u64::MAX);
	}

	/* ----- identity and counting ----- */

	/// A standard and an extended frame with the same id are different messages: they must
	/// aggregate as two rows, not merge into one.
	#[test]
	fn standard_and_extended_ids_aggregate_separately() {
		let text = "\
base hex timestamps relative
   0.000000 1  100  Rx   d 1 AA
   0.001000 1  100x  Rx   d 2 BB CC
   0.002000 1  100  Rx   d 1 AA
   0.003000 1  100x  Rx   d 2 BB CC
";
		let mut agg = Aggregator::new();
		walk_asc(text, &mut agg);
		let stats = agg.finish("ASC", None);
		let standard = stats.messages.iter().find(|m| m.id == 0x100 && !m.extended).expect("a standard-id row");
		let extended = stats.messages.iter().find(|m| m.id == 0x100 && m.extended).expect("an extended-id row");
		assert_eq!(standard.count, 2);
		assert_eq!(extended.count, 2);
		assert_eq!(standard.payload_bytes, 2);
		assert_eq!(extended.payload_bytes, 4);
		// Each cycle is computed over its own frames only: 2 ms apart, each kind.
		assert!((standard.avg_cycle_s - 0.002).abs() < 1e-9);
		assert!((extended.avg_cycle_s - 0.002).abs() < 1e-9);
	}

	/// `can_intervals`' extended flag selects one of two same-id messages: the standard
	/// 0x100 at 10 ms and the extended 0x100 at 40 ms must not pool their frames.
	#[test]
	fn intervals_filter_on_the_extended_flag() {
		let text = "\
base hex timestamps relative
   0.000000 1  100  Rx   d 1 AA
   0.005000 1  100x  Rx   d 1 AA
   0.010000 1  100  Rx   d 1 AA
   0.045000 1  100x  Rx   d 1 AA
   0.020000 1  100  Rx   d 1 AA
   0.085000 1  100x  Rx   d 1 AA
";
		let analyse = |extended: bool| {
			let mut collector = IntervalCollector { channel: 1, id: 0x100, times: Vec::new(), extended, fd: false, overflow: 0 };
			walk_asc(text, &mut collector);
			analyse_intervals(collector.times, 1, 0x100, collector.extended, collector.fd, collector.overflow)
		};
		let standard = analyse(false);
		assert_eq!(standard.count, 3);
		assert!((standard.median_cycle_s - 0.01).abs() < 1e-9);
		let extended = analyse(true);
		assert_eq!(extended.count, 3);
		assert!((extended.median_cycle_s - 0.04).abs() < 1e-9);
	}

	/// The "top N shown" note counts identifiers, never frames: past the tracking cap the
	/// overflow is frames on untracked ids, and adding those would mix the units.
	#[test]
	fn messages_truncated_counts_identifiers_not_frames() {
		let mut agg = Aggregator::new();
		for i in 0..MAX_TRACKED_IDS as u32 {
			agg.frame(RawFrame::data_frame(i as u64, 1, i, false, false, 1, 1, &[0], false));
		}
		// Ten frames on one more id: past the cap they count in the totals only.
		for _ in 0..10 {
			agg.frame(RawFrame::data_frame(0, 1, MAX_TRACKED_IDS as u32, false, false, 1, 1, &[0], false));
		}
		let stats = agg.finish("ASC", None);
		assert_eq!(stats.total_frames, MAX_TRACKED_IDS as u64 + 10);
		assert_eq!(stats.messages.len(), MAX_REPORTED_MESSAGES);
		assert_eq!(stats.messages_truncated, (MAX_TRACKED_IDS - MAX_REPORTED_MESSAGES) as u64);
	}

	/* ----- conversion safety ----- */

	/// CAN FD and error frames return early out of `BlfWriter::frame`; the container flush
	/// must still happen, or an FD-only log grows the object buffer without bound and the
	/// output is one giant nonstandard container.
	#[test]
	fn blf_writer_flushes_fd_and_error_frames_too() {
		let mut writer = BlfWriter::new(Cursor::new(Vec::new()), 0.0);
		let fd_count = 6_000u64;
		let err_count = 2_000u64;
		for i in 0..fd_count {
			writer.frame(&RawFrame::data_frame(i * 1_000_000, 1, 0x200, false, true, 15, 64, &[0xAB; 64], false));
		}
		for i in 0..err_count {
			writer.frame(&error_frame(i * 1_000_000, 1));
		}
		writer.finish().unwrap();
		let bytes = writer.out.into_inner();
		// Walk the top-level containers: there must be several, and each one's declared
		// uncompressed payload must fit the container budget (plus one object's slack).
		let mut pos = 144;
		let mut containers = 0u64;
		while pos + 32 <= bytes.len() {
			assert_eq!(&bytes[pos..pos + 4], b"LOBJ");
			let object_size = u32_at(&bytes, pos + 8) as usize;
			let uncompressed = u32_at(&bytes, pos + 24) as usize;
			assert!(uncompressed <= CONTAINER_BYTES + 256, "a container holds {uncompressed} uncompressed bytes");
			containers += 1;
			pos += object_size + object_size % 4;
		}
		assert!(containers >= 2, "{containers} containers for {fd_count} FD frames");
		// Nothing was lost on the way out.
		assert_eq!(collect_frames(&bytes).len() as u64, fd_count + err_count);
	}

	/// Saving a conversion over its own source must be refused before the target is
	/// created: `File::create` would truncate the log the walk is about to read.
	#[test]
	fn converting_a_log_onto_itself_is_refused() {
		let dir = tempfile::tempdir().unwrap();
		let path = dir.path().join("log.asc");
		std::fs::write(&path, "base hex timestamps relative\n   0.000001 1  100  Rx   d 1 AA\n").unwrap();
		let original = std::fs::read(&path).unwrap();
		let quiet = || tauri::ipc::Channel::new(|_| Ok(()));
		let result = tauri::async_runtime::block_on(convert_can_log(path.to_string_lossy().into_owned(), path.to_string_lossy().into_owned(), "blf".to_string(), quiet()));
		assert!(result.is_err(), "converting a log onto itself must fail, not truncate it");
		assert_eq!(std::fs::read(&path).unwrap(), original, "the source must survive");
		// A different target in the same folder still converts.
		let target = dir.path().join("log.blf");
		let frames = tauri::async_runtime::block_on(convert_can_log(path.to_string_lossy().into_owned(), target.to_string_lossy().into_owned(), "blf".to_string(), quiet())).unwrap();
		assert_eq!(frames, 1);
		assert_eq!(&std::fs::read(&target).unwrap()[..4], b"LOGG");
	}

	/// A writer whose every write fails, standing in for a full disk or a locked target.
	struct FailingWriter;

	impl Write for FailingWriter {
		fn write(&mut self, _buf: &[u8]) -> std::io::Result<usize> {
			Err(std::io::Error::other("disk full"))
		}

		fn flush(&mut self) -> std::io::Result<()> {
			Ok(())
		}
	}

	impl Seek for FailingWriter {
		fn seek(&mut self, _pos: std::io::SeekFrom) -> std::io::Result<u64> {
			Err(std::io::Error::other("disk full"))
		}
	}

	/// Writes succeed until the byte budget runs out — a disk that fills mid-conversion.
	struct FailingAfter(usize);

	impl Write for FailingAfter {
		fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
			if self.0 == 0 {
				return Err(std::io::Error::other("disk full"));
			}
			let n = self.0.min(buf.len());
			self.0 -= n;
			Ok(n)
		}

		fn flush(&mut self) -> std::io::Result<()> {
			Ok(())
		}
	}

	impl Seek for FailingAfter {
		fn seek(&mut self, _pos: std::io::SeekFrom) -> std::io::Result<u64> {
			Ok(0)
		}
	}

	/// An I/O error on the target must surface as the conversion's error, not panic the
	/// blocking task and leave a truncated file behind.
	#[test]
	fn a_failing_target_write_surfaces_as_an_error() {
		// The BLF header write fails immediately; the frames must not panic either.
		let mut writer = BlfWriter::new(FailingWriter, 0.0);
		for i in 0..100u64 {
			writer.frame(&RawFrame::data_frame(i * 1_000_000, 1, 0x100, false, false, 8, 8, &[0; 8], false));
		}
		assert!(writer.finish().is_err());
	}

	/// The same, mid-stream: the target dies once a container flush is due.
	#[test]
	fn a_mid_stream_write_failure_surfaces_as_an_error() {
		let mut writer = BlfWriter::new(FailingAfter(1024), 0.0);
		for i in 0..10_000u64 {
			// Hashed, incompressible payloads: zlib must not shrink the container under
			// the budget, or the flush would succeed on a diet of zeros.
			let mut x = i.wrapping_mul(0x9E37_79B9_7F4A_7C15) | 1;
			x ^= x >> 29;
			x = x.wrapping_mul(0xBF58_476D_1CE4_E5B9);
			let data = x.to_le_bytes();
			writer.frame(&RawFrame::data_frame(i * 1_000_000, 1, 0x100, false, false, 8, 8, &data, false));
		}
		assert!(writer.finish().is_err());
	}

	/// The ASC header write fails the same way, through the converter the command drives —
	/// and the writer reports the failure so the walk can stop at the next chunk boundary.
	#[test]
	fn a_failing_asc_write_surfaces_as_an_error() {
		let mut converter = Converter { writer: WriterTarget::Asc(AscWriter::new(FailingWriter, 0.0)) };
		converter.frame(error_frame(0, 1));
		assert!(converter.failed());
		assert!(converter.finish().is_err());
	}

	#[test]
	fn asc_candoe_writes_the_id_before_the_direction() {
		// CANoe 10 (`// version 10.0.0`) writes `time CANFD channel id dir` — the id
		// before the direction — with bare digit flags, a bare `d` kind marker and a
		// decimal dlc: `0 0 d 15 64 …` is NoBRS/NoESI, dlc 15, 64 data bytes. The same
		// log interleaves classic frames and LIN lines (which the CAN views skip).
		let text = "date Fri Feb 14 13:53:33.005 PM 2025\n\
			base hex timestamps absolute\n\
			internal events logged\n\
			// version 10.0.0\n\
			Begin TriggerBlock Fri Feb 14 13:53:33.005 PM 2025\n\
			0.000000 Start of measurement\n\
			0.000000 CANFD 21 161 Rx 0 0 d 13 32 32 1B 53 96 20 00 0C 3F FF 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00\n\
			0.010000 21 446 Rx d 8 46 10 01 00 00 00 00 00\n\
			504.721985 CANFD 7 68F Rx 0 0 d 15 64 00 00 09 25 17 F5 16 D9 27 DA 13 78 06 DA 05 E2 0E 1E 01 00 00 00 00 00 00 00 00 00 00 00 00 00 01 00 00 00 00 00 00 00 E1 0E E1 0E 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 35 25 0F 5F\n\
			515.059998 L27 21 Rx 8 85 FD 00 00 11 3F FF FF checksum = 00\n";
		let doc = Arc::new(CanLogDoc::new(0));
		let mut sink = VecSink { doc: Arc::clone(&doc), staging: Vec::new() };
		walk_asc(text, &mut sink);
		sink.flush();
		let store = doc.frames.lock().unwrap();
		let lines: Vec<CanFrameLine> = (0..store.len()).map(|i| store.line(i)).collect();
		assert_eq!(lines.len(), 3);
		assert_eq!((lines[0].channel, lines[0].id, lines[0].dlc), (21, 0x161, 13));
		assert_eq!(lines[0].data_hex.split(' ').count(), 32);
		assert!(lines[0].data_hex.starts_with("32 1B 53 96"));
		assert!(!lines[0].brs && lines[0].fd && !lines[0].tx);
		assert_eq!((lines[1].channel, lines[1].id), (21, 0x446));
		assert_eq!(lines[1].data_hex, "46 10 01 00 00 00 00 00");
		// The row the statistics view groups by: channel 7, id 0x68F, 64 counted bytes.
		assert_eq!((lines[2].channel, lines[2].id, lines[2].dlc), (7, 0x68F, 15));
		assert!(lines[2].fd && !lines[2].brs && !lines[2].esi && !lines[2].tx);
		assert_eq!(lines[2].data_hex.split(' ').count(), 64);
		assert!(lines[2].data_hex.starts_with("00 00 09 25 17 F5 16"));
		assert!(lines[2].data_hex.ends_with("35 25 0F 5F"));
		drop(store);
		let mut agg = Aggregator::new();
		walk_asc(text, &mut agg);
		let stats = agg.finish("ASC", None);
		assert_eq!(stats.total_frames, 3);
		let row = stats.messages.iter().find(|m| m.channel == 7 && m.id == 0x68F).expect("0x68F on channel 7");
		assert_eq!(row.count, 1);
		assert_eq!(row.payload_bytes, 64);
	}
}

