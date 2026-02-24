from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    database_url: str = "sqlite:///data/euroleague.db"
    api_rate_limit_seconds: float = 1.0

    model_config = {"env_prefix": "ELQ_"}


settings = Settings()
