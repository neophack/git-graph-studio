//! Media file metadata (module 7's media viewer): the container-level facts a video or
//! audio file carries — format, duration, bitrate, the video track's codec, resolution
//! and frame rate, the audio track's codec, sample rate, channel count and sample width.
//!
//! Pure header parsing over the common containers, every read bounded: MP4/MOV/M4A box
//! walk (moov wherever it sits — phone recordings put it at the tail), Matroska/WebM EBML,
//! RIFF (WAV and AVI), FLAC, MP3 (ID3 skip, frame headers, Xing frame count, CBR estimate)
//! and OGG (Vorbis / Opus / FLAC / Theora identification packets, granule-position tail
//! scan for the exact duration). An unrecognized container still answers (the format stays
//! unknown and the player element answers its own metadata), so no media file ever fails
//! to open for a parser gap.

use std::fs::File;
use std::io::{Read, Seek, SeekFrom};

use serde::{Deserialize, Serialize};

#[derive(Serialize, Deserialize, Default, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct VideoTrack {
    pub codec: Option<String>,
    pub width: Option<u32>,
    pub height: Option<u32>,
    pub fps: Option<f64>,
}

#[derive(Serialize, Deserialize, Default, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct AudioTrack {
    pub codec: Option<String>,
    pub sample_rate: Option<u32>,
    pub channels: Option<u16>,
    pub bits_per_sample: Option<u16>,
}

#[derive(Serialize, Deserialize, Default, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct MediaInfo {
    /// The container format as the information panel spells it ("MP4", "WebM", "WAV", …);
    /// `None` when the container was not one the parser knows.
    pub format: Option<String>,
    /// Total duration in milliseconds.
    pub duration_ms: Option<f64>,
    /// The average bitrate over the whole file (bytes × 8 / seconds).
    pub bitrate_bps: Option<u64>,
    pub size_bytes: u64,
    pub video: Option<VideoTrack>,
    pub audio: Option<AudioTrack>,
}

impl MediaInfo {
    fn new(format: &str, size: u64) -> Self {
        Self { format: Some(format.to_string()), size_bytes: size, ..Default::default() }
    }

    /// The overall bitrate when no container stated one: the file's bytes over its seconds.
    fn finish(&mut self) {
        if self.bitrate_bps.is_some() {
            return;
        }
        if let Some(ms) = self.duration_ms {
            let seconds = ms / 1000.0;
            if seconds > 0.0 && self.size_bytes > 0 {
                self.bitrate_bps = Some(((self.size_bytes as f64) * 8.0 / seconds) as u64);
            }
        }
    }
}

/// How much of a file the parsers ever hold in memory — the largest single read is an
/// MP4 `moov` (a few hundred KiB on a feature film), everything else is headers.
const MAX_READ: u64 = 8 * 1024 * 1024;
/// How far a scan may wander (an MP3 sync hunt) inside its head window.
const SCAN_LIMIT: usize = 64 * 1024;
/// How much the OGG tail scans look at for the last granule position.
const TAIL_BYTES: u64 = 256 * 1024;

pub fn probe(path: &str) -> Result<MediaInfo, String> {
    let mut file = File::open(path).map_err(|e| format!("{path}: {e}"))?;
    let size = file.metadata().map_err(|e| format!("{path}: {e}"))?.len();
    let head = read_at(&mut file, 0, 64 * 1024);
    let mut info = match head.get(0..12) {
        Some(bytes) if matches!(&bytes[4..8], b"ftyp" | b"moov" | b"mdat" | b"free" | b"skip" | b"wide") => probe_mp4(&mut file),
        Some(bytes) if bytes[0..4] == [0x1A, 0x45, 0xDF, 0xA3] => probe_ebml(&mut file, size),
        Some(bytes) if bytes[0..4] == *b"RIFF" && bytes[8..12] == *b"WAVE" => probe_wav(&head, size),
        Some(bytes) if bytes[0..4] == *b"RIFF" && bytes[8..12] == *b"AVI " => probe_avi(&head, size),
        Some(bytes) if bytes[0..4] == *b"fLaC" => probe_flac(&head, size),
        Some(bytes) if bytes[0..4] == *b"OggS" => probe_ogg(&mut file, size),
        _ => probe_mpeg_audio(&mut file, size),
    }?;
    if info.format.is_none() {
        info.format = Some("Unknown".to_string());
    }
    info.size_bytes = size;
    info.finish();
    Ok(info)
}

fn read_at(file: &mut File, offset: u64, len: u64) -> Vec<u8> {
    if file.seek(SeekFrom::Start(offset)).is_err() {
        return Vec::new();
    }
    let mut buf = vec![0u8; len.min(MAX_READ) as usize];
    let mut filled = 0;
    while filled < buf.len() {
        match file.read(&mut buf[filled..]) {
            Ok(0) => break,
            Ok(n) => filled += n,
            Err(_) => break,
        }
    }
    buf.truncate(filled);
    buf
}

// ---------------------------------------------------------------- MP4 / MOV / M4A

/// One box: its fourcc, its payload's byte range within the buffer being walked, and the
/// offset of the next box.
type BoxInfo<'a> = (&'a [u8], std::ops::Range<usize>, usize);

fn box_at(data: &[u8], pos: usize) -> Option<BoxInfo<'_>> {
    if data.len() < pos + 8 {
        return None;
    }
    let mut size = u32::from_be_bytes(data[pos..pos + 4].try_into().ok()?) as u64;
    let mut header = 8usize;
    if size == 1 {
        if data.len() < pos + 16 {
            return None;
        }
        // The 64-bit largesize counts the whole box, this 16-byte header included.
        size = u64::from_be_bytes(data[pos + 8..pos + 16].try_into().ok()?);
        header = 16;
    } else if size == 0 {
        size = (data.len() - pos) as u64;
    }
    if size < header as u64 {
        return None;
    }
    let end = pos + size.min((data.len() - pos) as u64) as usize;
    Some((&data[pos + 4..pos + 8], pos + header..end, pos + size as usize))
}

/// Fourcc as printable ASCII ("avc1", "Opus", "hvc1").
fn fourcc(bytes: &[u8]) -> String {
    bytes.iter().map(|&b| b as char).filter(|c| c.is_ascii_alphanumeric() || *c == '-').collect()
}

fn probe_mp4(file: &mut File) -> Result<MediaInfo, String> {
    let mut info = MediaInfo::default();
    let mut offset = 0u64;
    loop {
        let hdr = read_at(file, offset, 16);
        if hdr.len() < 8 {
            break;
        }
        let (header, size) = if hdr[0..4] == [0, 0, 0, 1] {
            if hdr.len() < 16 {
                break;
            }
            // The 64-bit largesize counts the whole box, its 16-byte header included.
            (16usize, u64::from_be_bytes(hdr[8..16].try_into().unwrap()))
        } else {
            let s = u32::from_be_bytes(hdr[0..4].try_into().unwrap()) as u64;
            if s == 0 {
                break; // the box runs to EOF: nothing further to walk past it
            }
            (8usize, s)
        };
        if &hdr[4..8] == b"moov" {
            let data = read_at(file, offset + header as u64, size.saturating_sub(header as u64));
            parse_moov(&data, &mut info);
            break;
        }
        if size <= header as u64 {
            break;
        }
        offset += size;
    }
    info.format = Some("MP4".to_string());
    Ok(info)
}

#[derive(Default)]
struct Mp4Track {
    is_video: bool,
    timescale: u32,
    duration: u64,
    frame_delta: u32,
    video: VideoTrack,
    audio: AudioTrack,
}

fn parse_moov(data: &[u8], info: &mut MediaInfo) {
    let mut pos = 0;
    let mut timescale = 0u32;
    let mut duration = 0u64;
    let mut tracks: Vec<Mp4Track> = Vec::new();
    while let Some((typ, payload, next)) = box_at(data, pos) {
        match typ {
            b"mvhd" => {
                let body = &data[payload];
                let (ts, dur) = match body.first() {
                    Some(&1) if body.len() >= 32 => {
                        (u32::from_be_bytes(body[20..24].try_into().unwrap()), u64::from_be_bytes(body[24..32].try_into().unwrap()))
                    }
                    _ if body.len() >= 20 => {
                        (u32::from_be_bytes(body[12..16].try_into().unwrap()), u32::from_be_bytes(body[16..20].try_into().unwrap()) as u64)
                    }
                    _ => (0, 0),
                };
                if ts > 0 {
                    timescale = ts;
                    duration = dur;
                }
            }
            b"trak" => {
                let mut track = Mp4Track::default();
                parse_trak(&data[payload], &mut track);
                tracks.push(track);
            }
            _ => {}
        }
        if next <= pos {
            break;
        }
        pos = next;
    }
    if timescale == 0 {
        // A fragmented recording (mvhd duration 0 or a bare moof stream): the first track
        // that carried a length stands in.
        for track in &tracks {
            if track.timescale > 0 && track.duration > 0 {
                timescale = track.timescale;
                duration = track.duration;
                break;
            }
        }
    }
    if timescale > 0 && duration > 0 {
        info.duration_ms = Some(duration as f64 * 1000.0 / timescale as f64);
    }
    for track in tracks.iter().filter(|t| t.is_video) {
        let mut video = track.video.clone();
        if track.timescale > 0 && track.frame_delta > 0 {
            video.fps = Some(track.timescale as f64 / track.frame_delta as f64);
        }
        if video.width.is_some() || video.codec.is_some() {
            info.video = Some(video);
            break;
        }
    }
    for track in tracks.iter().filter(|t| !t.is_video) {
        if track.audio.codec.is_some() || track.audio.sample_rate.is_some() {
            info.audio = Some(track.audio.clone());
            break;
        }
    }
}

