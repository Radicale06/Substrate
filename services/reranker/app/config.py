"""Environment-driven configuration for the reranker service."""

import os


def _int_from_env(name: str, default: int) -> int:
    raw = os.getenv(name)
    if not raw:
        return default
    try:
        value = int(raw)
    except ValueError:
        return default
    return value if value > 0 else default


class Settings:
    """Read once at import; every value has a working default."""

    # Two architectures are supported, selected by MODEL_KIND:
    #   "causal"        Qwen3-Reranker — scores from yes/no logits (default, best quality)
    #   "cross-encoder" BGE / mxbai style sequence classifiers
    model_id: str = os.getenv("MODEL_ID", "Qwen/Qwen3-Reranker-0.6B")
    model_kind: str = os.getenv("MODEL_KIND", "causal").lower()

    device: str | None = os.getenv("MODEL_DEVICE") or None
    cache_dir: str = os.getenv("HF_HOME", "/models")

    max_batch_size: int = _int_from_env("MAX_BATCH_SIZE", 8)
    max_documents: int = _int_from_env("MAX_DOCUMENTS", 200)
    max_length: int = _int_from_env("MAX_LENGTH", 4096)

    api_key: str | None = os.getenv("INFERENCE_API_KEY") or None

    # `or`, not os.getenv's default argument: compose passes an unset variable through
    # as an empty string, which getenv returns verbatim — silently emptying the prefix.
    default_instruction: str = os.getenv("DEFAULT_INSTRUCTION") or (
        "Given a web search query, retrieve relevant passages that answer the query"
    )


settings = Settings()
