//! Local civil time for `ls -l` and `date`, without a datetime dependency: the pure
//! days↔civil algorithms are Howard Hinnant's, and the one platform fact std cannot
//! give — the local offset from UTC — comes from the OS (`GetTimeZoneInformation` on
//! Windows, `localtime_r` elsewhere) through plain extern declarations, the same
//! system-bindings class as the pty (plan §3.1: no C source compiled).

/// A civil date-time in the machine's local zone.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Civil {
    pub year: i64,
    pub month: u32,
    pub day: u32,
    pub hour: u32,
    pub minute: u32,
    pub second: u32,
}

impl Civil {
    /// 0 = Sunday, like `tm_wday` (and the `%w` of date formats).
    pub fn weekday(&self) -> u32 {
        let days = days_from_civil(self.year, self.month, self.day);
        (((days % 7) + 7 + 4) % 7) as u32
    }
}

/// Days since 1970-01-01 from a civil date (pure; Hinnant's `days_from_civil`).
pub fn days_from_civil(y: i64, m: u32, d: u32) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400;
    let mp = if m > 2 { m as i64 - 3 } else { m as i64 + 9 };
    let doy = (153 * mp + 2) / 5 + d as i64 - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146097 + doe - 719468
}

/// The inverse of [`days_from_civil`] (pure).
pub fn civil_from_days(days: i64) -> (i64, u32, u32) {
    let z = days + 719468;
    let era = if z >= 0 { z } else { z - 146096 } / 146097;
    let doe = z - era * 146097;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (y + if m <= 2 { 1 } else { 0 }, m, d)
}

pub fn now_unix() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

pub fn local_now() -> Civil {
    unix_to_local(now_unix())
}

/// The seconds east of UTC this machine currently sits at (DST included where the
/// platform reports it).
pub fn local_offset_seconds() -> i64 {
    #[cfg(windows)]
    {
        windows_offset()
    }
    #[cfg(not(windows))]
    {
        unsafe {
            let mut tm = Tm::zeroed();
            let now: libc_time_t = now_unix();
            if localtime_r(&now, &mut tm).is_null() {
                0
            } else {
                tm.tm_gmtoff as i64
            }
        }
    }
}

pub fn unix_to_local(secs: i64) -> Civil {
    #[cfg(not(windows))]
    {
        unsafe {
            let mut tm = Tm::zeroed();
            let time: libc_time_t = secs;
            if !localtime_r(&time, &mut tm).is_null() {
                return Civil {
                    year: tm.tm_year as i64 + 1900,
                    month: tm.tm_mon as u32 + 1,
                    day: tm.tm_mday as u32,
                    hour: tm.tm_hour as u32,
                    minute: tm.tm_min as u32,
                    second: tm.tm_sec as u32,
                };
            }
        }
        fallback_civil(secs, 0)
    }
    #[cfg(windows)]
    {
        fallback_civil(secs, windows_offset())
    }
}

/// The pure fallback: civil time from UTC seconds plus a fixed offset.
fn fallback_civil(secs: i64, offset: i64) -> Civil {
    let local = secs + offset;
    let days = local.div_euclid(86400);
    let rest = local.rem_euclid(86400);
    let (year, month, day) = civil_from_days(days);
    Civil {
        year,
        month,
        day,
        hour: (rest / 3600) as u32,
        minute: (rest % 3600 / 60) as u32,
        second: (rest % 60) as u32,
    }
}

/* ---------- The platform bindings ---------- */

#[cfg(not(windows))]
#[repr(C)]
struct Tm {
    tm_sec: i32,
    tm_min: i32,
    tm_hour: i32,
    tm_mday: i32,
    tm_mon: i32,
    tm_year: i32,
    tm_wday: i32,
    tm_yday: i32,
    tm_isdst: i32,
    tm_gmtoff: i64,
    tm_zone: *const u8,
}

#[cfg(not(windows))]
impl Tm {
    fn zeroed() -> Tm {
        Tm {
            tm_sec: 0,
            tm_min: 0,
            tm_hour: 0,
            tm_mday: 0,
            tm_mon: 0,
            tm_year: 0,
            tm_wday: 0,
            tm_yday: 0,
            tm_isdst: 0,
            tm_gmtoff: 0,
            tm_zone: std::ptr::null(),
        }
    }
}

