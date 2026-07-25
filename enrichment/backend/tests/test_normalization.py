from app.normalization import (
    normalize_address,
    normalize_business_name,
    normalize_domain,
    normalize_phone,
    normalize_state,
    normalize_zip,
)


class TestPhone:
    def test_us_formats(self):
        assert normalize_phone("(248) 802-3900") == "+12488023900"
        assert normalize_phone("248-802-3900") == "+12488023900"
        assert normalize_phone("248.802.3900") == "+12488023900"
        assert normalize_phone("+1 248 802 3900") == "+12488023900"

    def test_invalid(self):
        assert normalize_phone("123") is None
        assert normalize_phone("") is None
        assert normalize_phone(None) is None
        assert normalize_phone("not a phone") is None


class TestDomain:
    def test_strips_protocol_www_path_query(self):
        assert normalize_domain("https://www.chucksroofing.com/contact?utm_source=x") == "chucksroofing.com"
        assert normalize_domain("http://chucksroofing.com") == "chucksroofing.com"
        assert normalize_domain("chucksroofing.com/about") == "chucksroofing.com"
        assert normalize_domain("WWW.ChucksRoofing.COM") == "chucksroofing.com"

    def test_invalid(self):
        assert normalize_domain("") is None
        assert normalize_domain(None) is None
        assert normalize_domain("not a domain") is None


class TestBusinessName:
    def test_strips_legal_suffixes(self):
        assert normalize_business_name("Chuck's Roofing Company Inc") == "chuck s roofing"
        assert normalize_business_name("Great Lakes Aggregates, LLC") == "great lakes aggregates"
        assert normalize_business_name("Acme Corp.") == "acme"

    def test_keeps_core_name(self):
        assert normalize_business_name("Sterling Construction and Roofing") == "sterling construction and roofing"

    def test_empty(self):
        assert normalize_business_name("") is None
        assert normalize_business_name("LLC") is None


class TestState:
    def test_full_names_and_abbreviations(self):
        assert normalize_state("Michigan") == "MI"
        assert normalize_state("michigan") == "MI"
        assert normalize_state("MI") == "MI"
        assert normalize_state("mi") == "MI"

    def test_invalid(self):
        assert normalize_state("Narnia") is None
        assert normalize_state("") is None


class TestZip:
    def test_extracts_five_digits(self):
        assert normalize_zip("48083") == "48083"
        assert normalize_zip("48083-1234") == "48083"

    def test_invalid(self):
        assert normalize_zip("abc") is None


class TestAddress:
    def test_abbreviates(self):
        assert normalize_address("123  Main   Street") == "123 Main St"
        assert normalize_address("500 Woodward Avenue Suite 200") == "500 Woodward Ave Ste 200"

    def test_empty(self):
        assert normalize_address("") is None
