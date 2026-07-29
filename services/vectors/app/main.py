"""
Vector store service.

A FastAPI wrapper over Supabase's `vecs`, which is a thin client for pgvector. It stores
vectors and answers nearest-neighbour queries; it never embeds anything, so the embedding
service stays stateless and this store stays model-agnostic.

Runs against ANY Postgres with the pgvector extension available -- vecs is Supabase's
library but has no dependency on the Supabase platform.
"""

import logging
from contextlib import asynccontextmanager

from fastapi import Depends, FastAPI, Header, HTTPException, status

from .config import settings
from .schemas import (
    CollectionInfo,
    CreateCollectionRequest,
    DeleteRequest,
    DeleteResponse,
    FetchRequest,
    FetchResponse,
    HealthResponse,
    IndexRequest,
    QueryRequest,
    QueryResponse,
    UpsertRequest,
    UpsertResponse,
)
from .store import DimensionMismatch, NotConfigured, store

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)-8s %(name)s: %(message)s",
)
logger = logging.getLogger("vectors")


@asynccontextmanager
async def lifespan(_app: FastAPI):
    try:
        store.connect()
    except Exception as err:  # noqa: BLE001 - a bad DSN must not stop the process
        # Reported, not fatal. Every dependency in this stack is optional, and a service
        # that refuses to start cannot tell anyone why through its own health endpoint.
        logger.error("Could not connect the vector store: %s", err)
    yield
    store.disconnect()


app = FastAPI(title="Substrate vector service", version="1.0.0", lifespan=lifespan)


async def require_api_key(authorization: str | None = Header(default=None)) -> None:
    """No-op unless VECTORS_API_KEY is set, so local runs need no credentials."""
    if not settings.api_key:
        return
    if authorization != f"Bearer {settings.api_key}":
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid or missing API key",
        )


def _guard(exc: Exception) -> HTTPException:
    """Maps store failures onto the status codes the backend already knows how to map."""
    if isinstance(exc, NotConfigured):
        return HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, str(exc))
    if isinstance(exc, DimensionMismatch):
        return HTTPException(status.HTTP_409_CONFLICT, str(exc))
    if isinstance(exc, KeyError):
        return HTTPException(
            status.HTTP_404_NOT_FOUND,
            f"No collection named {exc.args[0]}. Create it first, with its dimension.",
        )
    logger.exception("Vector store operation failed")
    return HTTPException(status.HTTP_500_INTERNAL_SERVER_ERROR, "Vector store operation failed")


@app.get("/health", response_model=HealthResponse)
async def health() -> HealthResponse:
    """
    Always 200 while the process is serving.

    The database is optional in this stack, so its absence is reported rather than
    failing the check -- a non-200 here would restart a container whose only unavailable
    feature is one the operator chose not to configure.
    """
    if not store.configured:
        return HealthResponse(status="ok", database="unconfigured")

    try:
        return HealthResponse(status="ok", database="connected", collections=len(store.list_collections()))
    except Exception:  # noqa: BLE001
        return HealthResponse(status="ok", database="unreachable")


@app.get("/v1/collections", response_model=list[CollectionInfo], dependencies=[Depends(require_api_key)])
async def list_collections() -> list[CollectionInfo]:
    try:
        return [CollectionInfo(**c) for c in store.list_collections()]
    except Exception as err:  # noqa: BLE001
        raise _guard(err) from err


@app.post(
    "/v1/collections",
    response_model=CollectionInfo,
    status_code=status.HTTP_200_OK,
    dependencies=[Depends(require_api_key)],
)
async def create_collection(request: CreateCollectionRequest) -> CollectionInfo:
    if request.dimension > settings.max_dimension:
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            f"pgvector cannot index more than {settings.max_dimension} dimensions, so a "
            f"{request.dimension}-dimension collection would sequentially scan every query. "
            "Truncate the vectors, or raise VECTORS_MAX_DIMENSION if you accept that.",
        )

    try:
        store.collection(request.name, dimension=request.dimension)
        if request.index:
            store.create_index(request.name, replace=False)
    except Exception as err:  # noqa: BLE001
        raise _guard(err) from err

    return CollectionInfo(name=request.name, dimension=request.dimension)


@app.delete("/v1/collections/{name}", status_code=status.HTTP_204_NO_CONTENT,
            dependencies=[Depends(require_api_key)])
async def delete_collection(name: str) -> None:
    try:
        store.delete_collection(name)
    except Exception as err:  # noqa: BLE001
        raise _guard(err) from err


@app.post("/v1/collections/{name}/upsert", response_model=UpsertResponse,
          dependencies=[Depends(require_api_key)])
async def upsert(name: str, request: UpsertRequest) -> UpsertResponse:
    if len(request.records) > settings.max_batch_size:
        raise HTTPException(
            status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
            f"At most {settings.max_batch_size} records per request, got {len(request.records)}",
        )

    widths = {len(record.vector) for record in request.records}
    if len(widths) > 1:
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            f"Every vector in a batch must have the same width; got {sorted(widths)}",
        )

    try:
        count = store.upsert(
            name,
            [(record.id, record.vector, record.metadata) for record in request.records],
        )
    except Exception as err:  # noqa: BLE001
        raise _guard(err) from err

    return UpsertResponse(upserted=count)


@app.post("/v1/collections/{name}/query", response_model=QueryResponse,
          dependencies=[Depends(require_api_key)])
async def query(name: str, request: QueryRequest) -> QueryResponse:
    limit = min(request.limit, settings.max_limit)

    try:
        matches = store.query(name, request.vector, limit, request.filters, request.ef_search)
    except Exception as err:  # noqa: BLE001
        raise _guard(err) from err

    return QueryResponse(matches=matches)


@app.post("/v1/collections/{name}/fetch", response_model=FetchResponse,
          dependencies=[Depends(require_api_key)])
async def fetch(name: str, request: FetchRequest) -> FetchResponse:
    try:
        return FetchResponse(records=store.fetch(name, request.ids))
    except Exception as err:  # noqa: BLE001
        raise _guard(err) from err


@app.post("/v1/collections/{name}/delete", response_model=DeleteResponse,
          dependencies=[Depends(require_api_key)])
async def delete(name: str, request: DeleteRequest) -> DeleteResponse:
    if not request.ids and not request.filters:
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            'Provide "ids" or "filters"; deleting an entire collection is a separate call.',
        )

    try:
        return DeleteResponse(deleted=store.delete(name, request.ids, request.filters))
    except Exception as err:  # noqa: BLE001
        raise _guard(err) from err


@app.post("/v1/collections/{name}/index", status_code=status.HTTP_204_NO_CONTENT,
          dependencies=[Depends(require_api_key)])
async def create_index(name: str, request: IndexRequest) -> None:
    """
    Builds the ANN index.

    Its own endpoint because the index is built without CONCURRENTLY: on a populated
    collection it takes an exclusive lock and blocks writes until it finishes, which is a
    cost the caller should schedule rather than trip over.
    """
    try:
        store.create_index(name, replace=request.replace)
    except Exception as err:  # noqa: BLE001
        raise _guard(err) from err
