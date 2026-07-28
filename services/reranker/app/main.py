"""
Reranker service.

A FastAPI wrapper that scores query/document pairs and returns them ordered by
relevance, using the Jina/Cohere response shape the backend expects.
"""

import logging
from contextlib import asynccontextmanager

from fastapi import Depends, FastAPI, Header, HTTPException, status

from .config import settings
from .schemas import (
    HealthResponse,
    RerankDocument,
    RerankRequest,
    RerankResponse,
    RerankResult,
    Usage,
)
from .scorer import scorer

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)-8s %(name)s: %(message)s",
)
logger = logging.getLogger("reranker")


@asynccontextmanager
async def lifespan(_app: FastAPI):
    scorer.load()
    _log_sanity_check()
    yield


def _log_sanity_check() -> None:
    """
    Score one obviously-relevant and one obviously-irrelevant document at startup.

    A mis-converted or mis-configured reranker does not error, it just returns
    meaningless numbers — so it is worth proving at boot that the ordering is sane
    rather than discovering it from bad search results weeks later.
    """
    try:
        scores = scorer.score(
            "What is the capital of France?",
            ["Paris is the capital and largest city of France.", "Bananas are a tropical fruit."],
            None,
        )
        ok = scores[0] > scores[1]
        logger.info(
            "Sanity check: relevant=%.4f irrelevant=%.4f -> %s",
            scores[0],
            scores[1],
            "ok" if ok else "SUSPECT ordering",
        )
        if not ok:
            logger.warning(
                "Reranker ranked an irrelevant document above a relevant one. "
                "The weights or MODEL_KIND are likely wrong for this model."
            )
    except Exception as err:  # noqa: BLE001 - never block startup on a diagnostic
        logger.warning("Sanity check could not run: %s", err)


app = FastAPI(title="Substrate reranker service", version="1.0.0", lifespan=lifespan)


async def require_api_key(authorization: str | None = Header(default=None)) -> None:
    """No-op unless INFERENCE_API_KEY is set, so local runs need no credentials."""
    if not settings.api_key:
        return
    if authorization != f"Bearer {settings.api_key}":
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid or missing API key",
        )


@app.get("/health", response_model=HealthResponse)
async def health() -> HealthResponse:
    return HealthResponse(
        status="ok" if scorer.ready else "loading",
        model=settings.model_id,
        kind=settings.model_kind,
        device=scorer.device,
    )


@app.post(
    "/v1/rerank",
    response_model=RerankResponse,
    dependencies=[Depends(require_api_key)],
)
async def rerank(request: RerankRequest) -> RerankResponse:
    if len(request.documents) > settings.max_documents:
        raise HTTPException(
            status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
            f"At most {settings.max_documents} documents per request, got {len(request.documents)}",
        )
    if any(not doc.strip() for doc in request.documents):
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Documents must be non-empty strings")
    if not scorer.ready:
        raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, "Model is still loading")

    scores = scorer.score(request.query, request.documents, request.instruction)

    ranked = sorted(enumerate(scores), key=lambda pair: pair[1], reverse=True)
    if request.top_n:
        ranked = ranked[: request.top_n]

    results = [
        RerankResult(
            index=index,
            relevance_score=score,
            document=RerankDocument(text=request.documents[index]) if request.return_documents else None,
        )
        for index, score in ranked
    ]
    tokens = scorer.count_tokens([(request.query, doc) for doc in request.documents])

    return RerankResponse(
        model=settings.model_id,
        results=results,
        usage=Usage(total_tokens=tokens),
    )
