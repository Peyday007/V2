from datetime import datetime

from pydantic import BaseModel, ConfigDict


class LoginRequest(BaseModel):
    username: str
    password: str


class TokenResponse(BaseModel):
    token: str
    username: str
    role: str


class UserCreate(BaseModel):
    username: str
    password: str
    role: str = "caller"


class UserOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: int
    username: str
    role: str
    active: bool


class BusinessOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: int
    business_name: str
    normalized_name: str | None
    primary_phone: str | None
    normalized_phone: str | None
    website: str | None
    normalized_domain: str | None
    address: str | None
    city: str | None
    state: str | None
    zip: str | None
    industry: str | None
    rating: float | None
    review_count: int | None
    source: str | None
    lead_status: str
    enrichment_status: str
    do_not_call: bool
    notes: str | None
    created_at: datetime


class BusinessUpdate(BaseModel):
    business_name: str | None = None
    primary_phone: str | None = None
    website: str | None = None
    address: str | None = None
    city: str | None = None
    state: str | None = None
    zip: str | None = None
    industry: str | None = None
    lead_status: str | None = None
    do_not_call: bool | None = None
    notes: str | None = None


class BusinessListOut(BaseModel):
    total: int
    page: int
    page_size: int
    items: list[BusinessOut]


class ImportBatchOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: int
    filename: str
    uploaded_by: str
    total_rows: int
    created_businesses: int
    linked_duplicates: int
    error_rows: int
    errors: list
    created_at: datetime
