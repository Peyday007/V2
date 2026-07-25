import json

from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile
from sqlalchemy.orm import Session

from ..auth import admin_user
from ..config import settings
from ..database import get_db
from ..importer import IMPORTABLE_FIELDS, parse_csv_headers, run_import
from ..models import AuditLog, ImportBatch, User
from ..schemas import ImportBatchOut

router = APIRouter(prefix="/imports", tags=["imports"])


async def _read_limited(file: UploadFile) -> bytes:
    content = await file.read(settings.max_upload_bytes + 1)
    if len(content) > settings.max_upload_bytes:
        raise HTTPException(413, "File too large")
    if not content:
        raise HTTPException(400, "Empty file")
    return content


@router.post("/preview")
async def preview(file: UploadFile = File(...), admin: User = Depends(admin_user)):
    """Return CSV headers + importable fields so the UI can build a mapping."""
    content = await _read_limited(file)
    headers = parse_csv_headers(content)
    if not headers:
        raise HTTPException(400, "Could not read CSV headers")

    # Suggest a mapping for exact/close header names.
    aliases = {
        "business_name": ["business_name", "name", "company", "company_name", "business"],
        "phone": ["phone", "phone_number", "primary_phone", "telephone"],
        "website": ["website", "url", "site", "domain"],
        "address": ["address", "street", "street_address", "address1"],
        "city": ["city", "town"],
        "state": ["state", "province", "region"],
        "zip": ["zip", "zipcode", "zip_code", "postal_code"],
        "industry": ["industry", "category", "type", "vertical"],
        "rating": ["rating", "stars", "google_rating"],
        "review_count": ["review_count", "reviews", "num_reviews", "user_ratings_total"],
        "source": ["source", "lead_source"],
        "source_id": ["source_id", "place_id", "external_id"],
    }
    suggested: dict[str, str] = {}
    for header in headers:
        key = header.strip().lower().replace(" ", "_")
        for field, names in aliases.items():
            if key in names and field not in suggested.values():
                suggested[header] = field
                break

    return {"headers": headers, "fields": IMPORTABLE_FIELDS, "suggested_mapping": suggested}


@router.post("", response_model=ImportBatchOut)
async def import_csv(
    file: UploadFile = File(...),
    mapping: str = Form(...),
    db: Session = Depends(get_db),
    admin: User = Depends(admin_user),
):
    content = await _read_limited(file)
    try:
        column_mapping = json.loads(mapping)
        assert isinstance(column_mapping, dict)
    except (json.JSONDecodeError, AssertionError):
        raise HTTPException(400, "mapping must be a JSON object of {csv_column: field}")
    if "business_name" not in column_mapping.values():
        raise HTTPException(400, "mapping must include business_name")

    try:
        batch = run_import(
            db, content, file.filename or "upload.csv", column_mapping, admin.username
        )
    except ValueError as e:
        raise HTTPException(400, str(e))

    db.add(
        AuditLog(
            actor=admin.username,
            action="import.completed",
            entity_type="import_batch",
            entity_id=str(batch.id),
            detail={
                "filename": batch.filename,
                "created": batch.created_businesses,
                "duplicates": batch.linked_duplicates,
            },
        )
    )
    db.commit()
    return batch


@router.get("", response_model=list[ImportBatchOut])
def list_batches(db: Session = Depends(get_db), admin: User = Depends(admin_user)):
    return db.query(ImportBatch).order_by(ImportBatch.id.desc()).limit(50).all()
