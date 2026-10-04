//! The name and kind a network goes by, made here so a file can carry them as one.

use crate::gazetteer::fold;
use crate::{CATEGORIES, word, worded};
use serde_json::Value;

const FORMS: &str = "inc incorporated llc ltd ltda limited gmbh mbh ag kgaa ohg ev eg \
sa sab saa sau sal saog sac sas sarl srl spa nv bv cv asa aps oyj kft zrt nyrt doo sro \
ooo zao pao pjsc jsc ojsc llp plc pte pteltd pty corp corporation company holding \
holdings group uab sia tov oao pt sdn bhd coltd coltda eireli ead ood eood sti ltdsti \
spzoo anonim sirketi tbk";
const TAILS: &str = "de me epp co as ab ad dd bt lc lp se sl slu sp z oo zoo oy ao esp \
kg network networks net telecom telecoms telecommunication telecommunications \
telecomunicaciones comunicaciones communication communications hosting solutions \
services service technologies technology tech systems system data datacenter \
datacentre cloud internet online isp international global enterprises enterprise \
backbone provider providers of and";
const LEAD: &str = "the llc ltd gmbh sarl ooo zao pao ao oao jsc ojsc pjsc uab sia tov \
pt pp ps ip spolka";
const TLDS: [&str; 4] = [".com", ".net", ".org", ".io"];
const TRADING: [&str; 3] = ["trading as", "d/b/a", "dba"];
const HANDLE_TAIL: [&str; 13] = [
    "-AS", "-AP", "-US", "-UK", "-DE", "-FR", "-IN", "-CN", "-JP", "-EU", "-NET", "-COM",
    "-ORG",
];
const NETWORK_TAIL: [&str; 5] = ["NET", "COM", "TEL", "WEB", "LINE"];

pub fn brand(handle: &str, company: &str) -> String {
    let legal = from_company(company);
    let short = from_handle(handle);
    if company.to_lowercase() == handle.to_lowercase() {
        return if short.is_empty() { legal } else { short };
    }
    if legal.is_empty() || short.is_empty() {
        return if legal.is_empty() { short } else { legal };
    }
    let (spelled, called) = (legal.to_lowercase(), short.to_lowercase());
    if spelled == called {
        return if shouted(&short) { legal } else { short };
    }
    match spelled.starts_with(&format!("{called} ")) {
        true => short,
        false => legal,
    }
}

fn from_company(company: &str) -> String {
    let held = aliased(&traded(company));
    let mut tokens: Vec<&str> = held
        .split_whitespace()
        .map(|word| word.trim_matches(['"', '\'']))
        .filter(|word| !word.is_empty())
        .collect();
    while trailing(&tokens) {
        tokens.pop();
    }
    while !tokens.is_empty() && listed(LEAD, &bare(tokens[0])) {
        tokens.remove(0);
    }
    let name = tokens.join(" ");
    let cut = TLDS.iter().find(|tld| ending(&name, tld)).map_or(0, |tld| tld.len());
    cased(&name[..name.len() - cut])
}

fn from_handle(handle: &str) -> String {
    let words: Vec<&str> = handle.split_whitespace().collect();
    let [word] = words[..] else {
        return String::new();
    };
    let head =
        HANDLE_TAIL.iter().find_map(|tail| word.strip_suffix(tail)).unwrap_or(word);
    if numbered(head) {
        return String::new();
    }
    let held = match head.chars().count() > 4 && shouted(head) {
        true => {
            NETWORK_TAIL.iter().find_map(|tail| head.strip_suffix(tail)).unwrap_or(head)
        }
        false => head,
    };
    cased(held)
}

fn traded(company: &str) -> String {
    let held: Vec<char> = company.chars().collect();
    let mut at = 0;
    for mark in TRADING {
        let width = mark.chars().count();
        for start in 0..held.len().saturating_sub(width - 1) {
            let same = mark
                .chars()
                .enumerate()
                .all(|(step, one)| held[start + step].to_ascii_lowercase() == one);
            if same && edged(&held, start, start + width) {
                at = at.max(start + width);
            }
        }
    }
    held[at..].iter().collect::<String>().trim_start().to_string()
}

fn edged(held: &[char], start: usize, stop: usize) -> bool {
    let bare = |one: Option<&char>| {
        one.is_none_or(|held| !held.is_alphanumeric() && *held != '_')
    };
    bare(start.checked_sub(1).and_then(|at| held.get(at))) && bare(held.get(stop))
}

