//! The addresses plevin scores high enough to turn away, as CIDR a firewall can read.

use crate::abuse::Records;
use crate::ceiling;
use std::fmt::Write;
use std::net::{Ipv4Addr, Ipv6Addr};

pub const LISTED: u8 = 2;

pub const FLOOR: u8 = 40;

fn blocks(first: u128, last: u128, bits: u32, out: &mut Vec<String>) {
    let mut at = first;
    loop {
        let aligned = match at {
            0 => bits,
            at => at.trailing_zeros().min(bits),
        };
        let left = last - at;
        let fits = match left {
            u128::MAX => bits,
            left => 127 - (left + 1).leading_zeros(),
        };
        let size = aligned.min(fits);
        out.push(named(at, bits - size, bits));
        if size >= bits || left < 1u128 << size {
            return;
        }
        at += 1u128 << size;
    }
}

fn named(at: u128, prefix: u32, bits: u32) -> String {
    let address = match bits {
        32 => Ipv4Addr::from(at as u32).to_string(),
        _ => Ipv6Addr::from(at).to_string(),
    };
    match prefix == bits {
        true => address,
        false => format!("{address}/{prefix}"),
    }
}

fn merged(mut ranges: Vec<(u128, u128)>) -> Vec<(u128, u128)> {
    ranges.sort_unstable();
    let mut out: Vec<(u128, u128)> = Vec::with_capacity(ranges.len());
    for (first, last) in ranges {
        match out.last_mut() {
            Some((_, held)) if first <= held.saturating_add(1) => {
                *held = (*held).max(last)
            }
            _ => out.push((first, last)),
        }
    }
    out
}

const FEEDS: &str = "https://github.com/tn3w/plevin/tree/master/builder/data/feeds.json";

const fn v4(first: u8, second: u8, third: u8, fourth: u8, prefix: u32) -> (u128, u128) {
    let at = u32::from_be_bytes([first, second, third, fourth]) as u128;
    (at, at + (1 << (32 - prefix)) - 1)
}

const RESERVED: &[(u128, u128)] = &[
    v4(0, 0, 0, 0, 8),
    v4(10, 0, 0, 0, 8),
    v4(100, 64, 0, 0, 10),
    v4(127, 0, 0, 0, 8),
    v4(169, 254, 0, 0, 16),
    v4(172, 16, 0, 0, 12),
    v4(192, 0, 0, 0, 24),
    v4(192, 0, 2, 0, 24),
    v4(192, 88, 99, 0, 24),
    v4(192, 168, 0, 0, 16),
    v4(198, 18, 0, 0, 15),
    v4(198, 51, 100, 0, 24),
    v4(203, 0, 113, 0, 24),
    v4(224, 0, 0, 0, 4),
    v4(240, 0, 0, 0, 4),
];

const fn v6(first: u16, second: u16, prefix: u32) -> (u128, u128) {
    let at = (first as u128) << 112 | (second as u128) << 96;
    (at, at + (1 << (128 - prefix)) - 1)
}

const RESERVED_V6: &[(u128, u128)] =
    &[v6(0x2001, 0, 23), v6(0x2001, 0x0db8, 32), v6(0x2002, 0, 16), v6(0x3fff, 0, 20)];

const UNICAST: (u128, u128) = (1 << 125, (1 << 126) - 1);

fn routable(held: (u128, u128), family: usize) -> Vec<(u128, u128)> {
    let (held, cuts) = match family {
        0 => (held, RESERVED),
        _ => ((held.0.max(UNICAST.0), held.1.min(UNICAST.1)), RESERVED_V6),
    };
    if held.0 > held.1 {
        return Vec::new();
    }
    let mut out = vec![held];
    for cut in cuts {
        out = out.into_iter().flat_map(|range| without(range, *cut)).collect();
    }
    out
}

pub fn public(family: usize) -> Vec<(u128, bool)> {
    let mut runs = Vec::new();
    let mut at = 0u128;
    for (first, last) in routable((0, ceiling(family)), family) {
        if first > at {
            runs.push((at, false));
        }
        runs.push((first, true));
        at = last + 1;
    }
    if at <= ceiling(family) {
        runs.push((at, false));
    }
    runs
}

pub fn opens(runs: &[(u128, bool)], address: u128) -> bool {
    let at = runs.partition_point(|(start, _)| *start <= address);
    at > 0 && runs[at - 1].1
}

