"""Request and response models, shaped to match the OpenAI embeddings API."""

from typing import Literal

from pydantic import BaseModel, Field

# "query" gets the instruction prefix; "passage" never does. Getting this backwards
# degrades retrieval quality silently, so it is explicit in the API.
TaskType = Literal["retrieval.query", "retrieval.passage", "text-matching"]


class EmbeddingsRequest(BaseModel):
    input: str | list[str] = Field(..., description="Text, or a list of texts, to embed")
    model: str | None = Field(None, description="Ignored; the served model is fixed")
    task: TaskType = Field(
        "retrieval.passage",
        description="retrieval.query applies the instruction prefix; passage does not",
    )
    dimensions: int | None = Field(
        None,
        ge=1,
        description=(
            "Truncate to this many dimensions (Matryoshka), then re-normalize. "
            "Only accepted when the loaded model documents MRL; see SUPPORTS_MRL."
        ),
    )
    instruction: str | None = Field(
        None, description="Overrides the default instruction for query inputs"
    )


class EmbeddingItem(BaseModel):
    object: Literal["embedding"] = "embedding"
    index: int
    embedding: list[float]


class Usage(BaseModel):
    prompt_tokens: int
    total_tokens: int


class EmbeddingsResponse(BaseModel):
    object: Literal["list"] = "list"
    model: str
    data: list[EmbeddingItem]
    usage: Usage


class HealthResponse(BaseModel):
    status: str
    model: str
    dimensions: int
    device: str
    supports_mrl: bool