fn parse_trak(data: &[u8], track: &mut Mp4Track) {
    let mut pos = 0;
    while let Some((typ, payload, next)) = box_at(data, pos) {
        match typ {
            b"tkhd" => {
                let body = &data[payload];
                let dims_at = match body.first() {
                    Some(&1) if body.len() >= 88 => Some(84),
                    _ if body.len() >= 80 => Some(76),
                    _ => None,
                };
                if let Some(at) = dims_at {
                    // The matrix's trailing 16.16 fixed-point pair.
                    let w = u32::from_be_bytes(body[at..at + 4].try_into().unwrap()) >> 16;
                    let h = u32::from_be_bytes(body[at + 4..at + 8].try_into().unwrap()) >> 16;
                    if w > 0 && h > 0 {
                        track.video.width = Some(w);
                        track.video.height = Some(h);
                    }
                }
            }
            b"mdia" => parse_mdia(&data[payload], track),
            _ => {}
        }
        if next <= pos {
            break;
        }
        pos = next;
    }
}

fn parse_mdia(data: &[u8], track: &mut Mp4Track) {
    let mut pos = 0;
    while let Some((typ, payload, next)) = box_at(data, pos) {
        match typ {
            b"mdhd" => {
                let body = &data[payload];
                let (ts, dur) = match body.first() {
                    Some(&1) if body.len() >= 32 => {
                        (u32::from_be_bytes(body[20..24].try_into().unwrap()), u64::from_be_bytes(body[24..32].try_into().unwrap()))
                    }
                    _ if body.len() >= 20 => {
                        (u32::from_be_bytes(body[12..16].try_into().unwrap()), u32::from_be_bytes(body[16..20].try_into().unwrap()) as u64)
                    }
                    _ => (0, 0),
                };
                if ts > 0 {
                    track.timescale = ts;
                    track.duration = dur;
                }
            }
            b"hdlr" => {
                // version/flags(4) + pre_defined(4), then the handler fourcc.
                let body = &data[payload];
                if body.len() >= 12 {
                    track.is_video = &body[8..12] == b"vide";
                }
            }
            b"minf" => parse_minf(&data[payload], track),
            _ => {}
        }
        if next <= pos {
            break;
        }
        pos = next;
    }
}

fn parse_minf(data: &[u8], track: &mut Mp4Track) {
    let mut pos = 0;
    while let Some((typ, payload, next)) = box_at(data, pos) {
        if typ == b"stbl" {
            parse_stbl(&data[payload], track);
        }
        if next <= pos {
            break;
        }
        pos = next;
    }
}

fn parse_stbl(data: &[u8], track: &mut Mp4Track) {
    let mut pos = 0;
    while let Some((typ, payload, next)) = box_at(data, pos) {
        match typ {
            b"stsd" => parse_stsd(&data[payload], track),
            b"stts" => {
                // The first time-to-sample delta: the frame period at the track's timescale.
                let body = &data[payload];
                if body.len() >= 16 {
                    let delta = u32::from_be_bytes(body[12..16].try_into().unwrap());
                    if delta > 0 {
                        track.frame_delta = delta;
                    }
                }
            }
            _ => {}
        }
        if next <= pos {
            break;
        }
        pos = next;
    }
}

fn parse_stsd(data: &[u8], track: &mut Mp4Track) {
    // After version/flags(4) + entry_count(4): the sample entries, each its own box whose
    // fourcc names the codec and whose fixed-layout body carries dims / rate / channels.
    let mut pos = 8;
    while pos + 16 <= data.len() {
        let entry_len = u32::from_be_bytes(data[pos..pos + 4].try_into().unwrap()) as usize;
        if entry_len < 16 || pos + entry_len > data.len() {
            break;
        }
        let codec_fourcc = fourcc(&data[pos + 4..pos + 8]);
        // `entry` excludes the box header: SampleEntry's 8 reserved/dri bytes sit at 0..8.
        let entry = &data[pos + 8..pos + entry_len];
        match codec_fourcc.as_str() {
            "avc1" | "avc3" => track.video.codec = Some("H.264".to_string()),
            "hvc1" | "hev1" => track.video.codec = Some("H.265".to_string()),
            "av01" => track.video.codec = Some("AV1".to_string()),
            "vp08" => track.video.codec = Some("VP8".to_string()),
            "vp09" => track.video.codec = Some("VP9".to_string()),
            "mp4v" => track.video.codec = Some("MPEG-4 Visual".to_string()),
            "mp4a" => track.audio.codec = Some("AAC".to_string()),
            "Opus" => track.audio.codec = Some("Opus".to_string()),
            "alac" => track.audio.codec = Some("ALAC".to_string()),
            "fLaC" => track.audio.codec = Some("FLAC".to_string()),
            "ac-3" => track.audio.codec = Some("AC-3".to_string()),
            "ec-3" => track.audio.codec = Some("E-AC-3".to_string()),
            "samr" => track.audio.codec = Some("AMR".to_string()),
            "lpcm" | "twos" | "sowt" | "in24" | "in32" | "fl32" | "fl64" => track.audio.codec = Some("PCM".to_string()),
            _ => {}
        }
        // VisualSampleEntry: pre_defined(2) reserved(2) pre_defined(12), then width/height.
        if entry.len() >= 28 {
            let w = u16::from_be_bytes(entry[24..26].try_into().unwrap()) as u32;
            let h = u16::from_be_bytes(entry[26..28].try_into().unwrap()) as u32;
            if w > 0 && h > 0 {
                track.video.width = Some(w);
                track.video.height = Some(h);
            }
        }
        // AudioSampleEntry: reserved[2](4) version(2) revision(2) vendor(4), then
        // channels(2) samplesize(2) …, the sample rate a 16.16 u32 at the tail.
        if entry.len() >= 32 {
            let channels = u16::from_be_bytes(entry[20..22].try_into().unwrap());
            let rate = u32::from_be_bytes(entry[28..32].try_into().unwrap()) >> 16;
            if channels > 0 {
                track.audio.channels = Some(channels);
            }
            if rate > 0 {
                track.audio.sample_rate = Some(rate);
            }
            let bits = u16::from_be_bytes(entry[22..24].try_into().unwrap());
            if bits > 0 && matches!(codec_fourcc.as_str(), "lpcm" | "twos" | "sowt" | "in24" | "in32" | "fl32" | "fl64") {
                track.audio.bits_per_sample = Some(bits);
            }
        }
        // An mp4a entry's `esds` names the elementary stream's real codec (mp4a may wrap
        // MP3 or AC-3, not only AAC).
        if codec_fourcc == "mp4a" {
            let mut child = 0;
            while let Some((typ, payload, next)) = box_at(entry, child) {
                if typ == b"esds" && parse_esds_codec(&entry[payload], &mut track.audio.codec) {
                    break;
                }
                if next <= child {
                    break;
                }
                child = next;
            }
        }
        pos += entry_len;
    }
}

/// The DecoderConfigDescriptor's objectTypeIndication, through the ES_Descriptor that
/// always precedes it. True when the codec was refined.
fn parse_esds_codec(data: &[u8], codec: &mut Option<String>) -> bool {
    if data.len() < 6 {
        return false;
    }
    let mut at = 4; // version/flags
    if data[at] != 0x03 {
        return false;
    }
    at += 1;
    let (len, bytes) = match descriptor_len(data, at) {
        Some(v) => v,
        None => return false,
    };
    // ES_Descriptor: ES_ID(2) + flags… then the DecoderConfigDescriptor's tag.
    at = at + bytes + len.min((data.len() - at - bytes) as u32) as usize;
    if at >= data.len() || data[at] != 0x04 {
        return false;
    }
    at += 1;
    let (_len, bytes) = match descriptor_len(data, at) {
        Some(v) => v,
        None => return false,
    };
    at += bytes;
    let Some(&object_type) = data.get(at) else {
        return false;
    };
    match object_type {
        0x40 => *codec = Some("AAC".to_string()),
        0x66..=0x68 | 0x69 | 0x6B => *codec = Some("MP3".to_string()),
        0xA5 => *codec = Some("AC-3".to_string()),
        0xA9 => *codec = Some("E-AC-3".to_string()),
        _ => {}
    }
    true
}