fn aliased(company: &str) -> String {
    let held: Vec<char> = company.chars().collect();
    let mut out = String::new();
    let mut at = 0;
    while at < held.len() {
        if let Some(close) = (held[at] == '(')
            .then(|| held[at + 1..].iter().position(|one| *one == ')'))
            .flatten()
        {
            at += close + 2;
            continue;
        }
        if held[at] == ',' || dashed(&held, at) {
            break;
        }
        out.push(held[at]);
        at += 1;
    }
    out
}

fn dashed(held: &[char], at: usize) -> bool {
    if !held[at].is_whitespace() {
        return false;
    }
    let mut spot = at;
    while spot < held.len() && held[spot].is_whitespace() {
        spot += 1;
    }
    held.get(spot) == Some(&'-')
        && held.get(spot + 1).is_some_and(|one| one.is_whitespace())
}

fn cased(text: &str) -> String {
    text.split(' ')
        .map(|word| {
            let letters = !word.is_empty() && word.chars().all(char::is_alphabetic);
            match letters && shouted(word) && word.chars().count() > 4 {
                true => titled(word),
                false => word.to_string(),
            }
        })
        .collect::<Vec<String>>()
        .join(" ")
}

fn titled(word: &str) -> String {
    let mut held = word.chars();
    match held.next() {
        None => String::new(),
        Some(one) => one.to_uppercase().to_string() + &held.as_str().to_lowercase(),
    }
}

fn shouted(word: &str) -> bool {
    !word.chars().any(char::is_lowercase) && word.chars().any(char::is_uppercase)
}

fn numbered(head: &str) -> bool {
    let mut held = head.chars();
    let starts = held.next().is_some_and(|one| one.eq_ignore_ascii_case(&'a'))
        && held.next().is_some_and(|one| one.eq_ignore_ascii_case(&'s'));
    let digits = held.as_str();
    starts && !digits.is_empty() && digits.bytes().all(|one| one.is_ascii_digit())
}

fn ending(name: &str, tld: &str) -> bool {
    let at = name.len().checked_sub(tld.len());
    at.is_some_and(|at| name.is_char_boundary(at) && name[at..].eq_ignore_ascii_case(tld))
}

fn trailing(tokens: &[&str]) -> bool {
    let Some(last) = tokens.last() else { return false };
    let held = bare(last);
    let legal = held.is_empty() || listed(FORMS, &held);
    (tokens.len() > 1 && legal) || (tokens.len() > 2 && listed(TAILS, &held))
}

fn bare(token: &str) -> String {
    token
        .to_lowercase()
        .chars()
        .filter(|one| one.is_ascii_digit() || one.is_ascii_lowercase())
        .collect()
}

fn listed(book: &str, held: &str) -> bool {
    !held.is_empty() && book.split(' ').any(|word| word == held)
}

type Table = Vec<(String, Vec<String>)>;

#[derive(Default)]
pub struct Rules {
    suffixes: Table,
    seconds: Table,
    keywords: Table,
    overrides: Table,
    placeholders: Vec<String>,
    junk: Vec<String>,
    eyeballs: u32,
}

const EDGE: u8 = 3;

const ZERO_WIDTH: [char; 6] =
    ['\u{200b}', '\u{200c}', '\u{200d}', '\u{200e}', '\u{200f}', '\u{feff}'];

const NON_BREAKING: [char; 3] = ['\u{a0}', '\u{2028}', '\u{2029}'];

const SEPARATORS: &str = ",;:/-_|";

fn unmojibaked(text: &str) -> String {
    let marked = text.chars().any(|point| point == 'Ã' || point == 'Â');
    let bytes: Option<Vec<u8>> =
        text.chars().map(|point| u8::try_from(point as u32).ok()).collect();
    match (marked, bytes.and_then(|held| String::from_utf8(held).ok())) {
        (true, Some(mended)) => mended,
        _ => text.to_string(),
    }
}

fn words(list: &Value) -> Vec<String> {
    let names = list.as_array().into_iter().flatten();
    names.filter_map(|name| name.as_str()).map(str::to_string).collect()
}

