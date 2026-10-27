"""Content-addressed blob store. Keys look like `study/session/step/<sha256>.<ext>`, matching the spec's
object-storage layout; swapping in S3/R2/MinIO only means re-implementing put/get."""
from __future__ import annotations

from pathlib import Path
from typing import Optional

from ..config import config
from ..util import sha256


class BlobStore:
    def __init__(self, root: Optional[Path] = None):
        self.root = (root or config.data_dir / "blobs").resolve()
        self.root.mkdir(parents=True, exist_ok=True)

    def put(self, prefix: str, data: bytes | str, ext: str) -> str:
        buf = data.encode() if isinstance(data, str) else data
        key = f"{prefix.rstrip('/')}/{sha256(buf)}.{ext}"
        file = self.path(key)
        # Immutable: identical content maps to the same key and is never rewritten.
        if not file.exists():
            file.parent.mkdir(parents=True, exist_ok=True)
            file.write_bytes(buf)
        return key

    def get(self, key: str) -> bytes:
        return self.path(key).read_bytes()

    def path(self, key: str) -> Path:
        p = (self.root / key).resolve()
        if not str(p).startswith(str(self.root)):
            raise ValueError(f"blob key escapes store: {key}")
        return p

    def exists(self, key: Optional[str]) -> bool:
        if not key:
            return False
        try:
            return self.path(key).exists()
        except ValueError:
            return False
