"""In-memory document store for dry-run / unit tests.

Mimics the subset of Firestore we need: get, set, update, query, transaction.
Never talks to the network.
"""
from __future__ import annotations

from copy import deepcopy
from dataclasses import dataclass, field
from typing import Any, Callable
from uuid import uuid4


@dataclass
class MemoryStore:
    data: dict[str, dict[str, dict[str, Any]]] = field(default_factory=dict)

    def _col(self, name: str) -> dict[str, dict[str, Any]]:
        return self.data.setdefault(name, {})

    def get(self, collection: str, doc_id: str) -> dict[str, Any] | None:
        doc = self._col(collection).get(doc_id)
        return deepcopy(doc) if doc is not None else None

    def set(self, collection: str, doc_id: str, payload: dict[str, Any], merge: bool = False) -> None:
        col = self._col(collection)
        if merge and doc_id in col:
            merged = deepcopy(col[doc_id])
            merged.update(deepcopy(payload))
            col[doc_id] = merged
        else:
            col[doc_id] = deepcopy(payload)

    def add(self, collection: str, payload: dict[str, Any]) -> str:
        doc_id = uuid4().hex
        self.set(collection, doc_id, {**payload, "id": doc_id})
        return doc_id

    def delete(self, collection: str, doc_id: str) -> None:
        self._col(collection).pop(doc_id, None)

    def query(
        self,
        collection: str,
        *,
        where: list[tuple[str, str, Any]] | None = None,
    ) -> list[tuple[str, dict[str, Any]]]:
        where = where or []
        out: list[tuple[str, dict[str, Any]]] = []
        for doc_id, doc in self._col(collection).items():
            ok = True
            for field, op, value in where:
                cur = doc.get(field)
                if op == "==" and cur != value:
                    ok = False
                elif op == "!=" and cur == value:
                    ok = False
                elif op == "in" and cur not in value:
                    ok = False
            if ok:
                out.append((doc_id, deepcopy(doc)))
        return out

    def run_transaction(self, fn: Callable[["MemoryStore"], Any]) -> Any:
        """Naive transaction: copy → apply → commit, or discard on exception."""
        snapshot = deepcopy(self.data)
        try:
            result = fn(self)
            return result
        except Exception:
            self.data = snapshot
            raise
