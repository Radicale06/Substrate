"""Model loading and encoding."""

import logging

import numpy as np
from sentence_transformers import SentenceTransformer

from .config import settings

logger = logging.getLogger(__name__)


class Embedder:
    """Wraps a sentence-transformers model behind the small surface this service needs."""

    def __init__(self) -> None:
        self._model: SentenceTransformer | None = None

    def load(self) -> None:
        """Called once at startup so the first request does not pay for loading."""
        logger.info("Loading embedding model %s", settings.model_id)
        self._model = SentenceTransformer(
            settings.model_id,
            device=settings.device,
            cache_folder=settings.cache_dir,
        )
        logger.info(
            "Loaded %s (%d dimensions) on %s",
            settings.model_id,
            self.dimensions,
            self.device,
        )

    @property
    def ready(self) -> bool:
        return self._model is not None

    @property
    def dimensions(self) -> int:
        return int(self._model.get_sentence_embedding_dimension()) if self._model else 0

    @property
    def device(self) -> str:
        return str(self._model.device) if self._model else "unloaded"

    def count_tokens(self, texts: list[str]) -> int:
        """Approximate usage accounting, using the model's own tokenizer."""
        if not self._model:
            return 0
        tokenizer = self._model.tokenizer
        return sum(len(tokenizer.encode(text, add_special_tokens=False)) for text in texts)

    def encode(
        self,
        texts: list[str],
        *,
        is_query: bool,
        instruction: str | None,
        dimensions: int | None,
    ) -> list[list[float]]:
        if not self._model:
            raise RuntimeError("Model is not loaded")

        prepared = [self._prepare(text, is_query, instruction) for text in texts]
        vectors = self._model.encode(
            prepared,
            batch_size=settings.max_batch_size,
            convert_to_numpy=True,
            normalize_embeddings=True,
            show_progress_bar=False,
        )

        if dimensions is not None and dimensions < vectors.shape[1]:
            # Matryoshka truncation. The full vector was unit length, so the slice is
            # not — re-normalize or cosine similarity comes out wrong.
            vectors = vectors[:, :dimensions]
            norms = np.linalg.norm(vectors, axis=1, keepdims=True)
            vectors = vectors / np.clip(norms, 1e-12, None)

        return vectors.tolist()

    def _prepare(self, text: str, is_query: bool, instruction: str | None) -> str:
        """
        Queries carry an instruction, documents never do.

        This asymmetry is what the instruction-tuned embedding models expect; applying
        the prefix to documents as well quietly costs retrieval quality.
        """
        if not is_query or not settings.use_instruction:
            return text
        task = instruction or settings.default_instruction

        return f"Instruct: {task}\nQuery: {text}"


embedder = Embedder()
