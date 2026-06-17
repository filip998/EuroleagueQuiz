from fastapi import APIRouter, Depends, HTTPException, Request, status
from sqlalchemy.orm import Session

from app.auth import get_current_user
from app.auth.clerk_webhooks import (
    ClerkWebhookConfigurationError,
    ClerkWebhookPayloadError,
    ClerkWebhookVerificationError,
    handle_clerk_webhook,
)
from app.auth.guest_links import GuestIdConflictError, GuestIdValidationError, link_guest_id
from app.auth.users import UserProvisioningError
from app.auth_database import get_auth_db
from app.models.user import User
from app.schemas.auth import AuthUser, LinkGuestRequest, LinkGuestResponse

router = APIRouter()


@router.get("/me", response_model=AuthUser)
def read_current_user(current_user: User = Depends(get_current_user)) -> User:
    return current_user


@router.post("/link-guest", response_model=LinkGuestResponse)
def link_guest(
    payload: LinkGuestRequest,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_auth_db),
) -> LinkGuestResponse:
    try:
        result = link_guest_id(db, current_user, payload.guest_id)
    except GuestIdValidationError as exc:
        raise HTTPException(
            status_code=422,
            detail=str(exc),
        ) from exc
    except GuestIdConflictError as exc:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="guest_id is already linked to another user",
        ) from exc
    return LinkGuestResponse(guest_id=result.guest_id, status=result.status)


@router.post("/webhooks/clerk")
async def clerk_webhook(
    request: Request,
    db: Session = Depends(get_auth_db),
) -> dict[str, str]:
    raw_body = await request.body()
    try:
        result = handle_clerk_webhook(raw_body, dict(request.headers), db)
    except ClerkWebhookConfigurationError as exc:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Clerk webhook is not configured",
        ) from exc
    except ClerkWebhookVerificationError as exc:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Invalid Clerk webhook signature",
        ) from exc
    except ClerkWebhookPayloadError as exc:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=str(exc),
        ) from exc
    except UserProvisioningError as exc:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Could not sync Clerk user",
        ) from exc
    return {"type": result.event_type, "status": result.status}
