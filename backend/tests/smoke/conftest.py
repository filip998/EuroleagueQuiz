"""
Post-deployment smoke tests.

Run against a live API to verify critical endpoints are responding.
Usage:
    pytest tests/smoke/ --base-url https://euroleague-quiz-backend-app.azurewebsites.net
    pytest tests/smoke/ --base-url http://localhost:8000
"""

import os
import pytest
import httpx

BASE_URL = os.environ.get(
    "SMOKE_TEST_URL", "https://euroleague-quiz-backend-app.azurewebsites.net"
)


def pytest_addoption(parser):
    parser.addoption(
        "--base-url",
        action="store",
        default=BASE_URL,
        help="Base URL for smoke tests",
    )


@pytest.fixture(scope="session")
def base_url(request):
    return request.config.getoption("--base-url")


@pytest.fixture(scope="session")
def client(base_url):
    with httpx.Client(base_url=base_url, timeout=15.0) as c:
        yield c
