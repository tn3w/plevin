//! The name a network goes by, made here so a file can carry it without the parts.

const FORMS: &str = "inc incorporated llc ltd ltda limited gmbh mbh ag kgaa ohg ev eg \
sa sab saa sau sal saog sac sas sarl srl spa nv bv cv asa aps oyj kft zrt nyrt doo sro \
ooo zao pao pjsc jsc ojsc llp plc pte pteltd pty corp corporation company holding \
holdings group uab sia tov oao pt sdn bhd coltd coltda eireli ead ood eood sti ltdsti \
spzoo";
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

/// The name a network goes by: its handle where the company only spells it out.
pub fn brand(handle: &str, company: &str) -> String {
    let legal = from_company(company);
    let short = from_handle(handle);
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

/// Aliases, legal forms and the words every network shares, all stripped.
fn from_company(company: &str) -> String {
    let held = aliased(&traded(company));
    let mut tokens: Vec<&str> = held
        .split_whitespace()
        .map(|word| word.trim_matches(['"', '\'']))
        .filter(|word| !word.is_empty())
        .collect();
    while tokens.len() > 1 && tailing(tokens[tokens.len() - 1]) {
        tokens.pop();
    }
    while !tokens.is_empty() && listed(LEAD, &bare(tokens[0])) {
        tokens.remove(0);
    }
    let name = tokens.join(" ");
    let cut = TLDS.iter().find(|tld| ending(&name, tld)).map_or(0, |tld| tld.len());
    cased(&name[..name.len() - cut])
}

/// The first word of a registry handle, its country and network tails gone.
fn from_handle(handle: &str) -> String {
    let Some(word) = handle.split_whitespace().next() else {
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

/// Everything up to the last "trading as", which is the name the network answers to.
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

/// A word on its own: a mark only counts where letters do not run into it.
fn edged(held: &[char], start: usize, stop: usize) -> bool {
    let bare = |one: Option<&char>| {
        one.is_none_or(|held| !held.is_alphanumeric() && *held != '_')
    };
    bare(start.checked_sub(1).and_then(|at| held.get(at))) && bare(held.get(stop))
}

/// A bracketed aside, a comma or a spaced dash: from there on it is not the name.
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

/// Shouted words stop shouting, `GOOGLE` reading as `Google` and `IBM` as `IBM`.
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

/// The legal forms and the words every network shares, both read as one list.
fn tailing(token: &str) -> bool {
    let held = bare(token);
    held.is_empty() || listed(FORMS, &held) || listed(TAILS, &held)
}

/// A word as the readers compare it: only letters and digits, all lowercase.
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
