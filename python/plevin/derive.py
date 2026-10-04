"""The answers the file does not store, read off the ones it does."""

from __future__ import annotations

import re
from functools import lru_cache

FORMS = frozenset(
    "inc incorporated llc ltd ltda limited gmbh mbh ag kgaa ohg ev eg sa sab saa sau"
    " sal saog sac sas sarl srl spa nv bv cv asa aps oyj kft zrt nyrt doo sro ooo zao"
    " pao pjsc jsc ojsc llp plc pte pteltd pty corp corporation company holding"
    " holdings group uab sia tov oao pt sdn bhd coltd coltda eireli ead ood eood sti"
    " ltdsti spzoo anonim sirketi tbk".split()
)
TAILS = frozenset(
    "de me epp co as ab ad dd bt lc lp se sl slu sp z oo zoo oy ao esp kg network"
    " networks net telecom telecoms telecommunication telecommunications"
    " telecomunicaciones comunicaciones communication communications hosting solutions"
    " services service technologies technology tech systems system data datacenter"
    " datacentre cloud internet online isp international global enterprises enterprise"
    " backbone provider providers of and".split()
)
LEAD = frozenset(
    "the llc ltd gmbh sarl ooo zao pao ao oao jsc ojsc pjsc uab sia tov pt pp ps ip"
    " spolka".split()
)
LEGAL = FORMS | frozenset({""})
GENERIC = FORMS | TAILS | frozenset("telekom broadband wireless mobile".split())
TLDS = (".com", ".net", ".org", ".io")
SHARED = frozenset(
    "gmail.com googlemail.com yahoo.com yahoo.co.jp yahoo.com.br yahoo.es hotmail.com"
    " hotmail.es outlook.com live.com msn.com aol.com icloud.com proton.me"
    " protonmail.com qq.com 163.com 126.com sina.com sohu.com foxmail.com yandex.ru"
    " ya.ru mail.ru list.ru bk.ru inbox.ru rambler.ru gmx.de gmx.net web.de"
    " t-online.de orange.fr free.fr libero.it wp.pl o2.pl interia.pl seznam.cz abv.bg"
    " ukr.net i.ua naver.com hanmail.net daum.net rediffmail.com bol.com.br"
    " uol.com.br terra.com.br ig.com.br facebook.com twitter.com x.com linkedin.com"
    " instagram.com youtube.com".split()
)
PUBLIC = frozenset("gov mil edu gob gouv govt ac go sch".split())
SECONDS = frozenset(
    "ac co com ed edu go gob gov gouv govt gv ltd me mil ne net nom or org plc sch"
    .split()
)

TRADING = re.compile(r"(?i).*\b(?:trading as|d/b/a|dba)\b\s*")
WORDS = re.compile(r"[\s_,.&/()-]+")
ALIAS = re.compile(r"\(.*?\)|,.*|\s+-\s+.*")
BARE = re.compile(r"[^0-9a-z]")
NUMBERED = re.compile(r"AS\d+", re.I)
HANDLE_TAIL = re.compile(r"-(AS|AP|US|UK|DE|FR|IN|CN|JP|EU|NET|COM|ORG)$")
NETWORK_TAIL = re.compile(r"(NET|COM|TEL|WEB|LINE)$")
AUTHORITY = re.compile(r"[/?#]")

SERVERS = frozenset({"hosting", "cdn", "content"})
ACCESS = frozenset({"residential", "cellular"})
PROXIES = frozenset({"public_proxy", "residential_proxy"})
CRAWLER = "search_engine_spider"
NAMES = 1 << 13
CAPITALS = {"national capital": "country", "regional capital": "region",
            "district capital": "district"}


def _cased(text: str) -> str:
    return " ".join(
        word.title() if word.isalpha() and word.isupper() and len(word) > 4 else word
        for word in text.split(" ")
    )


def _trailing(tokens: list[str]) -> bool:
    word = BARE.sub("", tokens[-1].lower()) if tokens else ""
    return (len(tokens) > 1 and word in LEGAL) or (len(tokens) > 2 and word in TAILS)


def _from_company(company: str) -> str:
    words = ALIAS.sub("", TRADING.sub("", company)).split()
    tokens = [token for word in words if (token := word.strip("\"'"))]
    while _trailing(tokens):
        tokens.pop()
    while tokens and BARE.sub("", tokens[0].lower()) in LEAD:
        tokens.pop(0)
    name = " ".join(tokens)
    cut = next((len(tld) for tld in TLDS if name.lower().endswith(tld)), 0)
    return _cased(name[: len(name) - cut])


def _from_handle(handle: str) -> str:
    words = handle.split()
    head = HANDLE_TAIL.sub("", words[0]) if len(words) == 1 else ""
    if NUMBERED.fullmatch(head):
        return ""
    if len(head) > 4 and head.isupper():
        head = NETWORK_TAIL.sub("", head)
    return _cased(head)


@lru_cache(maxsize=NAMES)
def brand(handle: str, company: str) -> str:
    legal, short = _from_company(company), _from_handle(handle)
    if company.lower() == handle.lower():
        return short or legal
    if not legal or not short:
        return legal or short
    if legal.lower() == short.lower():
        return legal if short.isupper() else short
    return short if legal.lower().startswith(f"{short.lower()} ") else legal


def _related(site: str, names: str) -> bool:
    """Whether a site's name echoes the names it is claimed by."""
    labels = site.split(".")
    key = BARE.sub("", labels[0])
    joined = BARE.sub("", names.lower())
    if (len(key) > 2 and key in joined) or (len(key) == 2 and joined.startswith(key)):
        return True
    words = (BARE.sub("", word) for word in WORDS.split(names.lower()))
    if any(len(word) > 3 and word not in GENERIC and word in key for word in words):
        return True
    return any(label in PUBLIC for label in labels[1:])


def _registrable(host: str) -> str:
    """The owned part of a host, keeping two-label public suffixes whole."""
    labels = host.split(".")
    if len(labels) < 3:
        return host
    deep = len(labels[-1]) == 2 and labels[-2] in SECONDS
    return ".".join(labels[-3 if deep else -2:])


@lru_cache(maxsize=NAMES)
def domain(website: str, mailbox: str, names: str = "") -> str:
    """The operator's own domain, from its site, else a mailbox that matches its names."""
    authority = AUTHORITY.split(website.rpartition("//")[2], maxsplit=1)[0]
    host = authority.rpartition("@")[2].partition(":")[0].lower().removeprefix("www.")
    box = _registrable(mailbox.partition("@")[2].lower())
    site = _registrable(host)
    box = "" if box in SHARED else box
    site = "" if site in SHARED else site
    if not site:
        return box if box and _related(box, names) else ""
    top = site.rpartition(".")[2]
    if len(top) > 2 and box.partition(".")[0] == top and site != box:
        return box
    return site


def website(host: str) -> str:
    """A stored host as a full https address."""
    return f"https://{host}" if host else ""


def service(named: str, user_type: str) -> tuple[str, str]:
    if named == "public_proxy" and user_type in ACCESS:
        return "residential_proxy", "inferred"
    return named, ""


def capital(city_type: str) -> str:
    return CAPITALS.get(city_type, "")