/// An MP4 descriptor's expansion-form length: the value and the bytes it took.
fn descriptor_len(data: &[u8], at: usize) -> Option<(u32, usize)> {
    let mut value = 0u32;
    let mut consumed = 0;
    let mut cursor = at;
    while consumed < 4 {
        let byte = *data.get(cursor)?;
        value = (value << 7) | (byte & 0x7F) as u32;
        consumed += 1;
        cursor += 1;
        if byte & 0x80 == 0 {
            return Some((value, consumed));
        }
    }
    None
}

// ---------------------------------------------------------------- Matroska / WebM

fn read_vint(data: &[u8], at: usize, keep_marker: bool) -> Option<(u64, usize)> {
    let first = *data.get(at)?;
    if first == 0 {
        return None;
    }
    let len = first.leading_zeros() as usize + 1;
    if len > 8 || at + len > data.len() {
        return None;
    }
    let mut value = if keep_marker { first as u64 } else { (first & (0xFFu8 >> len)) as u64 };
    for byte in &data[at + 1..at + len] {
        value = (value << 8) | *byte as u64;
    }
    Some((value, len))
}

/// An element value: plain big-endian bytes of the declared width (Matroska values are
/// not vints — only lengths and ids are).
fn read_uint(data: &[u8], at: usize, width: usize) -> Option<u64> {
    if at + width > data.len() || width > 8 {
        return None;
    }
    let mut value = 0u64;
    for byte in &data[at..at + width] {
        value = (value << 8) | *byte as u64;
    }
    Some(value)
}

/// Whether a varint's value is the all-ones "unknown length" marker for its width.
fn is_unknown_len(len: u64, len_bytes: usize) -> bool {
    len == (1u64 << (7 * len_bytes)) - 1
}

fn probe_ebml(file: &mut File, size: u64) -> Result<MediaInfo, String> {
    let mut info = MediaInfo::new("Matroska", size);
    // Past the EBML header element sits the Segment; only its Info and Tracks are ever
    // pulled whole, everything else (Cluster payloads above all) is skipped by size.
    let head = read_at(file, 0, 1024);
    let Some((_, header_id_len)) = read_vint(&head, 0, true) else {
        return Ok(info);
    };
    let Some((header_len, header_len_bytes)) = read_vint(&head, header_id_len, false) else {
        return Ok(info);
    };
    if is_unknown_len(header_len, header_len_bytes) {
        return Ok(info);
    }
    let cursor = (header_id_len + header_len_bytes) as u64 + header_len;
    let hdr = read_at(file, cursor, 24);
    let Some((id, id_len)) = read_vint(&hdr, 0, true) else {
        return Ok(info);
    };
    if id != 0x18538067 {
        return Ok(info); // not a Matroska Segment
    }
    let Some((segment_len, len_bytes)) = read_vint(&hdr, id_len, false) else {
        return Ok(info);
    };
    if is_unknown_len(segment_len, len_bytes) {
        return Ok(info); // a streamed segment has no end to walk to
    }
    let segment_start = cursor + (id_len + len_bytes) as u64;
    walk_ebml_children(file, segment_start, (segment_start + segment_len).min(size), &mut info);
    Ok(info)
}

/// The Segment's children, header-by-header: each header is a handful of bytes, so a
/// multi-gigabyte file costs a few reads.
fn walk_ebml_children(file: &mut File, from: u64, until: u64, info: &mut MediaInfo) {
    let mut next = from;
    while next < until {
        let hdr = read_at(file, next, 24);
        let Some((id, id_len)) = read_vint(&hdr, 0, true) else {
            break;
        };
        let Some((len, len_bytes)) = read_vint(&hdr, id_len, false) else {
            break;
        };
        let payload_at = next + (id_len + len_bytes) as u64;
        if is_unknown_len(len, len_bytes) {
            break;
        }
        if id == 0x1549A966 {
            parse_ebml_info(&read_at(file, payload_at, len.min(MAX_READ)), info);
        } else if id == 0x1654AE6B {
            parse_ebml_tracks(&read_at(file, payload_at, len.min(MAX_READ)), info);
        }
        if len == 0 {
            break;
        }
        next = payload_at + len;
    }
}

fn parse_ebml_info(data: &[u8], info: &mut MediaInfo) {
    let mut timescale = 1_000_000u64;
    let mut duration = 0f64;
    let mut pos = 0;
    while pos < data.len() {
        let Some((id, id_len)) = read_vint(data, pos, true) else {
            break;
        };
        let Some((len, len_bytes)) = read_vint(data, pos + id_len, false) else {
            break;
        };
        let payload = (pos + id_len + len_bytes) as u64;
        let end = (payload + len).min(data.len() as u64) as usize;
        let bytes = &data[payload.min(data.len() as u64) as usize..end];
        match id {
            0x2AD7B1 => {
                if let Some(v) = read_uint(bytes, 0, bytes.len()) {
                    if v > 0 {
                        timescale = v;
                    }
                }
            }
            0x4489 => {
                if let Some(v) = ebml_float(bytes) {
                    duration = v;
                }
            }
            _ => {}
        }
        if payload <= pos as u64 {
            break;
        }
        pos = end;
    }
    if duration > 0.0 && timescale > 0 {
        info.duration_ms = Some(duration * timescale as f64 / 1_000_000.0);
    }
}

fn ebml_float(bytes: &[u8]) -> Option<f64> {
    match bytes.len() {
        4 => Some(f32::from_be_bytes(bytes.try_into().ok()?) as f64),
        8 => Some(f64::from_be_bytes(bytes.try_into().ok()?)),
        _ => None,
    }
}

fn parse_ebml_tracks(data: &[u8], info: &mut MediaInfo) {
    let mut pos = 0;
    while pos < data.len() {
        let Some((id, id_len)) = read_vint(data, pos, true) else {
            break;
        };
        let Some((len, len_bytes)) = read_vint(data, pos + id_len, false) else {
            break;
        };
        let payload = (pos + id_len + len_bytes) as u64;
        let end = (payload + len).min(data.len() as u64) as usize;
        if id == 0xAE && payload < end as u64 {
            let mut kind = 0u64;
            let mut video = VideoTrack::default();
            let mut audio = AudioTrack::default();
            parse_track_entry(&data[payload as usize..end], &mut kind, &mut video, &mut audio);
            match kind {
                1 => {
                    if info.video.is_none() && (video.codec.is_some() || video.width.is_some()) {
                        info.video = Some(video);
                    }
                }
                2 if info.audio.is_none() && (audio.codec.is_some() || audio.sample_rate.is_some()) => {
                    info.audio = Some(audio);
                }
                _ => {}
            }
        }
        if payload <= pos as u64 {
            break;
        }
        pos = end;
    }
}

