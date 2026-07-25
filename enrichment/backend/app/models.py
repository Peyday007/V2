from datetime import datetime, timezone

from sqlalchemy import (
    JSON,
    Boolean,
    DateTime,
    Float,
    ForeignKey,
    Integer,
    Numeric,
    String,
    Text,
)
from sqlalchemy.orm import Mapped, mapped_column, relationship

from .database import Base


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


class User(Base):
    __tablename__ = "users"

    id: Mapped[int] = mapped_column(primary_key=True)
    username: Mapped[str] = mapped_column(String(80), unique=True, index=True)
    password_hash: Mapped[str] = mapped_column(String(200))
    role: Mapped[str] = mapped_column(String(20), default="caller")  # admin | caller
    active: Mapped[bool] = mapped_column(Boolean, default=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)


class Business(Base):
    __tablename__ = "businesses"

    id: Mapped[int] = mapped_column(primary_key=True)
    business_name: Mapped[str] = mapped_column(String(300))
    normalized_name: Mapped[str | None] = mapped_column(String(300), index=True)
    primary_phone: Mapped[str | None] = mapped_column(String(50))
    normalized_phone: Mapped[str | None] = mapped_column(String(20), index=True)
    website: Mapped[str | None] = mapped_column(String(500))
    normalized_domain: Mapped[str | None] = mapped_column(String(200), index=True)
    address: Mapped[str | None] = mapped_column(String(400))
    city: Mapped[str | None] = mapped_column(String(120), index=True)
    state: Mapped[str | None] = mapped_column(String(2), index=True)
    zip: Mapped[str | None] = mapped_column(String(12))
    industry: Mapped[str | None] = mapped_column(String(120), index=True)
    rating: Mapped[float | None] = mapped_column(Float)
    review_count: Mapped[int | None] = mapped_column(Integer)
    employee_count: Mapped[int | None] = mapped_column(Integer)
    source: Mapped[str | None] = mapped_column(String(120))
    source_id: Mapped[str | None] = mapped_column(String(200))
    lead_status: Mapped[str] = mapped_column(String(30), default="new", index=True)
    enrichment_status: Mapped[str] = mapped_column(String(30), default="none", index=True)
    do_not_call: Mapped[bool] = mapped_column(Boolean, default=False, index=True)
    notes: Mapped[str | None] = mapped_column(Text)
    last_contacted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=utcnow, onupdate=utcnow
    )

    contacts: Mapped[list["Contact"]] = relationship(back_populates="business")
    source_records: Mapped[list["SourceRecord"]] = relationship(back_populates="business")


class SourceRecord(Base):
    """Raw imported row, always preserved and linked to its canonical business."""

    __tablename__ = "source_records"

    id: Mapped[int] = mapped_column(primary_key=True)
    business_id: Mapped[int] = mapped_column(ForeignKey("businesses.id"), index=True)
    import_batch_id: Mapped[int | None] = mapped_column(
        ForeignKey("import_batches.id"), index=True
    )
    raw_data: Mapped[dict] = mapped_column(JSON, default=dict)
    duplicate_of_existing: Mapped[bool] = mapped_column(Boolean, default=False)
    duplicate_reason: Mapped[str | None] = mapped_column(String(200))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)

    business: Mapped["Business"] = relationship(back_populates="source_records")


