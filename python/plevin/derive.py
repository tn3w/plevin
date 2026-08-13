"""The answers the file does not store, read off the ones it does."""

from __future__ import annotations

import re
from functools import lru_cache

FORMS = frozenset(
    "inc incorporated llc ltd ltda limited gmbh mbh ag kgaa ohg ev eg sa sab saa sau"
    " sal saog sac sas sarl srl spa nv bv cv asa aps oyj kft zrt nyrt doo sro ooo zao"
    " pao pjsc jsc ojsc llp plc pte pteltd pty corp corporation company holding"
    " holdings group uab sia tov oao pt sdn bhd coltd coltda eireli ead ood eood sti"
    " ltdsti spzoo".split()
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
TAIL = FORMS | TAILS | frozenset({""})
TLDS = (".com", ".net", ".org", ".io")

TRADING = re.compile(r"(?i).*\b(?:trading as|d/b/a|dba)\b\s*")
ALIAS = re.compile(r"\(.*?\)|,.*|\s+-\s+.*")
BARE = re.compile(r"[^0-9a-z]")
NUMBERED = re.compile(r"AS\d+", re.I)
HANDLE_TAIL = re.compile(r"-(AS|AP|US|UK|DE|FR|IN|CN|JP|EU|NET|COM|ORG)$")
NETWORK_TAIL = re.compile(r"(NET|COM|TEL|WEB|LINE)$")
AUTHORITY = re.compile(r"[/?#]")

SERVERS = frozenset({"hosting", "cdn", "content"})
ACCESS = frozenset({"residential", "cellular"})
PROXIES = frozenset({"public_proxy", "residential_proxy"})
NAMES = 1 << 13
CAPITALS = {"national capital": "country", "regional capital": "region",
            "district capital": "district"}


def _cased(text: str) -> str:
    """Shouted words stop shouting, `GOOGLE` reading as `Google` and `IBM` as `IBM`."""
    return " ".join(
        word.title() if word.isalpha() and word.isupper() and len(word) > 4 else word
        for word in text.split(" ")
    )


def _from_company(company: str) -> str:
    """Aliases, legal forms and the words every network shares, all stripped."""
    words = ALIAS.sub("", TRADING.sub("", company)).split()
    tokens = [token for word in words if (token := word.strip("\"'"))]
    while len(tokens) > 1 and BARE.sub("", tokens[-1].lower()) in TAIL:
        tokens.pop()
    while tokens and BARE.sub("", tokens[0].lower()) in LEAD:
        tokens.pop(0)
    name = " ".join(tokens)
    cut = next((len(tld) for tld in TLDS if name.lower().endswith(tld)), 0)
    return _cased(name[: len(name) - cut])


def _from_handle(handle: str) -> str:
    """The first word of a registry handle, its country and network tails gone."""
    words = handle.split()
    head = HANDLE_TAIL.sub("", words[0]) if words else ""
    if NUMBERED.fullmatch(head):
        return ""
    if len(head) > 4 and head.isupper():
        head = NETWORK_TAIL.sub("", head)
    return _cased(head)


@lru_cache(maxsize=NAMES)
def brand(handle: str, company: str) -> str:
    """The name a network goes by: its handle where the company only spells it out."""
    legal, short = _from_company(company), _from_handle(handle)
    if not legal or not short:
        return legal or short
    if legal.lower() == short.lower():
        return legal if short.isupper() else short
    return short if legal.lower().startswith(f"{short.lower()} ") else legal


@lru_cache(maxsize=NAMES)
def domain(website: str, mailbox: str) -> str:
    """The bare host the website names, else the one the abuse mailbox does."""
    authority = AUTHORITY.split(website.rpartition("//")[2], maxsplit=1)[0]
    host = authority.rpartition("@")[2].partition(":")[0]
    site = (host or mailbox.partition("@")[2]).lower().removeprefix("www.")
    box = mailbox.partition("@")[2].lower()
    top = site.rpartition(".")[2]
    if len(top) > 2 and box.partition(".")[0] == top and site != box:
        return box
    return site


def service(named: str, user_type: str) -> tuple[str, str]:
    """A public proxy on an access network is someone's home line, resold."""
    if named == "public_proxy" and user_type in ACCESS:
        return "residential_proxy", "inferred"
    return named, ""


def capital(city_type: str) -> str:
    """The city type already says which capital it is, so nothing stores it twice."""
    return CAPITALS.get(city_type, "")
