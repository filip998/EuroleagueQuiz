from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    database_url: str = "sqlite:///data/euroleague.db"
    api_rate_limit_seconds: float = 1.0
    cors_origins: str = "http://localhost:5173,http://127.0.0.1:5173"

    model_config = {"env_prefix": "ELQ_"}


settings = Settings()
