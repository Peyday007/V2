from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from ..auth import admin_user, create_token, current_user, hash_password, verify_password
from ..database import get_db
from ..models import AuditLog, User
from ..schemas import LoginRequest, TokenResponse, UserCreate, UserOut

router = APIRouter(prefix="/auth", tags=["auth"])


@router.post("/login", response_model=TokenResponse)
def login(body: LoginRequest, db: Session = Depends(get_db)):
    user = db.query(User).filter(User.username == body.username).first()
    if not user or not user.active or not verify_password(body.password, user.password_hash):
        raise HTTPException(401, "Invalid credentials")
    db.add(AuditLog(actor=user.username, action="login", entity_type="user", entity_id=str(user.id)))
    db.commit()
    return TokenResponse(token=create_token(user), username=user.username, role=user.role)


@router.get("/me", response_model=UserOut)
def me(user: User = Depends(current_user)):
    return user


@router.post("/users", response_model=UserOut)
def create_user(
    body: UserCreate,
    db: Session = Depends(get_db),
    admin: User = Depends(admin_user),
):
    if body.role not in ("admin", "caller"):
        raise HTTPException(400, "role must be admin or caller")
    if db.query(User).filter(User.username == body.username).first():
        raise HTTPException(409, "Username taken")
    if len(body.password) < 8:
        raise HTTPException(400, "Password must be at least 8 characters")
    user = User(
        username=body.username,
        password_hash=hash_password(body.password),
        role=body.role,
    )
    db.add(user)
    db.add(AuditLog(actor=admin.username, action="user.created", entity_type="user", detail={"username": body.username, "role": body.role}))
    db.commit()
    db.refresh(user)
    return user


@router.get("/users", response_model=list[UserOut])
def list_users(db: Session = Depends(get_db), admin: User = Depends(admin_user)):
    return db.query(User).order_by(User.id).all()