fn without(
    (first, last): (u128, u128),
    (start, stop): (u128, u128),
) -> Vec<(u128, u128)> {
    if last < start || first > stop {
        return vec![(first, last)];
    }
    let mut out = Vec::new();
    if first < start {
        out.push((first, start - 1));
    }
    if last > stop {
        out.push((stop + 1, last));
    }
    out
}

fn ranges(records: &Records, family: usize) -> Vec<(u128, u128)> {
    let held = merged(records.listed[family].clone());
    held.into_iter().flat_map(|range| routable(range, family)).collect()
}

pub fn write(records: &Records, date: &str) -> String {
    let held: [Vec<String>; 2] = [0, 1].map(|family| {
        let bits = match family {
            0 => 32,
            _ => 128,
        };
        let mut out = Vec::new();
        for (first, last) in ranges(records, family) {
            blocks(first, last, bits, &mut out);
        }
        out
    });
    let mut text = format!(
        "#\n\
         # blocklist.netset\n\
         #\n\
         # ipv4+ipv6 hash:net netset\n\
         #\n\
         # Addresses feeds reported at {FLOOR}/100 or above, and the addresses a\n\
         # current list names as running an anonymising service. Only what was said\n\
         # about the address itself counts: a network's own score is left out, so a\n\
         # bad neighbourhood alone never lands an address here.\n\
         #\n\
         # Maintainer      : plevin\n\
         # Maintainer URL  : https://github.com/tn3w/plevin\n\
         # List source URL : {FEEDS}\n\
         # Source File Date: {date} 00:00:00 UTC\n\
         # Category        : reputation\n\
         # Version         : 1\n\
         #\n\
         # Threshold       : reported >= {FLOOR}, or a published service\n\
         # Entries (v4)    : {}\n\
         # Entries (v6)    : {}\n\
         #\n",
        held[0].len(),
        held[1].len(),
    );
    for entry in held.into_iter().flatten() {
        let _ = writeln!(text, "{entry}");
    }
    text
}

#[cfg(test)]
mod tests {
    use super::{blocks, merged, opens, public, routable};

    fn held(first: u128, last: u128, bits: u32) -> Vec<String> {
        let mut out = Vec::new();
        blocks(first, last, bits, &mut out);
        out
    }

    #[test]
    fn every_address_is_one_network() {
        assert_eq!(held(0, u128::MAX, 128), ["::/0"]);
        assert_eq!(held(0, u32::MAX as u128, 32), ["0.0.0.0/0"]);
    }

    #[test]
    fn a_single_address_carries_no_prefix() {
        assert_eq!(held(0x01000001, 0x01000001, 32), ["1.0.0.1"]);
    }

    #[test]
    fn an_aligned_range_is_the_network_it_spells() {
        assert_eq!(held(0x0100_0000, 0x0100_00FF, 32), ["1.0.0.0/24"]);
    }

    #[test]
    fn an_unaligned_range_is_cut_at_its_alignment() {
        assert_eq!(held(1, 4, 32), ["0.0.0.1", "0.0.0.2/31", "0.0.0.4"]);
    }

    #[test]
    fn reserved_space_is_taken_out_of_a_range() {
        assert_eq!(routable((0, 0), 0), []);
        assert_eq!(routable((0x0A00_0000, 0x0A00_0001), 0), []);
        assert_eq!(routable((0x0100_0000, 0x0100_0001), 0), [(0x0100_0000, 0x0100_0001)]);
        assert_eq!(routable((1, 1 << 125), 1), [(1 << 125, 1 << 125)]);
    }

    #[test]
    fn reserved_v6_space_is_closed() {
        let runs = public(1);
        assert!(!opens(&runs, 1));
        assert!(opens(&runs, 0x2a01 << 112));
        assert!(!opens(&runs, 0x2001_0db8 << 96));
        assert!(!opens(&runs, 0x2002 << 112));
        assert!(!opens(&runs, 0xfe80 << 112));
    }

    #[test]
    fn public_v4_space_is_open() {
        let runs = public(0);
        assert!(opens(&runs, 0x0101_0101));
        assert!(!opens(&runs, 0x0A00_0001));
        assert!(!opens(&runs, u32::MAX as u128));
    }

    #[test]
    fn touching_ranges_become_one() {
        assert_eq!(merged(vec![(4, 6), (1, 3), (9, 9)]), [(1, 6), (9, 9)]);
    }
}
