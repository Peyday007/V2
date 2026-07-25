from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    database_url: str = "postgresql://enrich:enrich@localhost:5433/enrichment"
    jwt_secret: str = "change-me"
    jwt_expire_minutes: int = 720
    admin_username: str = "admin"
    admin_password: str = "change-me-now"
    max_upload_bytes: int = 10 * 1024 * 1024
    cors_origins: str = "http://localhost:3002"

    class Config:
        env_file = ".env"
        extra = "ignore"


settings = Settings()