fn parse_track_entry(data: &[u8], kind: &mut u64, video: &mut VideoTrack, audio: &mut AudioTrack) {
    let mut pos = 0;
    while pos < data.len() {
        let Some((id, id_len)) = read_vint(data, pos, true) else {
            break;
        };
        let Some((len, len_bytes)) = read_vint(data, pos + id_len, false) else {
            break;
        };
        let payload = (pos + id_len + len_bytes) as u64;
        let end = (payload + len).min(data.len() as u64) as usize;
        let bytes = &data[payload.min(data.len() as u64) as usize..end];
        match id {
            0x83 => *kind = read_uint(bytes, 0, bytes.len()).unwrap_or(0),
            0x86 => match String::from_utf8_lossy(bytes).as_ref() {
                "V_VP8" => video.codec = Some("VP8".to_string()),
                "V_VP9" | "V_VP10" => video.codec = Some("VP9".to_string()),
                "V_AV1" => video.codec = Some("AV1".to_string()),
                "V_MPEG4/ISO/AVC" => video.codec = Some("H.264".to_string()),
                "V_MPEGH/ISO/HEVC" => video.codec = Some("H.265".to_string()),
                "A_OPUS" => audio.codec = Some("Opus".to_string()),
                "A_AAC" => audio.codec = Some("AAC".to_string()),
                "A_MPEG/L3" => audio.codec = Some("MP3".to_string()),
                "A_FLAC" => audio.codec = Some("FLAC".to_string()),
                "A_AC3" => audio.codec = Some("AC-3".to_string()),
                "A_EAC3" => audio.codec = Some("E-AC-3".to_string()),
                "A_VORBIS" => audio.codec = Some("Vorbis".to_string()),
                "A_PCM/INT/LIT" | "A_PCM/INT/BIG" | "A_PCM/FLOAT/IEEE" => audio.codec = Some("PCM".to_string()),
                _ => {}
            },
            0xE0 => {
                let mut p = 0;
                while p < bytes.len() {
                    let Some((eid, il)) = read_vint(bytes, p, true) else {
                        break;
                    };
                    let Some((elen, elb)) = read_vint(bytes, p + il, false) else {
                        break;
                    };
                    let at = p + il + elb;
                    let stop = (at as u64 + elen).min(bytes.len() as u64) as usize;
                    let val = &bytes[at.min(bytes.len())..stop];
                    match eid {
                        0xB0 => video.width = read_uint(val, 0, val.len()).map(|v| v as u32).filter(|&v| v > 0),
                        0xBA => video.height = read_uint(val, 0, val.len()).map(|v| v as u32).filter(|&v| v > 0),
                        _ => {}
                    }
                    if at <= p {
                        break;
                    }
                    p = stop;
                }
            }
            0xE1 => {
                let mut p = 0;
                while p < bytes.len() {
                    let Some((eid, il)) = read_vint(bytes, p, true) else {
                        break;
                    };
                    let Some((elen, elb)) = read_vint(bytes, p + il, false) else {
                        break;
                    };
                    let at = p + il + elb;
                    let stop = (at as u64 + elen).min(bytes.len() as u64) as usize;
                    let val = &bytes[at.min(bytes.len())..stop];
                    match eid {
                        0xB5 => audio.sample_rate = ebml_float(val).map(|f| f.round() as u32).filter(|&r| r > 0),
                        0x9F => audio.channels = read_uint(val, 0, val.len()).map(|v| v as u16).filter(|&v| v > 0),
                        0x62A8 => audio.bits_per_sample = read_uint(val, 0, val.len()).map(|v| v as u16).filter(|&v| v > 0),
                        _ => {}
                    }
                    if at <= p {
                        break;
                    }
                    p = stop;
                }
            }
            _ => {}
        }
        if payload <= pos as u64 {
            break;
        }
        pos = end;
    }
}

// ---------------------------------------------------------------- RIFF (WAV, AVI)

fn probe_wav(head: &[u8], size: u64) -> Result<MediaInfo, String> {
    let mut info = MediaInfo::new("WAV", size);
    let mut channels = 0u16;
    let mut sample_rate = 0u32;
    let mut bits = 0u16;
    let mut byte_rate = 0u32;
    let mut codec = String::from("PCM");
    let mut data_len = 0u64;
    let mut pos = 12usize;
    while pos + 8 <= head.len() {
        let typ = &head[pos..pos + 4];
        let declared = u32::from_le_bytes(head[pos + 4..pos + 8].try_into().unwrap()) as u64;
        let payload = &head[pos + 8..(pos + 8).saturating_add(declared as usize).min(head.len())];
        match typ {
            b"fmt " if payload.len() >= 16 => {
                let tag = u16::from_le_bytes(payload[0..2].try_into().unwrap());
                channels = u16::from_le_bytes(payload[2..4].try_into().unwrap());
                sample_rate = u32::from_le_bytes(payload[4..8].try_into().unwrap());
                byte_rate = u32::from_le_bytes(payload[8..12].try_into().unwrap());
                bits = u16::from_le_bytes(payload[14..16].try_into().unwrap());
                codec = match tag {
                    0x0001 => "PCM".to_string(),
                    0x0003 => "IEEE Float".to_string(),
                    0x0006 => "A-law".to_string(),
                    0x0007 => "μ-law".to_string(),
                    0xFFFE => "Extensible".to_string(),
                    _ => format!("WAVE 0x{tag:04X}"),
                };
            }
            b"data" => data_len = declared, // the declared length, not the windowed read
            _ => {}
        }
        if declared == 0 {
            break;
        }
        pos += 8 + declared as usize + (declared as usize & 1);
    }
    if channels > 0 {
        info.audio = Some(AudioTrack {
            codec: Some(codec),
            sample_rate: (sample_rate > 0).then_some(sample_rate),
            channels: Some(channels),
            bits_per_sample: (bits > 0).then_some(bits),
        });
    }
    let rate = if byte_rate > 0 {
        byte_rate as f64
    } else {
        (channels as u32 * sample_rate * bits as u32 / 8) as f64
    };
    if data_len > 0 && rate > 0.0 {
        info.duration_ms = Some(data_len as f64 * 1000.0 / rate);
    }
    Ok(info)
}

#[derive(Default)]
struct AviState {
    width: u32,
    height: u32,
    fps: f64,
    micro_per_frame: u32,
    total_frames: u64,
    stream_frames: u64,
    /// The strl the current strf belongs to ('vids' or 'auds'), strh's fccType.
    stream_type: [u8; 4],
    video_codec: Option<String>,
    audio: AudioTrack,
    have_audio: bool,
}

fn probe_avi(head: &[u8], size: u64) -> Result<MediaInfo, String> {
    let mut state = AviState::default();
    walk_avi(head, 12, head.len(), 0, &mut state);
    let mut info = MediaInfo::new("AVI", size);
    if state.width > 0 || state.height > 0 || state.fps > 0.0 {
        info.video = Some(VideoTrack {
            codec: state.video_codec,
            width: (state.width > 0).then_some(state.width),
            height: (state.height > 0).then_some(state.height),
            fps: (state.fps > 0.0).then_some(state.fps),
        });
    }
    if state.have_audio && state.audio.sample_rate.unwrap_or(0) > 0 {
        info.audio = Some(state.audio);
    }
    let frames = if state.total_frames > 0 { state.total_frames } else { state.stream_frames };
    if frames > 0 && state.fps > 0.0 {
        info.duration_ms = Some(frames as f64 * 1000.0 / state.fps);
    }
    Ok(info)
}

/// The hdrl tree's chunk walk, depth-limited: `LIST hdrl` nests `LIST strl`, whose strh /
/// strf chunks carry the streams' facts.
fn walk_avi(data: &[u8], start: usize, end: usize, depth: u32, state: &mut AviState) {
    let mut pos = start;
    while pos + 8 <= end {
        let typ = &data[pos..pos + 4];
        let len = u32::from_le_bytes(data[pos + 4..pos + 8].try_into().unwrap()) as usize;
        let chunk_end = (pos + 8 + len).min(end);
        if typ == b"LIST" && chunk_end >= pos + 16 {
            let kind = &data[pos + 8..pos + 12];
            if (kind == b"hdrl" || kind == b"strl") && depth < 6 {
                walk_avi(data, pos + 12, chunk_end, depth + 1, state);
            }
        } else {
            avi_chunk(state, typ, &data[pos + 8..chunk_end]);
        }
        if len == 0 {
            break;
        }
        pos += 8 + len + (len & 1);
    }
}

fn avi_chunk(state: &mut AviState, typ: &[u8], payload: &[u8]) {
    match typ {
        b"avih" if payload.len() >= 40 => {
            state.micro_per_frame = u32::from_le_bytes(payload[0..4].try_into().unwrap());
            state.total_frames = u32::from_le_bytes(payload[16..20].try_into().unwrap()) as u64;
            state.width = u32::from_le_bytes(payload[32..36].try_into().unwrap());
            state.height = u32::from_le_bytes(payload[36..40].try_into().unwrap());
            if state.micro_per_frame > 0 {
                state.fps = 1_000_000.0 / state.micro_per_frame as f64;
            }
        }
        b"strh" if payload.len() >= 48 => {
            state.stream_type.copy_from_slice(&payload[0..4]);
            let scale = u32::from_le_bytes(payload[20..24].try_into().unwrap());
            let rate = u32::from_le_bytes(payload[24..28].try_into().unwrap());
            let length = u32::from_le_bytes(payload[32..36].try_into().unwrap()) as u64;
            if state.stream_type == *b"vids" {
                if scale > 0 && rate > 0 {
                    state.fps = rate as f64 / scale as f64;
                }
                if state.total_frames == 0 {
                    state.stream_frames = length;
                }
                let handler = fourcc(&payload[4..8]);
                if !handler.is_empty() {
                    state.video_codec = Some(handler);
                }
            } else if state.stream_type == *b"auds" && scale > 0 && rate > 0 {
                state.audio.sample_rate = Some(rate / scale);
                state.have_audio = true;
            }
        }
        b"strf" => {
            if state.stream_type == *b"vids" {
                // BITMAPINFOHEADER: biCompression fourcc at +16 (biSize, biWidth, biHeight
                // before it). biCompression 0 = raw RGB.
                if payload.len() >= 20 {
                    let comp = fourcc(&payload[16..20]);
                    if !comp.is_empty() && comp != "0" {
                        state.video_codec = Some(comp);
                    }
                    if state.width == 0 {
                        state.width = i32::from_le_bytes(payload[4..8].try_into().unwrap()).unsigned_abs();
                    }
                    if state.height == 0 {
                        state.height = i32::from_le_bytes(payload[8..12].try_into().unwrap()).unsigned_abs();
                    }
                }
            } else if state.stream_type == *b"auds" && payload.len() >= 16 {
                // WAVEFORMATEX.
                state.audio.channels = Some(u16::from_le_bytes(payload[2..4].try_into().unwrap()));
                state.audio.sample_rate = Some(u32::from_le_bytes(payload[4..8].try_into().unwrap()));
                state.audio.bits_per_sample = Some(u16::from_le_bytes(payload[14..16].try_into().unwrap()));
                state.have_audio = true;
            }
        }
        _ => {}
    }
}

