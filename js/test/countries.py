"""Write src/countries.ts from pycountry, babel and phonenumbers."""

from pathlib import Path

import phonenumbers
import pycountry
from babel.languages import get_official_languages
from babel.numbers import get_currency_name, get_territory_currencies

TARGET = Path(__file__).parent.parent / "src" / "countries.ts"
DOC = "Per country: code, iso3, numeric, three names, currency, calling code, languages."
EXTRA = ("XK",)


def row(code: str) -> str:
    country = pycountry.countries.get(alpha_2=code)
    money = get_territory_currencies(code)
    currency = money[0] if money else ""
    prefix = phonenumbers.country_code_for_region(code)
    return "|".join((
        code,
        getattr(country, "alpha_3", ""),
        getattr(country, "numeric", ""),
        getattr(country, "name", ""),
        getattr(country, "official_name", ""),
        getattr(country, "common_name", ""),
        currency,
        get_currency_name(currency, locale="en") if currency else "",
        f"+{prefix}" if prefix else "",
        ",".join(get_official_languages(code, de_facto=True)),
    ))


codes = sorted({country.alpha_2 for country in pycountry.countries} | set(EXTRA))
body = "\n".join(row(code) for code in codes)
tail = '`\n  .trim()\n  .split("\\n");\n'
TARGET.write_text(f"/** {DOC} */\n\nexport const COUNTRIES = `\n{body}\n{tail}")
