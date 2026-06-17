from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    database_url: str = "sqlite:///data/euroleague.db"
    auth_database_url: str = "sqlite:///data/users.db"
    clerk_secret_key: str | None = None
    clerk_issuer: str | None = None
    clerk_jwks_url: str | None = None
    clerk_authorized_parties: str = ""
    clerk_jwt_leeway_seconds: int = 60
    clerk_jwks_cache_ttl_seconds: float = 300.0
    clerk_jwks_refresh_cooldown_seconds: float = 30.0
    clerk_jwks_unknown_kid_min_refresh_interval_seconds: float = 1.0
    api_rate_limit_seconds: float = 1.0
    online_disconnect_grace_seconds: float = 30.0
    wikipedia_user_agent: str = "EuroleagueQuiz/0.1 (https://github.com/filip998/EuroleagueQuiz)"
    career_quiz_min_eligible_players: int = 200
    solo_round_token_secret: str = "dev-career-quiz-secret"
    cors_origins: str = "http://localhost:5173,http://127.0.0.1:5173"

    model_config = {"env_prefix": "ELQ_"}


settings = Settings()
