//! The addresses plevin scores high enough to turn away, as CIDR a firewall can read.

use crate::abuse::Records;
use std::fmt::Write;
use std::net::{Ipv4Addr, Ipv6Addr};

/// Evidence a current list stands behind, as against an aggregate of every proxy ever
/// seen: `published`, `measured`, then `reported`, which is the one this stops short of.
pub const LISTED: u8 = 2;

/// Where blocking starts: the weight one feed of standing carries on its own.
pub const FLOOR: u8 = 40;

/// A range as the fewest aligned networks covering it, which is what a netset carries.
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

/// Neighbours and overlaps read as one range, so the same address is never written twice.
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

const fn v4(a: u8, b: u8, c: u8, d: u8, prefix: u32) -> (u128, u128) {
    let at = ((a as u128) << 24) | ((b as u128) << 16) | ((c as u128) << 8) | d as u128;
    (at, at + (1 << (32 - prefix)) - 1)
}

/// No client answers from here, so a feed naming it has named nothing worth blocking.
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

/// Global unicast, the one v6 range an address on the public internet comes out of.
const UNICAST: (u128, u128) = (1 << 125, (1 << 126) - 1);

/// What is left of a range once the space that answers for nobody is taken out of it.
fn routable(held: (u128, u128), family: usize) -> Vec<(u128, u128)> {
    if family == 1 {
        let (first, last) = (held.0.max(UNICAST.0), held.1.min(UNICAST.1));
        return match first <= last {
            true => vec![(first, last)],
            false => Vec::new(),
        };
    }
    let mut out = vec![held];
    for cut in RESERVED {
        out = out.into_iter().flat_map(|range| without(range, *cut)).collect();
    }
    out
}

/// One range with another taken out of it: nothing, one side, the other, or both.
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

/// The ranges the fold marked, cut to what a public address can actually come from.
fn ranges(records: &Records, family: usize) -> Vec<(u128, u128)> {
    let held = merged(records.listed[family].clone());
    held.into_iter().flat_map(|range| routable(range, family)).collect()
}

/// The list a firewall loads, with the header the netset convention asks for.
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
         # List source URL : https://github.com/tn3w/plevin/tree/master/builder/data/feeds.json\n\
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
    use super::{blocks, merged, routable};

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
    fn touching_ranges_become_one() {
        assert_eq!(merged(vec![(4, 6), (1, 3), (9, 9)]), [(1, 6), (9, 9)]);
    }
}