// ---------------------------------------------------------------- FLAC

fn probe_flac(head: &[u8], size: u64) -> Result<MediaInfo, String> {
    let mut info = MediaInfo::new("FLAC", size);
    let mut pos = 4;
    while pos + 4 <= head.len() {
        let header = head[pos];
        let is_last = header & 0x80 != 0;
        let block_type = header & 0x7F;
        let len = u32::from_be_bytes([0, head[pos + 1], head[pos + 2], head[pos + 3]]) as usize;
        if block_type == 0 {
            if let Some(payload) = head.get(pos + 4..pos + 4 + len) {
                if parse_flac_streaminfo(payload, &mut info) {
                    break;
                }
            }
        }
        if len == 0 || is_last {
            break;
        }
        pos += 4 + len;
    }
    Ok(info)
}

/// STREAMINFO's packed fields: 20 bits of rate, 3+1 of channels, 5+1 of width, 36 of
/// total samples, over the last 8 bytes of the 34-byte block.
fn parse_flac_streaminfo(data: &[u8], info: &mut MediaInfo) -> bool {
    if data.len() < 18 {
        return false;
    }
    let bits = u64::from_be_bytes(data[10..18].try_into().unwrap());
    let sample_rate = (bits >> 44) as u32;
    let channels = (((bits >> 41) & 0x7) + 1) as u16;
    let bits_per_sample = (((bits >> 36) & 0x1F) + 1) as u16;
    let total_samples = bits & 0xF_FFFF_FFFF;
    if sample_rate == 0 {
        return false;
    }
    info.audio = Some(AudioTrack {
        codec: Some("FLAC".to_string()),
        sample_rate: Some(sample_rate),
        channels: Some(channels),
        bits_per_sample: Some(bits_per_sample),
    });
    if total_samples > 0 {
        info.duration_ms = Some(total_samples as f64 * 1000.0 / sample_rate as f64);
    }
    true
}


// ---------------------------------------------------------------- MP3

fn probe_mpeg_audio(file: &mut File, size: u64) -> Result<MediaInfo, String> {
    let head = read_at(file, 0, TAIL_BYTES);
    let start = id3_size(&head);
    let Some((b1, b2, b3)) = find_mpeg_frame(&head, start) else {
        return Ok(MediaInfo::default()); // no frame header: the format stays unknown
    };
    let mut info = MediaInfo::new("MP3", size);
    let version = (b1 >> 3) & 0x3;
    let br_idx = (b2 >> 4) & 0xF;
    let sr_idx = (b2 >> 2) & 0x3;
    let rates: [u32; 3] = match version {
        0x3 => [44_100, 48_000, 32_000],
        0x2 => [22_050, 24_000, 16_000],
        _ => [11_025, 12_000, 8_000],
    };
    let kbps: [u32; 15] = match version {
        0x3 => [32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 0],
        _ => [8, 16, 24, 32, 40, 48, 64, 80, 96, 112, 128, 144, 160, 0, 0],
    };
    let bitrate = kbps[(br_idx - 1) as usize];
    let sample_rate = rates[sr_idx as usize];
    let channels = if b3 & 0xC0 == 0xC0 { 1 } else { 2 };
    info.audio = Some(AudioTrack {
        codec: Some("MP3".to_string()),
        sample_rate: Some(sample_rate),
        channels: Some(channels),
        bits_per_sample: None,
    });
    let body = size.saturating_sub(start as u64);
    let frames = xing_frames(&head, start, version, channels);
    if let Some(count) = frames {
        let per_frame = if version == 0x3 { 1152.0 } else { 576.0 };
        info.duration_ms = Some(count as f64 * 1000.0 * per_frame / sample_rate as f64);
    } else if bitrate > 0 && body > 0 {
        // A constant-bitrate estimate over the frame data's bytes (the bitrate is kbit/s).
        info.duration_ms = Some(body as f64 * 8.0 * 1000.0 / (bitrate as f64 * 1000.0));
    }
    Ok(info)
}

/// The first frame header's bytes 1–3 after `from` (the sync byte itself is byte 0).
fn find_mpeg_frame(head: &[u8], from: usize) -> Option<(u8, u8, u8)> {
    let limit = head.len().saturating_sub(4).min(from + SCAN_LIMIT);
    let mut at = from;
    while at < limit {
        let b1 = head[at + 1];
        let b2 = head[at + 2];
        let b3 = head[at + 3];
        if head[at] == 0xFF && b1 & 0xE0 == 0xE0 {
            let version = (b1 >> 3) & 0x3;
            let layer = (b1 >> 1) & 0x3;
            let br_idx = (b2 >> 4) & 0xF;
            let sr_idx = (b2 >> 2) & 0x3;
            // Layer III, a known bitrate and a known rate: a real frame header (version 01
            // is reserved).
            if version != 0x1 && layer == 0x1 && (0x1..0xF).contains(&br_idx) && sr_idx != 0x3 {
                return Some((b1, b2, b3));
            }
        }
        at += 1;
    }
    None
}

/// The Xing/Info frame's stored frame count (the exact duration), when the first frame
/// carries one.
fn xing_frames(head: &[u8], frame_at: usize, version: u8, channels: u16) -> Option<u64> {
    // The side information's length decides where the Xing tag sits.
    let side = match (version, channels) {
        (0x3, 2) => 32,
        (0x3, 1) => 17,
        (_, 2) => 8,
        _ => 9,
    };
    let tag_at = frame_at + 4 + side;
    let tag = head.get(tag_at..tag_at + 4)?;
    if tag != b"Xing" && tag != b"Info" {
        return None;
    }
    let flags = u32::from_be_bytes(head.get(tag_at + 4..tag_at + 8)?.try_into().ok()?);
    if flags & 0x1 == 0 {
        return None;
    }
    let frames = u32::from_be_bytes(head.get(tag_at + 8..tag_at + 12)?.try_into().ok()?);
    Some(frames as u64)
}

/// The ID3v2 tag's total length (a syncsafe 28-bit count), 0 without one.
fn id3_size(head: &[u8]) -> usize {
    if head.get(0..3) != Some(b"ID3".as_slice()) {
        return 0;
    }
    let size = ((head[6] as usize & 0x7F) << 21)
        | ((head[7] as usize & 0x7F) << 14)
        | ((head[8] as usize & 0x7F) << 7)
        | (head[9] as usize & 0x7F);
    size + 10
}

// ---------------------------------------------------------------- OGG

