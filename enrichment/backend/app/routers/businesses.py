from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import or_
from sqlalchemy.orm import Session

from ..auth import current_user
from ..database import get_db
from ..models import AuditLog, Business, SourceRecord, User
from ..normalization import (
    normalize_business_name,
    normalize_domain,
    normalize_phone,
    normalize_state,
)
from ..schemas import BusinessListOut, BusinessOut, BusinessUpdate

router = APIRouter(prefix="/businesses", tags=["businesses"])


@router.get("", response_model=BusinessListOut)
def list_businesses(
    q: str | None = Query(None, description="Search name, phone, domain, city"),
    state: str | None = None,
    industry: str | None = None,
    lead_status: str | None = None,
    page: int = Query(1, ge=1),
    page_size: int = Query(50, ge=1, le=200),
    db: Session = Depends(get_db),
    user: User = Depends(current_user),
):
    query = db.query(Business)
    if q:
        like = f"%{q.strip().lower()}%"
        query = query.filter(
            or_(
                Business.normalized_name.ilike(like),
                Business.business_name.ilike(like),
                Business.normalized_phone.ilike(like),
                Business.normalized_domain.ilike(like),
                Business.city.ilike(like),
            )
        )
    if state:
        query = query.filter(Business.state == state.upper())
    if industry:
        query = query.filter(Business.industry.ilike(f"%{industry}%"))
    if lead_status:
        query = query.filter(Business.lead_status == lead_status)

    total = query.count()
    items = (
        query.order_by(Business.id.desc())
        .offset((page - 1) * page_size)
        .limit(page_size)
        .all()
    )
    return BusinessListOut(total=total, page=page, page_size=page_size, items=items)


@router.get("/{business_id}", response_model=BusinessOut)
def get_business(
    business_id: int,
    db: Session = Depends(get_db),
    user: User = Depends(current_user),
):
    business = db.get(Business, business_id)
    if not business:
        raise HTTPException(404, "Not found")
    return business


@router.get("/{business_id}/sources")
def get_sources(
    business_id: int,
    db: Session = Depends(get_db),
    user: User = Depends(current_user),
):
    rows = (
        db.query(SourceRecord)
        .filter(SourceRecord.business_id == business_id)
        .order_by(SourceRecord.id)
        .all()
    )
    return [
        {
            "id": r.id,
            "raw_data": r.raw_data,
            "duplicate_of_existing": r.duplicate_of_existing,
            "duplicate_reason": r.duplicate_reason,
            "created_at": r.created_at,
        }
        for r in rows
    ]


@router.patch("/{business_id}", response_model=BusinessOut)
def update_business(
    business_id: int,
    body: BusinessUpdate,
    db: Session = Depends(get_db),
    user: User = Depends(current_user),
):
    business = db.get(Business, business_id)
    if not business:
        raise HTTPException(404, "Not found")

    changes = body.model_dump(exclude_unset=True)
    for field, value in changes.items():
        setattr(business, field, value)

    # Keep normalized matching columns in sync with edited raw values.
    if "business_name" in changes:
        business.normalized_name = normalize_business_name(business.business_name)
    if "primary_phone" in changes:
        business.normalized_phone = normalize_phone(business.primary_phone)
    if "website" in changes:
        business.normalized_domain = normalize_domain(business.website)
    if "state" in changes and business.state:
        business.state = normalize_state(business.state)

    db.add(
        AuditLog(
            actor=user.username,
            action="business.updated",
            entity_type="business",
            entity_id=str(business_id),
            detail={"fields": sorted(changes.keys())},
        )
    )
    db.commit()
    db.refresh(business)
    return business
