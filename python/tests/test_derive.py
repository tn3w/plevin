"""The answers read off the stored ones."""

from __future__ import annotations

import pytest

from plevin import derive


@pytest.mark.parametrize(
    ("text", "cased"),
    [("GOOGLE", "Google"), ("IBM", "IBM"), ("Google", "Google"), ("OVH1", "OVH1")],
)
def test_shouted_words_stop_shouting(text: str, cased: str) -> None:
    assert derive._cased(text) == cased


@pytest.mark.parametrize(
    ("company", "name"),
    [
        ("Google LLC", "Google"),
        ("Acme Inc, a Delaware corporation", "Acme"),
        ("Contoso (Europe) GmbH", "Contoso"),
        ("Somebody trading as Fastnet Ltd", "Fastnet"),
        ("The Hosting Company", ""),
        ('"Quoted" Networks', "Quoted"),
        ("example.com", "example"),
        ("Hosting", "Hosting"),
        ("", ""),
        ("Acme - the good one", "Acme"),
    ],
)
def test_a_company_reduces_to_the_name_it_is_known_by(company: str, name: str) -> None:
    assert derive._from_company(company) == name


@pytest.mark.parametrize(
    ("handle", "head"),
    [
        ("GOOGLE", "Google"),
        ("CLOUDFLARENET", "Cloudflare"),
        ("ONE-AS", "ONE"),
        ("AS15169", ""),
        ("", ""),
        ("TWO WORDS", "TWO"),
    ],
)
def test_a_handle_reduces_to_its_first_word(handle: str, head: str) -> None:
    assert derive._from_handle(handle) == head


@pytest.mark.parametrize(
    ("handle", "company", "name"),
    [
        ("GOOGLE", "Google LLC", "Google"),
        ("AS15169", "Google LLC", "Google"),
        ("GOOGLE", "", "Google"),
        ("CLOUDFLARENET", "Cloudflare, Inc.", "Cloudflare"),
        ("HETZNER-AS", "Hetzner Online GmbH", "Hetzner"),
        ("EXAMPLE", "Example Holdings of Somewhere", "Example"),
        ("", "", ""),
    ],
)
def test_a_network_goes_by_the_shorter_of_its_two_names(
    handle: str, company: str, name: str
) -> None:
    assert derive.brand(handle, company) == name


def test_an_upper_case_handle_wins_where_the_company_only_spells_it_out() -> None:
    assert derive.brand("IBM", "IBM") == "IBM"


@pytest.mark.parametrize(
    ("website", "mailbox", "host"),
    [
        ("https://about.google/intl/en/", "network-abuse@google.com", "google.com"),
        ("https://www.cloudflare.com", "abuse@cloudflare.com", "cloudflare.com"),
        ("", "abuse@example.org", "example.org"),
        ("https://user:pass@example.net:8080/path", "", "example.net"),
        ("https://example.io?query=1", "", "example.io"),
        ("", "", ""),
        ("https://home.cern", "abuse@cern.ch", "cern.ch"),
    ],
)
def test_the_domain_is_the_site_unless_the_mailbox_knows_better(
    website: str, mailbox: str, host: str
) -> None:
    assert derive.domain(website, mailbox) == host


@pytest.mark.parametrize(
    ("named", "user_type", "answer"),
    [
        ("public_proxy", "residential", ("residential_proxy", "inferred")),
        ("public_proxy", "cellular", ("residential_proxy", "inferred")),
        ("public_proxy", "hosting", ("public_proxy", "")),
        ("tor_exit_node", "residential", ("tor_exit_node", "")),
        ("", "", ("", "")),
    ],
)
def test_a_public_proxy_on_an_access_network_is_a_resold_home_line(
    named: str, user_type: str, answer: tuple[str, str]
) -> None:
    assert derive.service(named, user_type) == answer


@pytest.mark.parametrize(
    ("kind", "capital"),
    [("national capital", "country"), ("regional capital", "region"),
     ("district capital", "district"), ("city", ""), ("", "")],
)
def test_the_city_type_says_which_capital_it_is(kind: str, capital: str) -> None:
    assert derive.capital(kind) == capital