fn probe_ogg(file: &mut File, size: u64) -> Result<MediaInfo, String> {
    let mut info = MediaInfo::new("OGG", size);
    let head = read_at(file, 0, 64 * 1024);
    // The identification packet rides the first page's payload, right after its header.
    if let Some(payload) = ogg_first_packet(&head) {
        let codec = payload.get(0..8);
        match codec {
            Some(b"\x01vorbis\x00") if payload.len() >= 28 => {
                let channels = payload[11] as u16;
                let rate = u32::from_le_bytes(payload[12..16].try_into().unwrap());
                info.audio = Some(AudioTrack {
                    codec: Some("Vorbis".to_string()),
                    sample_rate: (rate > 0).then_some(rate),
                    channels: (channels > 0).then_some(channels),
                    bits_per_sample: None,
                });
                if rate > 0 {
                    if let Some(granule) = last_granule(file, size) {
                        info.duration_ms = Some(granule as f64 * 1000.0 / rate as f64);
                    }
                }
            }
            Some(b"OpusHead") => {
                let channels = payload[9] as u16;
                info.audio = Some(AudioTrack {
                    codec: Some("Opus".to_string()),
                    // Opus is decoded at 48 kHz; the header's rate names the source's own.
                    sample_rate: Some(48_000),
                    channels: (channels > 0).then_some(channels),
                    bits_per_sample: None,
                });
                if let Some(granule) = last_granule(file, size) {
                    let pre_skip = u16::from_le_bytes(payload[10..12].try_into().unwrap()) as u64;
                    info.duration_ms = Some(granule.saturating_sub(pre_skip) as f64 * 1000.0 / 48_000.0);
                }
            }
            Some(b"fLaC\x00\x00") => {
                // FLAC-in-OGG: the STREAMINFO block (header included) follows the marker.
                if payload.len() >= 26 && parse_flac_streaminfo(&payload[4..], &mut info) {
                    let rate = info.audio.as_ref().and_then(|a| a.sample_rate).unwrap_or(0);
                    if rate > 0 {
                        if let Some(granule) = last_granule(file, size) {
                            info.duration_ms = Some(granule as f64 * 1000.0 / rate as f64);
                        }
                    }
                }
            }
            Some(b"\x80theora") if payload.len() >= 30 => {
                let picw = u16::from_be_bytes(payload[14..16].try_into().unwrap()) as u32;
                let pich = u16::from_be_bytes(payload[16..18].try_into().unwrap()) as u32;
                let frn = u32::from_be_bytes(payload[22..26].try_into().unwrap());
                let frd = u32::from_be_bytes(payload[26..30].try_into().unwrap());
                info.video = Some(VideoTrack {
                    codec: Some("Theora".to_string()),
                    width: (picw > 0).then_some(picw),
                    height: (pich > 0).then_some(pich),
                    fps: (frn > 0 && frd > 0).then_some(frn as f64 / frd as f64),
                });
            }
            _ => {}
        }
    }
    if info.audio.is_none() && info.video.is_none() {
        info.format = None;
    }
    Ok(info)
}

/// The first page's first packet's bytes, as far as this 64 KiB window reaches.
fn ogg_first_packet(head: &[u8]) -> Option<&[u8]> {
    if head.get(0..4) != Some(b"OggS".as_slice()) {
        return None;
    }
    let segments = *head.get(26)? as usize;
    let table_end = 27 + segments;
    if head.len() < table_end {
        return None;
    }
    let mut len = 0usize;
    for &s in &head[27..table_end] {
        len += s as usize;
    }
    head.get(table_end..(table_end + len).min(head.len()))
}

/// The last page's granule position: the stream's total length in samples (or frames).
/// A tail scan finds it without reading the body.
fn last_granule(file: &mut File, size: u64) -> Option<u64> {
    if size == 0 {
        return None;
    }
    let scan = TAIL_BYTES.min(size);
    let at = size - scan;
    let tail = read_at(file, at, scan);
    let mut granule = None;
    let mut pos = 0;
    while pos + 27 <= tail.len() {
        if &tail[pos..pos + 4] == b"OggS" {
            let g = u64::from_le_bytes(tail[pos + 6..pos + 14].try_into().ok()?);
            let segments = tail[pos + 26] as usize;
            if tail.len() < pos + 27 + segments {
                return granule;
            }
            let payload: usize = tail[pos + 27..pos + 27 + segments].iter().map(|&s| s as usize).sum();
            let page_len = 27 + segments + payload;
            if g != u64::MAX {
                // -1 granules mean "no packets end on this page"; keep looking.
                granule = Some(g);
            }
            if page_len <= 27 {
                break;
            }
            pos += page_len;
            continue;
        }
        pos += 1;
    }
    granule
}

#[cfg(test)]
mod media_tests {
    use super::*;

    fn write_temp(name: &str, bytes: &[u8]) -> std::path::PathBuf {
        use std::sync::atomic::{AtomicU32, Ordering};
        static SEQ: AtomicU32 = AtomicU32::new(0);
        let path = std::env::temp_dir().join(format!(
            "ggs-media-{}-{}-{}",
            std::process::id(),
            SEQ.fetch_add(1, Ordering::Relaxed),
            name
        ));
        std::fs::write(&path, bytes).unwrap();
        path
    }

    fn mp4_box(typ: &[u8; 4], payload: &[u8]) -> Vec<u8> {
        let mut out = (payload.len() as u32 + 8).to_be_bytes().to_vec();
        out.extend_from_slice(typ);
        out.extend_from_slice(payload);
        out
    }

    /// An MP4 with a tail moov (where phone recordings put it): 5 s overall, a 1920×1080
    /// H.264 video at 30000/1001 fps, stereo 44.1 kHz AAC.
    fn mp4_bytes() -> Vec<u8> {
        let mvhd = mp4_box(
            b"mvhd",
            &{
                let mut p = vec![0u8; 100];
                p[12..16].copy_from_slice(&1000u32.to_be_bytes()); // timescale
                p[16..20].copy_from_slice(&5000u32.to_be_bytes()); // duration
                p
            },
        );
        let mk_tkhd = |w: u32, h: u32| {
            let mut p = vec![0u8; 84];
            p[76..80].copy_from_slice(&(w << 16).to_be_bytes());
            p[80..84].copy_from_slice(&(h << 16).to_be_bytes());
            mp4_box(b"tkhd", &p)
        };
        let mk_mdhd = |ts: u32, dur: u32| {
            let mut p = vec![0u8; 24];
            p[12..16].copy_from_slice(&ts.to_be_bytes());
            p[16..20].copy_from_slice(&dur.to_be_bytes());
            mp4_box(b"mdhd", &p)
        };
        let mk_hdlr = |handler: &[u8; 4]| mp4_box(b"hdlr", &[0, 0, 0, 0, 0, 0, 0, 0, handler[0], handler[1], handler[2], handler[3]]);
        let video_stsd = mp4_box(
            b"stsd",
            &{
                // The sample entry: its 8-byte box header, then the fixed VisualSampleEntry
                // fields the parser reads the 1920×1080 pair out of.
                let mut entry = Vec::new();
                entry.extend_from_slice(&[0u8; 8]); // reserved + data reference index
                entry.extend_from_slice(&[0u8; 16]); // pre_defined + reserved + pre_defined[3]
                entry.extend_from_slice(&1920u16.to_be_bytes());
                entry.extend_from_slice(&1080u16.to_be_bytes());
                entry.extend_from_slice(&[0u8; 50]); // dpi, frame count, compressor name, depth
                let mut box_bytes = (entry.len() as u32 + 8).to_be_bytes().to_vec();
                box_bytes.extend_from_slice(b"avc1");
                box_bytes.extend_from_slice(&entry);
                let mut stsd = vec![0u8; 8]; // ver/flags + entry_count
                stsd[4..8].copy_from_slice(&1u32.to_be_bytes());
                stsd.extend_from_slice(&box_bytes);
                stsd
            },
        );
        let video_stts = mp4_box(b"stts", &[0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 12, 72, 0, 0, 3, 233]); // delta 1001
        let video_trak = mp4_box(
            b"trak",
            &[
                mk_tkhd(1920, 1080).as_slice(),
                mp4_box(
                    b"mdia",
                    &[
                        mk_mdhd(30000, 150150).as_slice(),
                        mk_hdlr(b"vide").as_slice(),
                        mp4_box(b"minf", &[mp4_box(b"stbl", &[video_stsd.as_slice(), video_stts.as_slice()].concat()).as_slice()].concat()).as_slice(),
                    ]
                    .concat(),
                )
                .as_slice(),
            ]
            .concat(),
        );
        let esds = {
            let mut p: Vec<u8> = vec![0, 0, 0, 0, 0x03, 0x12, 0x00, 0x01, 0x00, 0x04, 0x0D, 0x40];
            p.extend_from_slice(&[0u8; 12]); // stream type, buffer sizes, bitrates
            mp4_box(b"esds", &p)
        };
        let audio_stsd = mp4_box(
            b"stsd",
            &{
                let mut entry = Vec::new();
                entry.extend_from_slice(&[0u8; 8]); // reserved + data reference index
                entry.extend_from_slice(&[0u8; 4]); // reserved[2]
                entry.extend_from_slice(&[0u8; 4]); // version + revision
                entry.extend_from_slice(&[0u8; 4]); // vendor
                entry.extend_from_slice(&2u16.to_be_bytes()); // channels
                entry.extend_from_slice(&16u16.to_be_bytes()); // sample size
                entry.extend_from_slice(&[0u8; 4]); // pre_defined + reserved
                entry.extend_from_slice(&(44100u32 << 16).to_be_bytes()); // 16.16 rate
                entry.extend_from_slice(&esds);
                let mut box_bytes = (entry.len() as u32 + 8).to_be_bytes().to_vec();
                box_bytes.extend_from_slice(b"mp4a");
                box_bytes.extend_from_slice(&entry);
                let mut stsd = vec![0u8; 8];
                stsd[4..8].copy_from_slice(&1u32.to_be_bytes());
                stsd.extend_from_slice(&box_bytes);
                stsd
            },
        );
        let audio_trak = mp4_box(
            b"trak",
            &[
                mk_tkhd(0, 0).as_slice(),
                mp4_box(
                    b"mdia",
                    &[
                        mk_mdhd(44100, 220500).as_slice(),
                        mk_hdlr(b"soun").as_slice(),
                        mp4_box(b"minf", &[mp4_box(b"stbl", &[audio_stsd.as_slice()].concat()).as_slice()].concat()).as_slice(),
                    ]
                    .concat(),
                )
                .as_slice(),
            ]
            .concat(),
        );
        let moov = mp4_box(b"moov", &[mvhd.as_slice(), video_trak.as_slice(), audio_trak.as_slice()].concat());
        let ftyp = mp4_box(b"ftyp", b"isom\x00\x00\x02\x00isomiso2avc1mp41");
        // ftyp first, an mdat spacer, then the moov at the tail: the walk reads ftyp's
        // header, skips mdat by its size, and seeks to moov.
        [ftyp.as_slice(), &[0, 0, 0, 12, b'm', b'd', b'a', b't', 0, 0, 0, 0], moov.as_slice()].concat()
    }