class Contact(Base):
    __tablename__ = "contacts"

    id: Mapped[int] = mapped_column(primary_key=True)
    business_id: Mapped[int] = mapped_column(ForeignKey("businesses.id"), index=True)
    full_name: Mapped[str | None] = mapped_column(String(200))
    first_name: Mapped[str | None] = mapped_column(String(100))
    last_name: Mapped[str | None] = mapped_column(String(100))
    title: Mapped[str | None] = mapped_column(String(200))
    role_category: Mapped[str] = mapped_column(String(40), default="unknown_decision_maker")
    email: Mapped[str | None] = mapped_column(String(200))
    email_type: Mapped[str | None] = mapped_column(String(30))  # work | generic | personal | unknown
    direct_phone: Mapped[str | None] = mapped_column(String(50))
    phone_type: Mapped[str | None] = mapped_column(String(30))  # main | direct_office | mobile | extension | unknown
    extension: Mapped[str | None] = mapped_column(String(20))
    linkedin_url: Mapped[str | None] = mapped_column(String(400))
    contact_source: Mapped[str] = mapped_column(String(40), default="import")
    # import | website | caller_discovered | provider | manual
    confidence_score: Mapped[float] = mapped_column(Float, default=0.0)
    verified_status: Mapped[str] = mapped_column(String(40), default="unverified")
    active: Mapped[bool] = mapped_column(Boolean, default=True)
    last_verified_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    notes: Mapped[str | None] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=utcnow, onupdate=utcnow
    )

    business: Mapped["Business"] = relationship(back_populates="contacts")


class CallAttempt(Base):
    __tablename__ = "call_attempts"

    id: Mapped[int] = mapped_column(primary_key=True)
    business_id: Mapped[int] = mapped_column(ForeignKey("businesses.id"), index=True)
    contact_id: Mapped[int | None] = mapped_column(ForeignKey("contacts.id"))
    caller_name: Mapped[str] = mapped_column(String(120))
    call_started_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    outcome: Mapped[str] = mapped_column(String(40), index=True)
    phone_called: Mapped[str | None] = mapped_column(String(50))
    duration_seconds: Mapped[int | None] = mapped_column(Integer)
    recording_url: Mapped[str | None] = mapped_column(String(500))
    next_action: Mapped[str | None] = mapped_column(String(300))
    callback_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    notes: Mapped[str | None] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)


class CallDiscovery(Base):
    """Facts discovered by a caller during a real call. Never rediscover."""

    __tablename__ = "call_discoveries"

    id: Mapped[int] = mapped_column(primary_key=True)
    business_id: Mapped[int] = mapped_column(ForeignKey("businesses.id"), index=True)
    source_call_attempt_id: Mapped[int | None] = mapped_column(ForeignKey("call_attempts.id"))
    owner_name_discovered: Mapped[str | None] = mapped_column(String(200))
    title_discovered: Mapped[str | None] = mapped_column(String(200))
    direct_extension_discovered: Mapped[str | None] = mapped_column(String(20))
    direct_number_discovered: Mapped[str | None] = mapped_column(String(50))
    email_discovered: Mapped[str | None] = mapped_column(String(200))
    best_callback_time: Mapped[str | None] = mapped_column(String(200))
    transfer_instructions: Mapped[str | None] = mapped_column(Text)
    gatekeeper_name: Mapped[str | None] = mapped_column(String(200))
    decision_maker_schedule: Mapped[str | None] = mapped_column(String(300))
    discovered_by: Mapped[str] = mapped_column(String(120))
    confidence: Mapped[float] = mapped_column(Float, default=0.9)
    discovered_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)


class ImportBatch(Base):
    __tablename__ = "import_batches"

    id: Mapped[int] = mapped_column(primary_key=True)
    filename: Mapped[str] = mapped_column(String(300))
    uploaded_by: Mapped[str] = mapped_column(String(120))
    column_mapping: Mapped[dict] = mapped_column(JSON, default=dict)
    total_rows: Mapped[int] = mapped_column(Integer, default=0)
    created_businesses: Mapped[int] = mapped_column(Integer, default=0)
    linked_duplicates: Mapped[int] = mapped_column(Integer, default=0)
    error_rows: Mapped[int] = mapped_column(Integer, default=0)
    errors: Mapped[list] = mapped_column(JSON, default=list)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)


class AuditLog(Base):
    __tablename__ = "audit_log"

    id: Mapped[int] = mapped_column(primary_key=True)
    actor: Mapped[str] = mapped_column(String(120))
    action: Mapped[str] = mapped_column(String(80), index=True)
    entity_type: Mapped[str] = mapped_column(String(40))
    entity_id: Mapped[str | None] = mapped_column(String(40))
    detail: Mapped[dict] = mapped_column(JSON, default=dict)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
