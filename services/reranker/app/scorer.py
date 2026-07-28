"""
Relevance scoring.

Two model families are supported behind one interface:

* ``causal``        Qwen3-Reranker. The model is asked to answer "yes" or "no", and the
                    score is the probability it assigns to "yes".
* ``cross-encoder`` Classic sequence-classification rerankers such as bge-reranker-v2-m3.

They are kept behind the same ``score()`` so the HTTP layer — and the backend calling it —
never has to care which is loaded.
"""

import logging

import torch
from transformers import AutoModelForCausalLM, AutoModelForSequenceClassification, AutoTokenizer

from .config import settings

logger = logging.getLogger(__name__)

# The template Qwen3-Reranker was trained with. The wording is not decorative: the model
# was tuned to answer this exact question, so changing it degrades scores.
_QWEN_PREFIX = (
    "<|im_start|>system\n"
    "Judge whether the Document meets the requirements based on the Query and the "
    'Instruct provided. Note that the answer can only be "yes" or "no".<|im_end|>\n'
    "<|im_start|>user\n"
)
_QWEN_SUFFIX = "<|im_end|>\n<|im_start|>assistant\n<think>\n\n</think>\n\n"


class Scorer:
    def __init__(self) -> None:
        self._model = None
        self._tokenizer = None
        self._yes_id: int | None = None
        self._no_id: int | None = None

    def load(self) -> None:
        kind = settings.model_kind
        logger.info("Loading %s reranker %s", kind, settings.model_id)

        self._tokenizer = AutoTokenizer.from_pretrained(
            settings.model_id, cache_dir=settings.cache_dir
        )

        if kind == "causal":
            # Left padding: scores are read from the final position, which must be the
            # real last token rather than padding.
            self._tokenizer.padding_side = "left"
            if self._tokenizer.pad_token is None:
                self._tokenizer.pad_token = self._tokenizer.eos_token
            self._model = AutoModelForCausalLM.from_pretrained(
                settings.model_id, cache_dir=settings.cache_dir
            ).eval()
            self._yes_id = self._tokenizer.convert_tokens_to_ids("yes")
            self._no_id = self._tokenizer.convert_tokens_to_ids("no")
        else:
            self._model = AutoModelForSequenceClassification.from_pretrained(
                settings.model_id, cache_dir=settings.cache_dir
            ).eval()

        if settings.device:
            self._model.to(settings.device)

        logger.info("Loaded %s on %s", settings.model_id, self.device)

    @property
    def ready(self) -> bool:
        return self._model is not None

    @property
    def device(self) -> str:
        return str(next(self._model.parameters()).device) if self._model else "unloaded"

    def count_tokens(self, pairs: list[tuple[str, str]]) -> int:
        if not self._tokenizer:
            return 0
        return sum(
            len(self._tokenizer.encode(q, add_special_tokens=False))
            + len(self._tokenizer.encode(d, add_special_tokens=False))
            for q, d in pairs
        )

    @torch.inference_mode()
    def score(self, query: str, documents: list[str], instruction: str | None) -> list[float]:
        if not self._model or not self._tokenizer:
            raise RuntimeError("Model is not loaded")

        scores: list[float] = []
        for start in range(0, len(documents), settings.max_batch_size):
            batch = documents[start : start + settings.max_batch_size]
            if settings.model_kind == "causal":
                scores.extend(self._score_causal(query, batch, instruction))
            else:
                scores.extend(self._score_cross_encoder(query, batch))

        return scores

    def _score_causal(self, query: str, documents: list[str], instruction: str | None) -> list[float]:
        task = instruction or settings.default_instruction
        prompts = [
            f"{_QWEN_PREFIX}<Instruct>: {task}\n<Query>: {query}\n<Document>: {doc}{_QWEN_SUFFIX}"
            for doc in documents
        ]
        encoded = self._tokenizer(
            prompts,
            padding=True,
            truncation=True,
            max_length=settings.max_length,
            return_tensors="pt",
        ).to(self._model.device)

        logits = self._model(**encoded).logits[:, -1, :]
        # Softmax over just the yes/no pair, so the score is the model's confidence in
        # "yes" relative to "no" rather than against the whole vocabulary.
        pair = torch.stack([logits[:, self._no_id], logits[:, self._yes_id]], dim=1)
        probabilities = torch.nn.functional.log_softmax(pair.float(), dim=1)

        return probabilities[:, 1].exp().tolist()

    def _score_cross_encoder(self, query: str, documents: list[str]) -> list[float]:
        encoded = self._tokenizer(
            [query] * len(documents),
            documents,
            padding=True,
            truncation=True,
            max_length=settings.max_length,
            return_tensors="pt",
        ).to(self._model.device)

        logits = self._model(**encoded).logits
        # These models emit a single raw logit per pair; squash it so callers always see
        # a comparable 0-1 score. Sigmoid is monotonic, so the ranking is unchanged.
        if logits.shape[-1] == 1:
            return torch.sigmoid(logits.squeeze(-1).float()).tolist()

        return torch.softmax(logits.float(), dim=-1)[:, -1].tolist()


scorer = Scorer()
