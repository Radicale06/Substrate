"""The vecs-backed vector store.

Deliberately does no embedding. Vectors come in, ids and distances go out — which keeps
the embedding service stateless and keeps this store model-agnostic, so swapping the
embedding model does not require this service to know anything about it.
"""

import logging
import re
import threading
from typing import Any

import vecs
from vecs import IndexArgsHNSW, IndexMeasure, IndexMethod

from .config import settings
from .dsn import normalize_dsn

logger = logging.getLogger("vectors.store")

# Enforced here, not only at the API edge, because this is the last point before the name
# becomes a Postgres identifier -- and vecs interpolates it into raw SQL to build an index
# (`on vecs."{name}"`), so a name containing a double quote closes the identifier and the
# remainder is parsed as SQL. Same rule as the backend applies to its path parameters; it
# lives in both places because this service is independently reachable.
_VALID_NAME = re.compile(r"^[a-zA-Z][a-zA-Z0-9_]{0,62}$")

# Cosine everywhere. The measure used to build the index and the measure used to query
# must agree, or pgvector silently ignores the index and sequentially scans the table --
# vecs emits a UserWarning that is easy to never see in container logs.
MEASURE = IndexMeasure.cosine_distance


class InvalidName(Exception):
    """A collection name that must not reach a SQL identifier."""


class DimensionMismatch(Exception):
    """A collection exists with a different width than the one requested."""


class NotConfigured(Exception):
    """No database is configured, so there is nowhere to put vectors."""