#[cfg(not(windows))]
#[allow(non_camel_case_types)]
type libc_time_t = i64;

#[cfg(not(windows))]
extern "C" {
    fn localtime_r(timep: *const libc_time_t, result: *mut Tm) -> *mut Tm;
}

#[cfg(windows)]
#[repr(C)]
#[allow(non_snake_case)]
struct WinSystemTime {
    wYear: u16,
    wMonth: u16,
    wDayOfWeek: u16,
    wDay: u16,
    wHour: u16,
    wMinute: u16,
    wSecond: u16,
    wMilliseconds: u16,
}

#[cfg(windows)]
#[repr(C)]
#[allow(non_snake_case)]
struct TimeZoneInformation {
    Bias: i32,
    StandardName: [u16; 32],
    StandardDate: WinSystemTime,
    StandardBias: i32,
    DaylightName: [u16; 32],
    DaylightDate: WinSystemTime,
    DaylightBias: i32,
}

#[cfg(windows)]
extern "system" {
    fn GetTimeZoneInformation(tzi: *mut TimeZoneInformation) -> u32;
}

/// Windows: the current bias, daylight-savings folded in when the API says it is in
/// effect. UTC = local + bias, so the seconds-east-of-UTC offset is `-bias`.
#[cfg(windows)]
fn windows_offset() -> i64 {
    unsafe {
        let mut tzi = TimeZoneInformation {
            Bias: 0,
            StandardName: [0; 32],
            StandardDate: WinSystemTime {
                wYear: 0,
                wMonth: 0,
                wDayOfWeek: 0,
                wDay: 0,
                wHour: 0,
                wMinute: 0,
                wSecond: 0,
                wMilliseconds: 0,
            },
            StandardBias: 0,
            DaylightName: [0; 32],
            DaylightDate: WinSystemTime {
                wYear: 0,
                wMonth: 0,
                wDayOfWeek: 0,
                wDay: 0,
                wHour: 0,
                wMinute: 0,
                wSecond: 0,
                wMilliseconds: 0,
            },
            DaylightBias: 0,
        };
        let state = GetTimeZoneInformation(&mut tzi);
        let mut bias = tzi.Bias;
        if state == 2 {
            // TIME_ZONE_ID_DAYLIGHT: the daylight bias is active.
            bias += tzi.DaylightBias;
        } else {
            bias += tzi.StandardBias;
        }
        -(bias as i64) * 60
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn civil_days_round_trip_through_the_epoch() {
        assert_eq!(days_from_civil(1970, 1, 1), 0);
        assert_eq!(civil_from_days(0), (1970, 1, 1));
        for (y, m, d) in [
            (1970, 1, 1),
            (2000, 2, 29),
            (2026, 10, 10),
            (1999, 12, 31),
            (2100, 3, 1),
        ] {
            let days = days_from_civil(y, m, d);
            assert_eq!(civil_from_days(days), (y, m, d), "{y}-{m}-{d}");
        }
    }

    #[test]
    fn the_epoch_was_a_thursday() {
        let civil = Civil {
            year: 1970,
            month: 1,
            day: 1,
            hour: 0,
            minute: 0,
            second: 0,
        };
        assert_eq!(civil.weekday(), 4);
    }

    #[test]
    fn local_now_lands_in_the_present() {
        let now = local_now();
        assert!(
            (2024..=2200).contains(&now.year),
            "implausible year {}",
            now.year
        );
        assert!((1..=12).contains(&now.month));
        assert!((1..=31).contains(&now.day));
    }

    #[test]
    fn unix_to_local_agrees_with_the_offset_within_this_zone() {
        // Not pinned to a zone: whatever the offset, the two epoch seconds one hour apart
        // stay one civil hour apart, and 86400 apart is the same wall time.
        let a = unix_to_local(1_700_000_000);
        let b = unix_to_local(1_700_003_600);
        assert_eq!((b.hour + 24 - a.hour) % 24, 1);
        let day_later = unix_to_local(1_700_086_400);
        assert_eq!((day_later.hour, day_later.minute), (a.hour, a.minute));
    }
}
