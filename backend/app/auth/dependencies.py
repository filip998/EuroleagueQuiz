from typing import Annotated

from fastapi import Depends, Header, HTTPException, status
from sqlalchemy.orm import Session

from app.auth.clerk import (
    ClerkAuthError,
    ClerkAuthServiceError,
    extract_bearer_token,
    get_clerk_jwt_verifier,
)
from app.auth_database import get_auth_db
from app.auth.users import DeletedClerkUserError, UserProvisioningError, get_or_create_user_for_claims
from app.models.user import User


def get_current_user(
    authorization: Annotated[str | None, Header(alias="Authorization")] = None,
    db: Session = Depends(get_auth_db),
) -> User:
    try:
        return _resolve_authenticated_user(authorization, db)
    except DeletedClerkUserError as exc:
        raise _unauthorized() from exc
    except ClerkAuthError as exc:
        raise _unauthorized() from exc
    except ClerkAuthServiceError as exc:
        raise _auth_service_unavailable() from exc
    except UserProvisioningError as exc:
        raise _server_error() from exc


def get_optional_user(
    authorization: Annotated[str | None, Header(alias="Authorization")] = None,
    db: Session = Depends(get_auth_db),
) -> User | None:
    if authorization is None:
        return None
    try:
        return _resolve_authenticated_user(authorization, db)
    except ClerkAuthServiceError as exc:
        raise _auth_service_unavailable() from exc
    except DeletedClerkUserError:
        return None
    except ClerkAuthError:
        return None


def _resolve_authenticated_user(authorization: str | None, db: Session) -> User:
    token = extract_bearer_token(authorization)
    claims = get_clerk_jwt_verifier().verify(token)
    return get_or_create_user_for_claims(db, claims)


def _unauthorized() -> HTTPException:
    return HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail="Invalid authentication credentials",
        headers={"WWW-Authenticate": "Bearer"},
    )


def _server_error() -> HTTPException:
    return HTTPException(
        status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
        detail="Could not provision authenticated user",
    )


def _auth_service_unavailable() -> HTTPException:
    return HTTPException(
        status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
        detail="Authentication service unavailable",
    )
