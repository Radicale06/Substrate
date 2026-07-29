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

    # Any sentence-transformers model. The default is MIT licensed, 32k context,
    # 1024 dimensions, and loads through plain SentenceTransformer() with no
    # trust_remote_code. See the README for why this one and what it costs.
    model_id: str = os.getenv("MODEL_ID", "microsoft/harrier-oss-v1-0.6b")

    # "cpu", "cuda", or empty to let sentence-transformers decide.
    device: str | None = os.getenv("MODEL_DEVICE") or None

    # Where HuggingFace caches weights. Mounted as a volume so restarts do not re-download.
    cache_dir: str = os.getenv("HF_HOME", "/models")

    max_batch_size: int = _int_from_env("MAX_BATCH_SIZE", 32)

    # Total input strings accepted in one request.
    max_inputs: int = _int_from_env("MAX_INPUTS", 256)

    # Optional shared secret. When set, callers must send `Authorization: Bearer <key>`.
    api_key: str | None = os.getenv("INFERENCE_API_KEY") or None

    # Instruction-tuned embedders expect queries — never documents — to carry a prefix.
    # `or`, not os.getenv's default argument: compose passes an unset variable through
    # as an empty string, which getenv returns verbatim — silently emptying the prefix.
    default_instruction: str = os.getenv("DEFAULT_INSTRUCTION") or (
        "Given a web search query, retrieve relevant passages that answer the query"
    )

    # Whether this model wants the instruction prefix at all. Set false for models
    # like BGE or E5 that use their own prefixes or none.
    use_instruction: bool = (os.getenv("USE_INSTRUCTION") or "true").lower() != "false"

    # Whether this model was trained with Matryoshka representation learning, i.e.
    # whether a truncated vector is still a good vector.
    #
    # This is a per-model capability, not a property of the code: truncating any
    # embedding "works" arithmetically and re-normalizing keeps it unit length, so a
    # non-MRL model returns a plausible-looking vector of the requested size whose
    # quality has quietly collapsed. That silent failure is the reason this is an
    # explicit flag rather than something inferred.
    #
    # The default model (harrier-oss-v1) does not document MRL, so `dimensions` is
    # refused rather than silently honoured. Qwen3-Embedding does document it
    # (32-1024 for 0.6B), so set this true when switching to that family.
    supports_mrl: bool = (os.getenv("SUPPORTS_MRL") or "false").lower() == "true"


settings = Settings()
