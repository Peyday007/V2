"""Deterministic normalization for import and matching.

Raw values are always preserved on the record; these functions only feed
the normalized_* matching columns.
"""

import re
from urllib.parse import urlparse

import phonenumbers

STATE_MAP = {
    "alabama": "AL", "alaska": "AK", "arizona": "AZ", "arkansas": "AR",
    "california": "CA", "colorado": "CO", "connecticut": "CT", "delaware": "DE",
    "florida": "FL", "georgia": "GA", "hawaii": "HI", "idaho": "ID",
    "illinois": "IL", "indiana": "IN", "iowa": "IA", "kansas": "KS",
    "kentucky": "KY", "louisiana": "LA", "maine": "ME", "maryland": "MD",
    "massachusetts": "MA", "michigan": "MI", "minnesota": "MN", "mississippi": "MS",
    "missouri": "MO", "montana": "MT", "nebraska": "NE", "nevada": "NV",
    "new hampshire": "NH", "new jersey": "NJ", "new mexico": "NM", "new york": "NY",
    "north carolina": "NC", "north dakota": "ND", "ohio": "OH", "oklahoma": "OK",
    "oregon": "OR", "pennsylvania": "PA", "rhode island": "RI",
    "south carolina": "SC", "south dakota": "SD", "tennessee": "TN", "texas": "TX",
    "utah": "UT", "vermont": "VT", "virginia": "VA", "washington": "WA",
    "west virginia": "WV", "wisconsin": "WI", "wyoming": "WY",
    "district of columbia": "DC",
}

LEGAL_SUFFIXES = [
    "llc", "l.l.c", "inc", "incorporated", "corp", "corporation", "ltd",
    "limited", "co", "company", "llp", "pllc", "pc", "pa",
]

TRACKING_PARAMS_RE = re.compile(r"^(utm_|fbclid|gclid|msclkid)")


def normalize_phone(raw: str | None, region: str = "US") -> str | None:
    """Return E.164 (+1XXXXXXXXXX) or None if unparseable/invalid."""
    if not raw or not raw.strip():
        return None
    try:
        parsed = phonenumbers.parse(raw, region)
    except phonenumbers.NumberParseException:
        return None
    if not phonenumbers.is_valid_number(parsed):
        return None
    return phonenumbers.format_number(parsed, phonenumbers.PhoneNumberFormat.E164)


def normalize_domain(raw: str | None) -> str | None:
    """Strip protocol, www, path, and query. Returns bare registrable host."""
    if not raw or not raw.strip():
        return None
    value = raw.strip().lower()
    if not value.startswith(("http://", "https://")):
        value = "https://" + value
    try:
        host = urlparse(value).hostname
    except ValueError:
        return None
    if not host or "." not in host:
        return None
    host = host.removeprefix("www.")
    # Reject obvious non-domains (spaces got through, etc.)
    if not re.fullmatch(r"[a-z0-9.-]+\.[a-z]{2,}", host):
        return None
    return host


def normalize_business_name(raw: str | None) -> str | None:
    """Lowercase, strip punctuation and trailing legal suffixes, collapse spaces."""
    if not raw or not raw.strip():
        return None
    name = raw.lower()
    name = re.sub(r"[^\w\s&]", " ", name)
    name = re.sub(r"\s+", " ", name).strip()
    words = name.split(" ")
    while words and words[-1].rstrip(".") in LEGAL_SUFFIXES:
        words.pop()
    result = " ".join(words).strip()
    return result or None


def normalize_state(raw: str | None) -> str | None:
    if not raw or not raw.strip():
        return None
    value = raw.strip()
    if len(value) == 2 and value.upper() in STATE_MAP.values():
        return value.upper()
    return STATE_MAP.get(value.lower())


def normalize_zip(raw: str | None) -> str | None:
    if not raw:
        return None
    m = re.search(r"\b(\d{5})(?:-\d{4})?\b", str(raw))
    return m.group(1) if m else None


def normalize_address(raw: str | None) -> str | None:
    """Light consistency pass: collapse whitespace, standardize common abbreviations."""
    if not raw or not raw.strip():
        return None
    value = re.sub(r"\s+", " ", raw.strip())
    replacements = {
        r"\bstreet\b": "St", r"\bavenue\b": "Ave", r"\bboulevard\b": "Blvd",
        r"\bdrive\b": "Dr", r"\broad\b": "Rd", r"\bsuite\b": "Ste",
        r"\bhighway\b": "Hwy", r"\blane\b": "Ln", r"\bcourt\b": "Ct",
    }
    for pattern, abbr in replacements.items():
        value = re.sub(pattern, abbr, value, flags=re.IGNORECASE)
    return value