    #[test]
    fn an_mp4_answers_the_container_video_and_audio_facts() {
        let path = write_temp("video.mp4", &mp4_bytes());
        let info = probe(path.to_str().unwrap()).unwrap();
        std::fs::remove_file(&path).unwrap();
        assert_eq!(info.format.as_deref(), Some("MP4"));
        assert_eq!(info.duration_ms, Some(5000.0));
        let video = info.video.expect("video track");
        assert_eq!(video.codec.as_deref(), Some("H.264"));
        assert_eq!(video.width, Some(1920));
        assert_eq!(video.height, Some(1080));
        assert!((video.fps.unwrap() - 30000.0 / 1001.0).abs() < 0.001);
        let audio = info.audio.expect("audio track");
        assert_eq!(audio.codec.as_deref(), Some("AAC"));
        assert_eq!(audio.sample_rate, Some(44100));
        assert_eq!(audio.channels, Some(2));
        assert!(info.bitrate_bps.unwrap() > 0);
    }

    /// EBML element helpers: ids keep their marker bit, values take an explicit width.
    fn evint(value: u64, width: usize) -> Vec<u8> {
        let mut out = vec![0u8; width];
        let mut v = value;
        for i in (0..width).rev() {
            out[i] = (v & 0xFF) as u8;
            v >>= 8;
        }
        out[0] |= 0x80 >> (width - 1);
        out
    }

    fn ebml_master(id: &[u8], payload: &[u8]) -> Vec<u8> {
        let mut out = id.to_vec();
        out.extend(evint(payload.len() as u64, 2));
        out.extend_from_slice(payload);
        out
    }

    fn ebml_uint(id: &[u8], value: u64, width: usize) -> Vec<u8> {
        let mut out = id.to_vec();
        out.extend(evint(width as u64, 1));
        let mut bytes = vec![0u8; width];
        let mut v = value;
        for i in (0..width).rev() {
            bytes[i] = (v & 0xFF) as u8;
            v >>= 8;
        }
        out.extend(bytes);
        out
    }

    fn ebml_float32(id: &[u8], value: f32) -> Vec<u8> {
        let mut out = id.to_vec();
        out.extend(evint(4, 1));
        out.extend_from_slice(&value.to_be_bytes());
        out
    }

    fn ebml_string(id: &[u8], text: &str) -> Vec<u8> {
        let mut out = id.to_vec();
        out.extend(evint(text.len() as u64, 1));
        out.extend_from_slice(text.as_bytes());
        out
    }

    fn webm_bytes() -> Vec<u8> {
        let header = ebml_master(&[0x1A, 0x45, 0xDF, 0xA3], &[ebml_uint(&[0x42, 0x86], 1, 1).as_slice(), ebml_string(&[0x42, 0x82], "matroska").as_slice()].concat());
        let info = ebml_master(
            &[0x15, 0x49, 0xA9, 0x66],
            &[ebml_uint(&[0x2A, 0xD7, 0xB1], 1_000_000, 3).as_slice(), ebml_float32(&[0x44, 0x89], 5_000.0).as_slice()].concat(),
        );
        let video_track = ebml_master(
            &[0xAE],
            &[
                ebml_uint(&[0x83], 1, 1).as_slice(),
                ebml_string(&[0x86], "V_VP9").as_slice(),
                ebml_master(&[0xE0], &[ebml_uint(&[0xB0], 1280, 2).as_slice(), ebml_uint(&[0xBA], 720, 2).as_slice()].concat()).as_slice(),
            ]
            .concat(),
        );
        let audio_track = ebml_master(
            &[0xAE],
            &[
                ebml_uint(&[0x83], 2, 1).as_slice(),
                ebml_string(&[0x86], "A_OPUS").as_slice(),
                ebml_master(&[0xE1], &[ebml_float32(&[0xB5], 48_000.0).as_slice(), ebml_uint(&[0x9F], 2, 1).as_slice()].concat()).as_slice(),
            ]
            .concat(),
        );
        let tracks = ebml_master(&[0x16, 0x54, 0xAE, 0x6B], &[video_track.as_slice(), audio_track.as_slice()].concat());
        let segment = ebml_master(&[0x18, 0x53, 0x80, 0x67], &[info.as_slice(), tracks.as_slice()].concat());
        [header.as_slice(), segment.as_slice()].concat()
    }

    #[test]
    fn a_webm_answers_the_matroska_facts() {
        let path = write_temp("clip.webm", &webm_bytes());
        let info = probe(path.to_str().unwrap()).unwrap();
        std::fs::remove_file(&path).unwrap();
        assert_eq!(info.format.as_deref(), Some("Matroska"));
        assert_eq!(info.duration_ms, Some(5000.0));
        let video = info.video.expect("video track");
        assert_eq!(video.codec.as_deref(), Some("VP9"));
        assert_eq!(video.width, Some(1280));
        assert_eq!(video.height, Some(720));
        let audio = info.audio.expect("audio track");
        assert_eq!(audio.codec.as_deref(), Some("Opus"));
        assert_eq!(audio.sample_rate, Some(48000));
        assert_eq!(audio.channels, Some(2));
    }

    fn flac_bytes(sample_rate: u32, channels: u16, bits: u16, total_samples: u64) -> Vec<u8> {
        let packed: u64 = ((sample_rate as u64) << 44) | (((channels - 1) as u64) << 41) | (((bits - 1) as u64) << 36) | total_samples;
        let mut block = vec![0u8; 34];
        block[10..18].copy_from_slice(&packed.to_be_bytes());
        let mut out = b"fLaC".to_vec();
        out.push(0x00); // last-flag clear, STREAMINFO
        out.extend_from_slice(&(34u32).to_be_bytes()[1..]);
        out.extend_from_slice(&block);
        out
    }

    #[test]
    fn a_flac_answers_its_streaminfo() {
        let path = write_temp("song.flac", &flac_bytes(48_000, 2, 16, 48_000));
        let info = probe(path.to_str().unwrap()).unwrap();
        std::fs::remove_file(&path).unwrap();
        assert_eq!(info.format.as_deref(), Some("FLAC"));
        assert_eq!(info.duration_ms, Some(1000.0));
        let audio = info.audio.expect("audio track");
        assert_eq!(audio.codec.as_deref(), Some("FLAC"));
        assert_eq!(audio.sample_rate, Some(48000));
        assert_eq!(audio.channels, Some(2));
        assert_eq!(audio.bits_per_sample, Some(16));
    }

    /// One MPEG-1 Layer III frame at 128 kbit/s / 44.1 kHz stereo: a 418-byte frame body
    /// behind the 4-byte header.
    fn mp3_frame() -> Vec<u8> {
        let mut frame = vec![0xFF, 0xFB, 0x90, 0x00];
        frame.resize(418, 0x55);
        frame
    }

