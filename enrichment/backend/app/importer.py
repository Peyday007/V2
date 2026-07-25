"""CSV import with flexible column mapping, normalization, and
strong-signal duplicate linking.

Duplicates are never deleted: every row becomes a SourceRecord linked to
a canonical Business. A row matching an existing business on a strong
signal (normalized phone, normalized domain, or source+source_id) is
linked to it instead of creating a second business.
"""

import csv
import io
import logging

from sqlalchemy.orm import Session

from .models import Business, ImportBatch, SourceRecord
from .normalization import (
    normalize_address,
    normalize_business_name,
    normalize_domain,
    normalize_phone,
    normalize_state,
    normalize_zip,
)

logger = logging.getLogger(__name__)

IMPORTABLE_FIELDS = [
    "business_name",
    "phone",
    "website",
    "address",
    "city",
    "state",
    "zip",
    "industry",
    "rating",
    "review_count",
    "source",
    "source_id",
]


def parse_csv_headers(content: bytes) -> list[str]:
    text = content.decode("utf-8-sig", errors="replace")
    reader = csv.reader(io.StringIO(text))
    for row in reader:
        return [h.strip() for h in row]
    return []


def _to_float(value: str | None) -> float | None:
    if value is None or str(value).strip() == "":
        return None
    try:
        return float(str(value).strip())
    except ValueError:
        return None


def _to_int(value: str | None) -> int | None:
    f = _to_float(value)
    return int(f) if f is not None else None


def _find_existing(
    db: Session,
    normalized_phone: str | None,
    normalized_domain: str | None,
    source: str | None,
    source_id: str | None,
) -> tuple[Business | None, str | None]:
    if normalized_phone:
        hit = (
            db.query(Business)
            .filter(Business.normalized_phone == normalized_phone)
            .first()
        )
        if hit:
            return hit, f"same normalized phone {normalized_phone}"
    if normalized_domain:
        hit = (
            db.query(Business)
            .filter(Business.normalized_domain == normalized_domain)
            .first()
        )
        if hit:
            return hit, f"same domain {normalized_domain}"
    if source and source_id:
        hit = (
            db.query(Business)
            .filter(Business.source == source, Business.source_id == source_id)
            .first()
        )
        if hit:
            return hit, f"same source id {source}:{source_id}"
    return None, None


def run_import(
    db: Session,
    content: bytes,
    filename: str,
    column_mapping: dict[str, str],
    uploaded_by: str,
) -> ImportBatch:
    """column_mapping maps CSV header -> importable field name."""
    invalid_targets = set(column_mapping.values()) - set(IMPORTABLE_FIELDS)
    if invalid_targets:
        raise ValueError(f"Unknown mapping targets: {sorted(invalid_targets)}")

    batch = ImportBatch(
        filename=filename,
        uploaded_by=uploaded_by,
        column_mapping=column_mapping,
    )
    db.add(batch)
    db.flush()

    text = content.decode("utf-8-sig", errors="replace")
    reader = csv.DictReader(io.StringIO(text))
    errors: list[dict] = []

    for line_no, raw_row in enumerate(reader, start=2):
        batch.total_rows += 1
        row = {
            field: (raw_row.get(header) or "").strip()
            for header, field in column_mapping.items()
        }

        name = row.get("business_name")
        if not name:
            batch.error_rows += 1
            errors.append({"line": line_no, "error": "missing business_name"})
            continue

        normalized_phone = normalize_phone(row.get("phone"))
        normalized_domain = normalize_domain(row.get("website"))
        source = row.get("source") or None
        source_id = row.get("source_id") or None

        existing, reason = _find_existing(
            db, normalized_phone, normalized_domain, source, source_id
        )

        if existing:
            db.add(
                SourceRecord(
                    business_id=existing.id,
                    import_batch_id=batch.id,
                    raw_data=dict(raw_row),
                    duplicate_of_existing=True,
                    duplicate_reason=reason,
                )
            )
            batch.linked_duplicates += 1
            continue

        business = Business(
            business_name=name,
            normalized_name=normalize_business_name(name),
            primary_phone=row.get("phone") or None,
            normalized_phone=normalized_phone,
            website=row.get("website") or None,
            normalized_domain=normalized_domain,
            address=normalize_address(row.get("address")),
            city=(row.get("city") or None),
            state=normalize_state(row.get("state")),
            zip=normalize_zip(row.get("zip")),
            industry=(row.get("industry") or None),
            rating=_to_float(row.get("rating")),
            review_count=_to_int(row.get("review_count")),
            source=source,
            source_id=source_id,
        )
        db.add(business)
        db.flush()
        db.add(
            SourceRecord(
                business_id=business.id,
                import_batch_id=batch.id,
                raw_data=dict(raw_row),
            )
        )
        batch.created_businesses += 1

    batch.errors = errors
    db.commit()
    db.refresh(batch)
    logger.info(
        "import complete: file=%s rows=%d created=%d duplicates=%d errors=%d",
        filename,
        batch.total_rows,
        batch.created_businesses,
        batch.linked_duplicates,
        batch.error_rows,
    )
    return batch
