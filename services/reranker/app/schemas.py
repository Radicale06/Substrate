"""Request and response models, shaped to match the Jina/Cohere rerank API."""

from typing import Literal

from pydantic import BaseModel, Field


class RerankRequest(BaseModel):
    query: str = Field(..., min_length=1, description="The search query")
    documents: list[str] = Field(..., min_length=1, description="Candidates to score")
    model: str | None = Field(None, description="Ignored; the served model is fixed")
    top_n: int | None = Field(
        None, ge=1, description="Return only the best N. Defaults to all documents"
    )
    return_documents: bool = Field(
        False, description="Echo the document text alongside each result"
    )
    instruction: str | None = Field(
        None, description="Task description, for instruction-following rerankers"
    )


class RerankDocument(BaseModel):
    text: str


class RerankResult(BaseModel):
    index: int = Field(..., description="Position in the original documents array")
    relevance_score: float
    document: RerankDocument | None = None


class Usage(BaseModel):
    total_tokens: int


class RerankResponse(BaseModel):
    model: str
    object: Literal["list"] = "list"
    results: list[RerankResult]
    usage: Usage


class HealthResponse(BaseModel):
    status: str
    model: str
    kind: str
    device: str