    #[test]
    fn a_cbr_mp3_estimates_from_the_frame_bitrate() {
        let mut bytes: Vec<u8> = b"ID3".to_vec();
        bytes.extend_from_slice(&[0x03, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]); // 10-byte header
        for _ in 0..10 {
            bytes.extend_from_slice(&mp3_frame());
        }
        let path = write_temp("song.mp3", &bytes);
        let info = probe(path.to_str().unwrap()).unwrap();
        std::fs::remove_file(&path).unwrap();
        assert_eq!(info.format.as_deref(), Some("MP3"));
        let audio = info.audio.expect("audio track");
        assert_eq!(audio.codec.as_deref(), Some("MP3"));
        assert_eq!(audio.sample_rate, Some(44100));
        assert_eq!(audio.channels, Some(2));
        // 4180 body bytes at 128 kbit/s.
        let expected = 4180.0 * 8.0 / 128_000.0 * 1000.0;
        assert!((info.duration_ms.unwrap() - expected).abs() < 0.01);
    }

    #[test]
    fn a_xing_mp3_counts_its_frames_exactly() {
        let mut frame = mp3_frame();
        // The Xing tag rides the first frame after its 32-byte side information (stereo).
        let mut xing = b"Xing".to_vec();
        xing.extend_from_slice(&1u32.to_be_bytes()); // frames flag only
        xing.extend_from_slice(&1000u32.to_be_bytes());
        frame[36..36 + xing.len()].copy_from_slice(&xing);
        let path = write_temp("song-xing.mp3", &frame);
        let info = probe(path.to_str().unwrap()).unwrap();
        std::fs::remove_file(&path).unwrap();
        let expected = 1000.0 * 1000.0 * 1152.0 / 44100.0;
        assert!((info.duration_ms.unwrap() - expected).abs() < 0.01);
    }

    fn ogg_page(granule: u64, payload: &[u8]) -> Vec<u8> {
        let mut page = b"OggS".to_vec();
        page.push(0); // version
        page.push(0); // header type
        page.extend_from_slice(&granule.to_le_bytes());
        page.extend_from_slice(&0x1234u32.to_le_bytes()); // serial
        page.extend_from_slice(&0u32.to_le_bytes()); // sequence
        page.extend_from_slice(&0u32.to_le_bytes()); // checksum (unchecked here)
        page.push(1); // one segment
        page.push(payload.len() as u8);
        page.extend_from_slice(payload);
        page
    }

    fn opus_ogg_bytes() -> Vec<u8> {
        let mut head = b"OpusHead".to_vec();
        head.push(1); // version
        head.push(2); // channels
        head.extend_from_slice(&312u16.to_le_bytes()); // pre-skip
        head.extend_from_slice(&48000u32.to_le_bytes()); // input rate
        let first = ogg_page(0, &head);
        let last = ogg_page(312 + 48_000, &[0xF8, 0xFF, 0xFE]); // one second of audio
        [first.as_slice(), last.as_slice()].concat()
    }

    #[test]
    fn an_opus_ogg_answers_the_head_and_the_last_granule() {
        let path = write_temp("voice.ogg", &opus_ogg_bytes());
        let info = probe(path.to_str().unwrap()).unwrap();
        std::fs::remove_file(&path).unwrap();
        assert_eq!(info.format.as_deref(), Some("OGG"));
        let audio = info.audio.expect("audio track");
        assert_eq!(audio.codec.as_deref(), Some("Opus"));
        assert_eq!(audio.sample_rate, Some(48_000));
        assert_eq!(audio.channels, Some(2));
        assert!((info.duration_ms.unwrap() - 1000.0).abs() < 0.01);
    }

    fn avi_bytes() -> Vec<u8> {
        let mut avih = vec![0u8; 40];
        avih[0..4].copy_from_slice(&41_708u32.to_le_bytes()); // µs per frame
        avih[16..20].copy_from_slice(&100u32.to_le_bytes()); // total frames
        avih[32..36].copy_from_slice(&640u32.to_le_bytes());
        avih[36..40].copy_from_slice(&480u32.to_le_bytes());
        let mut strh = vec![0u8; 56];
        strh[0..4].copy_from_slice(b"vids");
        strh[4..8].copy_from_slice(b"XVID");
        strh[20..24].copy_from_slice(&1001u32.to_le_bytes()); // scale
        strh[24..28].copy_from_slice(&24000u32.to_le_bytes()); // rate
        strh[32..36].copy_from_slice(&100u32.to_le_bytes()); // length
        let mut strf = vec![0u8; 40];
        strf[0..4].copy_from_slice(&40u32.to_le_bytes()); // biSize
        strf[16..20].copy_from_slice(b"XVID"); // biCompression
        let strl = avi_list(b"strl", &[avi_chunk_bytes(b"strh", &strh).as_slice(), avi_chunk_bytes(b"strf", &strf).as_slice()].concat());
        let hdrl = avi_list(b"hdrl", &[avi_chunk_bytes(b"avih", &avih).as_slice(), strl.as_slice()].concat());
        let mut out = b"RIFF".to_vec();
        let body_len = 4 + hdrl.len();
        out.extend_from_slice(&(body_len as u32).to_le_bytes());
        out.extend_from_slice(b"AVI ");
        out.extend_from_slice(&hdrl);
        out
    }

    fn avi_chunk_bytes(typ: &[u8; 4], payload: &[u8]) -> Vec<u8> {
        let mut out = typ.to_vec();
        out.extend_from_slice(&(payload.len() as u32).to_le_bytes());
        out.extend_from_slice(payload);
        out
    }

    fn avi_list(kind: &[u8; 4], payload: &[u8]) -> Vec<u8> {
        let mut out = b"LIST".to_vec();
        out.extend_from_slice(&((payload.len() + 4) as u32).to_le_bytes());
        out.extend_from_slice(kind);
        out.extend_from_slice(payload);
        out
    }

    #[test]
    fn an_avi_answers_the_header_and_stream_facts() {
        let path = write_temp("rec.avi", &avi_bytes());
        let info = probe(path.to_str().unwrap()).unwrap();
        std::fs::remove_file(&path).unwrap();
        assert_eq!(info.format.as_deref(), Some("AVI"));
        let video = info.video.expect("video track");
        assert_eq!(video.codec.as_deref(), Some("XVID"));
        assert_eq!(video.width, Some(640));
        assert_eq!(video.height, Some(480));
        assert!((video.fps.unwrap() - 24000.0 / 1001.0).abs() < 0.001);
        assert!((info.duration_ms.unwrap() - 100.0 * 1000.0 * 1001.0 / 24000.0).abs() < 0.1);
    }

    fn wav_bytes(sample_rate: u32, channels: u16, bits: u16, samples: usize) -> Vec<u8> {
        let block_align = channels * bits / 8;
        let byte_rate = sample_rate * block_align as u32;
        let data_len = samples * block_align as usize;
        let mut out = b"RIFF".to_vec();
        out.extend_from_slice(&(36 + data_len as u32).to_le_bytes());
        out.extend_from_slice(b"WAVE");
        let mut fmt = b"fmt ".to_vec();
        fmt.extend_from_slice(&16u32.to_le_bytes());
        fmt.extend_from_slice(&1u16.to_le_bytes()); // PCM
        fmt.extend_from_slice(&channels.to_le_bytes());
        fmt.extend_from_slice(&sample_rate.to_le_bytes());
        fmt.extend_from_slice(&byte_rate.to_le_bytes());
        fmt.extend_from_slice(&block_align.to_le_bytes());
        fmt.extend_from_slice(&bits.to_le_bytes());
        let mut data = b"data".to_vec();
        data.extend_from_slice(&(data_len as u32).to_le_bytes());
        data.extend(std::iter::repeat_n(0u8, data_len));
        out.extend_from_slice(&fmt);
        out.extend_from_slice(&data);
        out
    }

    #[test]
    fn a_wav_answers_the_fmt_chunk() {
        let path = write_temp("beep.wav", &wav_bytes(8000, 1, 8, 8000));
        let info = probe(path.to_str().unwrap()).unwrap();
        std::fs::remove_file(&path).unwrap();
        assert_eq!(info.format.as_deref(), Some("WAV"));
        assert_eq!(info.duration_ms, Some(1000.0));
        let audio = info.audio.expect("audio track");
        assert_eq!(audio.codec.as_deref(), Some("PCM"));
        assert_eq!(audio.sample_rate, Some(8000));
        assert_eq!(audio.channels, Some(1));
        assert_eq!(audio.bits_per_sample, Some(8));
        // The file's own bytes over its one second.
        assert_eq!(info.bitrate_bps, Some(8044 * 8));
    }

    #[test]
    fn an_unrecognized_container_stays_unknown() {
        let path = write_temp("mystery.bin", &[1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
        let info = probe(path.to_str().unwrap()).unwrap();
        std::fs::remove_file(&path).unwrap();
        assert_eq!(info.format.as_deref(), Some("Unknown"));
        assert_eq!(info.duration_ms, None);
        assert_eq!(info.video, None);
        assert_eq!(info.audio, None);
    }
}