fn table(held: &Value) -> Table {
    held.as_object()
        .into_iter()
        .flatten()
        .map(|(name, list)| (name.clone(), words(list)))
        .collect()
}

fn kind_of(name: &str) -> Option<&'static str> {
    CATEGORIES.iter().find(|held| **held == name).copied()
}

fn holding(table: &Table, word: &str) -> Option<&'static str> {
    let found = table.iter().find(|(_, words)| words.iter().any(|held| held == word));
    found.and_then(|(name, _)| kind_of(name))
}

impl Rules {
    pub fn read(held: &Value) -> Rules {
        Rules {
            suffixes: table(&held["suffixes"]),
            seconds: table(&held["seconds"]),
            keywords: table(&held["keywords"]),
            overrides: table(&held["overrides"]),
            placeholders: words(&held["placeholders"]),
            junk: words(&held["junk"]),
            eyeballs: held["eyeballs"].as_u64().unwrap_or(u64::MAX) as u32,
        }
    }

    pub fn tidy(&self, text: &str) -> String {
        let mended = unmojibaked(text);
        let spaced: String = mended
            .chars()
            .filter(|point| !ZERO_WIDTH.contains(point))
            .map(|point| if NON_BREAKING.contains(&point) { ' ' } else { point })
            .collect();
        let joined = spaced.split_whitespace().collect::<Vec<&str>>().join(" ");
        let trimmed =
            joined.trim_matches(|point: char| SEPARATORS.contains(point) || point == ' ');
        let letters = trimmed.chars().filter(|point| point.is_alphanumeric()).count();
        let queries = trimmed.chars().filter(|point| *point == '?').count();
        let named =
            self.placeholders.iter().any(|held| held.eq_ignore_ascii_case(trimmed));
        let lower = joined.to_lowercase();
        let pasted = self.junk.iter().any(|held| lower.contains(held.as_str()));
        match letters == 0 || queries * 3 > trimmed.chars().count() || named || pasted {
            true => String::new(),
            false => trimmed.to_string(),
        }
    }

    pub fn site(&self, website: &str) -> String {
        let site = website.trim();
        let rest = site.split_once("://").map_or(site, |(_, rest)| rest);
        let (host, path) = rest.split_once('/').unwrap_or((rest, ""));
        let host = host.to_lowercase();
        let host = host.strip_prefix("www.").unwrap_or(&host);
        let name = host.split(':').next().unwrap_or("");
        let numbered = name.split('.').all(|part| part.parse::<u8>().is_ok());
        let named = self.placeholders.iter().any(|held| held == name);
        match (name.contains('.') && !numbered && !named, path.is_empty()) {
            (false, _) => String::new(),
            (true, true) => host.to_string(),
            (true, false) => format!("{host}/{}", path.trim_end_matches('/')),
        }
    }

    pub fn mailbox(&self, text: &str) -> String {
        let held = self.tidy(text);
        let valid = held.split_once('@').is_some_and(|(name, tail)| {
            !name.is_empty() && tail.contains('.') && !held.contains(' ')
        });
        match valid {
            true => held,
            false => String::new(),
        }
    }

    pub fn beats(&self, claim: &str, held: &str) -> bool {
        let found = self.overrides.iter().find(|(name, _)| name == claim);
        found.is_some_and(|(_, beaten)| beaten.iter().any(|name| name == held))
    }

    fn suffixed(&self, host: &str) -> Option<&'static str> {
        let labels: Vec<&str> = host.split('.').collect();
        let near = &labels[labels.len().saturating_sub(3)..];
        let last = near.last().copied().unwrap_or("");
        if let Some(name) = holding(&self.suffixes, last) {
            return Some(name);
        }
        let [.., second, last] = near else { return None };
        if last.len() != 2 {
            return None;
        }
        holding(&self.seconds, second)
    }

    fn named(&self, text: &str) -> Option<&'static str> {
        let found = self
            .keywords
            .iter()
            .find(|(_, words)| words.iter().any(|held| worded(text, held)));
        found.and_then(|(name, _)| kind_of(name))
    }

    pub fn guess(
        &self,
        handle: &str,
        company: &str,
        host: &str,
        users: u32,
        tier: u8,
    ) -> u8 {
        let text = fold(&format!("{handle} {company}"));
        let edge = users >= self.eyeballs && tier == EDGE;
        let found = self
            .suffixed(host)
            .or_else(|| self.named(&text))
            .or(edge.then_some("residential"));
        found.map_or(0, |name| word(CATEGORIES, name))
    }
}

