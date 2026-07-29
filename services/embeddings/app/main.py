"""
Embedding service.

A small FastAPI wrapper around a sentence-transformers model, exposing an
OpenAI-compatible /v1/embeddings endpoint for the backend to call.
"""

import logging
from contextlib import asynccontextmanager

from fastapi import Depends, FastAPI, Header, HTTPException, status

from .config import settings
from .embedder import embedder
from .schemas import (
    EmbeddingItem,
    EmbeddingsRequest,
    EmbeddingsResponse,
    HealthResponse,
    Usage,
)

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)-8s %(name)s: %(message)s",
)
logger = logging.getLogger("embeddings")


@asynccontextmanager
async def lifespan(_app: FastAPI):
    # Loading here rather than lazily means the container is only reported healthy
    # once it can actually serve, so `depends_on: service_healthy` behaves.
    embedder.load()
    yield


app = FastAPI(
    title="Substrate embedding service",
    version="1.0.0",
    lifespan=lifespan,
)


async def require_api_key(authorization: str | None = Header(default=None)) -> None:
    """No-op unless INFERENCE_API_KEY is set, so local runs need no credentials."""
    if not settings.api_key:
        return
    expected = f"Bearer {settings.api_key}"
    if authorization != expected:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid or missing API key",
        )


@app.get("/health", response_model=HealthResponse)
async def health() -> HealthResponse:
    return HealthResponse(
        status="ok" if embedder.ready else "loading",
        model=settings.model_id,
        dimensions=embedder.dimensions,
        device=embedder.device,
        supports_mrl=settings.supports_mrl,
    )


@app.post(
    "/v1/embeddings",
    response_model=EmbeddingsResponse,
    dependencies=[Depends(require_api_key)],
)
async def create_embeddings(request: EmbeddingsRequest) -> EmbeddingsResponse:
    texts = [request.input] if isinstance(request.input, str) else list(request.input)

    if not texts:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "`input` must not be empty")
    if len(texts) > settings.max_inputs:
        raise HTTPException(
            status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
            f"At most {settings.max_inputs} inputs per request, got {len(texts)}",
        )
    if any(not isinstance(text, str) or not text.strip() for text in texts):
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Every input must be a non-empty string")
    # Refused rather than ignored. A caller asking for 256 dimensions and silently
    # receiving 1024 would index vectors of the wrong shape; a caller silently
    # receiving a truncated non-MRL vector would index vectors of the right shape and
    # the wrong meaning. Both are worse than an error naming the setting.
    if request.dimensions is not None and not settings.supports_mrl:
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            f"{settings.model_id} does not document Matryoshka truncation, so "
            '"dimensions" is refused. Set SUPPORTS_MRL=true if this model supports it, '
            "or use a model that does (for example Qwen/Qwen3-Embedding-0.6B).",
        )

    if not embedder.ready:
        raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, "Model is still loading")

    if request.dimensions is not None and request.dimensions > embedder.dimensions:
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            f"`dimensions` must be <= {embedder.dimensions} for this model",
        )

    vectors = embedder.encode(
        texts,
        is_query=request.task == "retrieval.query",
        instruction=request.instruction,
        dimensions=request.dimensions,
    )
    tokens = embedder.count_tokens(texts)

    return EmbeddingsResponse(
        model=settings.model_id,
        data=[EmbeddingItem(index=i, embedding=vector) for i, vector in enumerate(vectors)],
        usage=Usage(prompt_tokens=tokens, total_tokens=tokens),
    )