class VectorStore:
    """Thin wrapper over a vecs client, with the collection handles cached."""

    def __init__(self) -> None:
        self._client: vecs.Client | None = None
        self._collections: dict[str, Any] = {}
        self._lock = threading.Lock()

    @property
    def configured(self) -> bool:
        return bool(settings.database_url)

    def connect(self) -> None:
        """Opens the client. Creating it runs DDL, so it happens once at startup."""
        if not settings.database_url:
            logger.info("No database configured; the vector store is disabled")
            return

        dsn = normalize_dsn(settings.database_url)
        # vecs.create_client() runs `create schema if not exists vecs` and
        # `create extension if not exists vector` -- both need a direct connection, not a
        # transaction pooler, which is why config prefers DIRECT_URL.
        self._client = vecs.create_client(dsn)
        logger.info("Vector store connected; collections live in the `vecs` schema")

    def disconnect(self) -> None:
        if self._client is not None:
            self._client.disconnect()
            self._client = None
            self._collections.clear()

    def _require_client(self) -> vecs.Client:
        if self._client is None:
            raise NotConfigured(
                "No database is configured. Set VECTORS_DATABASE_URL (or DIRECT_URL / "
                "DATABASE_URL) to a Postgres with the pgvector extension available."
            )
        return self._client

    @staticmethod
    def _valid(name: str) -> str:
        if not _VALID_NAME.match(name or ""):
            raise InvalidName(
                "A collection name must start with a letter and contain only letters, "
                "digits and underscores, up to 63 characters."
            )

        return name

    @staticmethod
    def _checked(collection, dimension: int | None):
        """
        Re-applies the width check the cache would otherwise skip.

        vecs raises MismatchedDimension from get_or_create_collection, but a cache hit
        never calls it -- so without this, asking for a width the collection does not
        have returned the existing handle and reported success. The caller then upserted
        vectors of the wrong width and found out from a database error several calls later.
        """
        if dimension is not None and collection.dimension != dimension:
            raise DimensionMismatch(
                f"Collection {collection.name} has {collection.dimension} dimensions, "
                f"not {dimension}. A collection's width is fixed when it is created, so "
                "use a different name for vectors of a different width."
            )

        return collection

    def collection(self, name: str, dimension: int | None = None):
        """
        Returns a collection handle, creating it when a dimension is supplied.

        Handles are cached because get_or_create_collection round-trips to the database
        every time, and an upsert of one batch would otherwise pay for it repeatedly.
        """
        client = self._require_client()
        self._valid(name)

        cached = self._collections.get(name)
        if cached is not None:
            return self._checked(cached, dimension)

        with self._lock:
            cached = self._collections.get(name)
            if cached is not None:
                return self._checked(cached, dimension)

            try:
                if dimension is None:
                    collection = client.get_collection(name)
                else:
                    collection = client.get_or_create_collection(name=name, dimension=dimension)
            except vecs.exc.CollectionNotFound as err:
                raise KeyError(name) from err
            except vecs.exc.MismatchedDimension as err:
                # The width is baked into the table, so this is not recoverable by
                # retrying -- the caller has to pick a different collection name.
                raise DimensionMismatch(str(err)) from err

            self._collections[name] = collection
            return collection

    def list_collections(self) -> list[dict[str, Any]]:
        client = self._require_client()

        return [{"name": c.name, "dimension": c.dimension} for c in client.list_collections()]

    def delete_collection(self, name: str) -> None:
        client = self._require_client()
        client.delete_collection(self._valid(name))
        self._collections.pop(name, None)

    def _require_width(self, collection, width: int, what: str) -> None:
        """
        Checks a vector's width against the collection before Postgres does.

        Not cosmetic. pgvector rejects the wrong width with a driver error that names the
        table and not the caller's mistake, which arrived as a 500 -- so the one failure a
        caller is most likely to hit while switching embedding model was the one failure
        that looked like the service was broken.
        """
        if width != collection.dimension:
            raise DimensionMismatch(
                f"Collection {collection.name} holds {collection.dimension}-dimension "
                f"vectors; the {what} has {width}. A collection's width is fixed when it "
                "is created, so this needs a different collection, not a retry."
            )

    def upsert(self, name: str, records: list[tuple[str, list[float], dict]]) -> int:
        # dimension=None on purpose: an upsert must not create the collection it writes
        # to, so a missing one stays a 404 rather than becoming a silent create.
        collection = self.collection(name)
        self._require_width(collection, len(records[0][1]), "batch")
        collection.upsert(records=records)

        return len(records)

    def query(
        self,
        name: str,
        vector: list[float],
        limit: int,
        filters: dict | None,
        ef_search: int | None,
    ) -> list[dict[str, Any]]:
        collection = self.collection(name)
        self._require_width(collection, len(vector), "query vector")

        rows = collection.query(
            data=vector,
            limit=limit,
            filters=filters or None,
            measure=MEASURE,
            include_value=True,
            include_metadata=True,
            # Raising ef_search trades latency for recall. Left unset, pgvector's default
            # can miss neighbours on a large table.
            ef_search=ef_search,
        )

        # vecs returns (id, distance, metadata) when both include flags are set. Cosine
        # distance is 1 - similarity, so the similarity is reported alongside it rather
        # than leaving every caller to remember the conversion.
        return [
            {
                "id": row[0],
                "distance": float(row[1]),
                "similarity": 1.0 - float(row[1]),
                "metadata": row[2],
            }
            for row in rows
        ]

    def fetch(self, name: str, ids: list[str]) -> list[dict[str, Any]]:
        collection = self.collection(name)

        return [
            {"id": row[0], "vector": list(row[1]), "metadata": row[2]}
            for row in collection.fetch(ids=ids)
        ]

    def delete(self, name: str, ids: list[str] | None, filters: dict | None) -> int:
        collection = self.collection(name)
        deleted = collection.delete(ids=ids or None, filters=filters or None)

        return len(deleted)

    def create_index(self, name: str, replace: bool) -> None:
        """
        Builds the ANN index.

        Kept an explicit call rather than something done at creation: vecs issues
        CREATE INDEX without CONCURRENTLY, which takes an exclusive lock and blocks
        writes for as long as the build takes. On an empty collection that is instant; on
        a populated one it is an outage, and the caller should choose when to pay it.

        `replace=False` means "make sure it is indexed", not "fail if it already is".
        vecs raises ArgError in that case, which turned a re-run of an idempotent create
        into a 500 -- and creating a collection that already exists is otherwise a
        perfectly good no-op.
        """
        collection = self.collection(name)
        if not replace and collection.index is not None:
            return

        try:
            collection.create_index(
                method=IndexMethod.hnsw,
                measure=MEASURE,
                index_arguments=IndexArgsHNSW(m=16, ef_construction=64),
                replace=replace,
            )
        except vecs.exc.ArgError:
            # Two callers can pass the check above concurrently, and the loser gets the
            # same "an index exists" error. Confirming the index is there is the check
            # that matters; anything else ArgError covers (a measure or method vecs
            # rejects) leaves it absent, so re-raise on that.
            if replace or collection.index is None:
                raise


store = VectorStore()