pub fn host(website: &str, mailbox: &str) -> String {
    let rest = website.rsplit("//").next().unwrap_or("");
    let authority = rest.split(['/', '?', '#']).next().unwrap_or("");
    let site = authority.rsplit('@').next().unwrap_or("");
    let site = site.split(':').next().unwrap_or("").to_lowercase();
    match site.is_empty() {
        true => mailbox.split_once('@').map_or("", |(_, tail)| tail).to_lowercase(),
        false => site,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn kinds() -> Rules {
        Rules::read(&crate::read::data("operators.json")["categories"])
    }

    fn kind(handle: &str, company: &str, host: &str, users: u32) -> &'static str {
        CATEGORIES[kinds().guess(handle, company, host, users, 3) as usize]
    }

    #[test]
    fn a_domain_suffix_names_the_kind() {
        assert_eq!(kind("", "", "nic.mil", 0), "military");
        assert_eq!(kind("", "", "mit.edu", 0), "education");
        assert_eq!(kind("", "", "ox.ac.uk", 0), "education");
        assert_eq!(kind("", "", "agency.go.jp", 0), "government");
        assert_eq!(kind("", "", "example.gov.br", 0), "government");
        assert_eq!(kind("", "", "example.com", 0), "");
    }

    #[test]
    fn a_name_carries_the_kind() {
        assert_eq!(kind("", "Universidad de Chile", "", 0), "education");
        assert_eq!(kind("", "Acme Webhosting GmbH", "", 0), "");
        assert_eq!(kind("", "Ministry of Finance", "", 0), "government");
    }

    #[test]
    fn users_make_an_eyeball_network_only_at_the_edge() {
        assert_eq!(kind("", "Acme", "", 5000), "residential");
        assert_eq!(kind("", "Acme", "", 10), "");
        assert_eq!(kinds().guess("", "Acme", "", 5000, 2), 0);
    }

    #[test]
    fn a_specific_claim_beats_only_the_loose_kinds() {
        assert!(kinds().beats("government", "residential"));
        assert!(kinds().beats("hosting", "content"));
        assert!(!kinds().beats("hosting", "residential"));
        assert!(kinds().beats("cdn", "content"));
        assert!(!kinds().beats("cdn", "residential"));
    }

    #[test]
    fn a_text_is_tidied_of_what_a_registry_leaves_in() {
        let rules = kinds();
        assert_eq!(rules.tidy("  Rua   \u{a0}Verde,  "), "Rua Verde");
        assert_eq!(rules.tidy("PiÃ±as"), "Piñas");
        assert_eq!(rules.tidy("Jl\u{feff}. Baru"), "Jl. Baru");
        assert_eq!(rules.tidy(",,,"), "");
        assert_eq!(rules.tidy("N/A"), "");
        assert_eq!(rules.tidy("-----BEGIN CERTIFICATE----- MIID"), "");
        assert_eq!(rules.tidy("DHCP ??? ??????? ????"), "");
        assert_eq!(rules.tidy("Acme Inc."), "Acme Inc.");
    }

    #[test]
    fn a_website_is_kept_as_host_and_path_only() {
        let rules = kinds();
        assert_eq!(rules.site("HTTPS://www.Example-Corp.com/"), "example-corp.com");
        assert_eq!(rules.site("http://about.google/intl/en/"), "about.google/intl/en");
        assert_eq!(rules.site("http://example.com"), "");
        assert_eq!(rules.site("http://10.1.2.3:80/x"), "");
        assert_eq!(rules.site("not a site"), "");
    }

    #[test]
    fn a_mailbox_needs_a_name_and_a_domain() {
        let rules = kinds();
        assert_eq!(rules.mailbox(" abuse@example-corp.net "), "abuse@example-corp.net");
        assert_eq!(rules.mailbox("abuse at example"), "");
        assert_eq!(rules.mailbox("abuse@localhost"), "");
    }

    #[test]
    fn a_host_is_read_from_the_site_before_the_mailbox() {
        assert_eq!(
            host("https://www.Example.com:8080/a", "x@mail.org"),
            "www.example.com"
        );
        assert_eq!(host("", "abuse@Example.NET"), "example.net");
    }
}
