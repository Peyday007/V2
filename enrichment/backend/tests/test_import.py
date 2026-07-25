import json

CSV = """Company,Phone Number,Site,Town,State,Stars
Chuck's Roofing Company Inc,(313) 386-8962,https://www.chucksroofing.com/,Lincoln Park,Michigan,4.8
Sterling Construction and Roofing,(248) 802-3900,sterlingroof.com,Sterling Heights,MI,4.9
Chucks Roofing Co,313.386.8962,chucksroofing.com/contact,Lincoln Park,MI,4.8
,555-000-1111,,Nowhere,MI,1.0
"""

MAPPING = {
    "Company": "business_name",
    "Phone Number": "phone",
    "Site": "website",
    "Town": "city",
    "State": "state",
    "Stars": "rating",
}


def _upload(client, headers):
    return client.post(
        "/imports",
        files={"file": ("leads.csv", CSV, "text/csv")},
        data={"mapping": json.dumps(MAPPING)},
        headers=headers,
    )


def test_preview_suggests_mapping(client, admin_headers):
    res = client.post(
        "/imports/preview",
        files={"file": ("leads.csv", CSV, "text/csv")},
        headers=admin_headers,
    )
    assert res.status_code == 200
    body = res.json()
    assert body["headers"] == ["Company", "Phone Number", "Site", "Town", "State", "Stars"]
    assert body["suggested_mapping"].get("Company") == "business_name"
    assert body["suggested_mapping"].get("State") == "state"


def test_import_normalizes_dedupes_and_reports(client, admin_headers):
    res = _upload(client, admin_headers)
    assert res.status_code == 200, res.text
    batch = res.json()
    assert batch["total_rows"] == 4
    # Row 3 is Chuck's again (same phone + same domain) -> linked duplicate.
    assert batch["created_businesses"] == 2
    assert batch["linked_duplicates"] == 1
    # Row 4 has no business name -> error row.
    assert batch["error_rows"] == 1
    assert batch["errors"][0]["error"] == "missing business_name"

    listing = client.get("/businesses", headers=admin_headers).json()
    assert listing["total"] == 2
    by_name = {b["business_name"]: b for b in listing["items"]}
    chuck = by_name["Chuck's Roofing Company Inc"]
    assert chuck["normalized_phone"] == "+13133868962"
    assert chuck["normalized_domain"] == "chucksroofing.com"
    assert chuck["state"] == "MI"  # normalized from "Michigan"

    # Duplicate source row is preserved and linked, with a reason.
    sources = client.get(
        f"/businesses/{chuck['id']}/sources", headers=admin_headers
    ).json()
    assert len(sources) == 2
    dup = [s for s in sources if s["duplicate_of_existing"]]
    assert len(dup) == 1
    assert "phone" in dup[0]["duplicate_reason"]


def test_reimport_links_all_as_duplicates(client, admin_headers):
    _upload(client, admin_headers)
    res = _upload(client, admin_headers)
    batch = res.json()
    assert batch["created_businesses"] == 0
    assert batch["linked_duplicates"] == 3


def test_search_and_filter(client, admin_headers):
    _upload(client, admin_headers)
    assert (
        client.get("/businesses?q=sterling", headers=admin_headers).json()["total"] == 1
    )
    assert (
        client.get("/businesses?state=mi", headers=admin_headers).json()["total"] == 2
    )
    assert (
        client.get("/businesses?q=nomatch", headers=admin_headers).json()["total"] == 0
    )


def test_update_business_resyncs_normalized_fields(client, admin_headers):
    _upload(client, admin_headers)
    biz = client.get("/businesses?q=sterling", headers=admin_headers).json()["items"][0]
    res = client.patch(
        f"/businesses/{biz['id']}",
        json={"primary_phone": "(734) 555-0199", "do_not_call": True},
        headers=admin_headers,
    )
    assert res.status_code == 200
    updated = res.json()
    assert updated["normalized_phone"] == "+17345550199"
    assert updated["do_not_call"] is True


def test_bad_mapping_rejected(client, admin_headers):
    res = client.post(
        "/imports",
        files={"file": ("leads.csv", CSV, "text/csv")},
        data={"mapping": json.dumps({"Company": "not_a_field"})},
        headers=admin_headers,
    )
    assert res.status_code == 400
