"""Request and response shapes for the vector store."""

from typing import Annotated, Any

from pydantic import BaseModel, Field, StringConstraints

# A collection name becomes a Postgres table name in the `vecs` schema, and vecs
# interpolates it into raw SQL when it builds an index -- `on vecs."{name}"`, an f-string,
# not a bound parameter. A name carrying a double quote therefore closes the identifier and
# the rest of it is parsed as SQL. Constrained to an identifier here rather than escaped,
# because escaping correctly for every place vecs puts this string is not something this
# service can promise.
CollectionName = Annotated[
    str,
    StringConstraints(pattern=r"^[a-zA-Z][a-zA-Z0-9_]{0,62}$"),
]


class HealthResponse(BaseModel):
    status: str
    database: str
    collections: int | None = None


class CollectionInfo(BaseModel):
    name: str
    dimension: int


class CreateCollectionRequest(BaseModel):
    name: CollectionName
    dimension: int = Field(..., ge=1)
    index: bool = Field(
        True,
        description=(
            "Build the ANN index immediately. Safe on an empty collection; on a populated "
            "one it takes an exclusive lock, so use POST /index when you choose to pay it."
        ),
    )


class VectorRecord(BaseModel):
    id: str = Field(..., min_length=1)
    vector: list[float] = Field(..., min_length=1)
    metadata: dict[str, Any] = Field(default_factory=dict)


class UpsertRequest(BaseModel):
    records: list[VectorRecord] = Field(..., min_length=1)


class UpsertResponse(BaseModel):
    upserted: int


class QueryRequest(BaseModel):
    vector: list[float] = Field(..., min_length=1)
    limit: int = Field(10, ge=1)
    filters: dict[str, Any] | None = Field(
        None,
        description='Metadata filter, e.g. {"host": {"$eq": "example.com"}}',
    )
    ef_search: int | None = Field(
        None,
        ge=1,
        description="HNSW search breadth. Higher finds more neighbours and costs more time.",
    )


class QueryMatch(BaseModel):
    id: str
    distance: float
    similarity: float
    metadata: dict[str, Any]


class QueryResponse(BaseModel):
    matches: list[QueryMatch]


class FetchRequest(BaseModel):
    ids: list[str] = Field(..., min_length=1)


class FetchedRecord(BaseModel):
    id: str
    vector: list[float]
    metadata: dict[str, Any]


class FetchResponse(BaseModel):
    records: list[FetchedRecord]


class DeleteRequest(BaseModel):
    ids: list[str] | None = None
    filters: dict[str, Any] | None = None


class DeleteResponse(BaseModel):
    deleted: int


class IndexRequest(BaseModel):
    replace: bool = Field(True, description="Rebuild the index if one already exists")
