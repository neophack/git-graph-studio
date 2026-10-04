//! GGS-patch: the pacing guard rails — the threshold ceiling and the collection slack
//! that keep the sidecar's commit bounded when the hosted JS's live heap reaches the cap
//! (an uncapped threshold grew a claude-code session into the gigabytes of commit, and on
//! a machine near its commit limit the next refused allocation aborted the whole backend).

use crate::{Allocator, BoaGc, GcConfig, GcRuntimeData, GC_THRESHOLD_CEILING};

const SLACK: usize = 16 * 1_048_576;

fn bare_gc(threshold: usize) -> BoaGc {
    BoaGc {
        config: GcConfig { threshold, used_space_percentage: 70 },
        runtime: GcRuntimeData::default(),
        strongs: Vec::new(),
        weaks: Vec::new(),
        weak_maps: Vec::new(),
    }
}

/// Growth past the ceiling stops at it: `survivors × 2` must never propose a threshold the
/// sidecar's commit cannot back.
#[test]
fn the_threshold_growth_caps_out() {
    // Live heap well under the cap: the 2× pacing stands.
    let mut gc = bare_gc(64 * 1_048_576);
    gc.runtime.bytes_allocated = 100 * 1_048_576;
    Allocator::manage_state(&mut gc);
    assert_eq!(gc.config.threshold, 200 * 1_048_576);

    // Live heap such that 2× survivors would blow past the cap: the cap holds.
    let mut gc = bare_gc(GC_THRESHOLD_CEILING);
    gc.runtime.bytes_allocated = GC_THRESHOLD_CEILING;
    Allocator::manage_state(&mut gc);
    assert_eq!(gc.config.threshold, GC_THRESHOLD_CEILING);

    // Already at the cap, more live data: still the cap, never above.
    gc.runtime.bytes_allocated = GC_THRESHOLD_CEILING + 128 * 1_048_576;
    Allocator::manage_state(&mut gc);
    assert_eq!(gc.config.threshold, GC_THRESHOLD_CEILING);
}

/// At the cap the collector runs once per slack of growth, not once per allocation.
#[test]
fn collections_keep_their_stride_at_the_cap() {
    let mut gc = bare_gc(GC_THRESHOLD_CEILING);

    // Above the threshold but inside the slack: no collection fires.
    gc.runtime.bytes_allocated = GC_THRESHOLD_CEILING + 1024;
    Allocator::manage_state(&mut gc);
    assert_eq!(gc.runtime.collections, 0);

    // Past the slack: exactly one collection, and the trigger is re-armed for the
    // next slack of growth rather than firing on every following allocation.
    gc.runtime.bytes_allocated = GC_THRESHOLD_CEILING + SLACK + 1024;
    Allocator::manage_state(&mut gc);
    assert_eq!(gc.runtime.collections, 1);
}
