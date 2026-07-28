"""Environment-driven configuration for the embedding service."""

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

    # Any sentence-transformers model. The default is Apache-2.0 licensed, has a
    # first-party GGUF/weights release, 32k context and Matryoshka support.
    model_id: str = os.getenv("MODEL_ID", "Qwen/Qwen3-Embedding-0.6B")

    # "cpu", "cuda", or empty to let sentence-transformers decide.
    device: str | None = os.getenv("MODEL_DEVICE") or None

    # Where HuggingFace caches weights. Mounted as a volume so restarts do not re-download.
    cache_dir: str = os.getenv("HF_HOME", "/models")

    max_batch_size: int = _int_from_env("MAX_BATCH_SIZE", 32)

    # Total input strings accepted in one request.
    max_inputs: int = _int_from_env("MAX_INPUTS", 256)

    # Optional shared secret. When set, callers must send `Authorization: Bearer <key>`.
    api_key: str | None = os.getenv("INFERENCE_API_KEY") or None

    # Qwen3-Embedding expects queries — never documents — to carry an instruction.
    # `or`, not os.getenv's default argument: compose passes an unset variable through
    # as an empty string, which getenv returns verbatim — silently emptying the prefix.
    default_instruction: str = os.getenv("DEFAULT_INSTRUCTION") or (
        "Given a web search query, retrieve relevant passages that answer the query"
    )

    # Whether this model wants the instruction prefix at all. Set false for models
    # like BGE or E5 that use their own prefixes or none.
    use_instruction: bool = (os.getenv("USE_INSTRUCTION") or "true").lower() != "false"


settings = Settings()
