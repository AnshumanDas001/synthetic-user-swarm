import os
import threading
import time

import pytest
import uvicorn

os.environ.setdefault("SWARM_QUIET", "1")
os.environ["SWARM_MODEL_MODE"] = "mock"
os.environ.setdefault("SWARM_SECRET", "test-secret-for-hosted-mode")

from swarm.config import config  # noqa: E402

config.model_mode = "mock"


@pytest.fixture
def data_dir(tmp_path, monkeypatch):
    monkeypatch.setattr(config, "data_dir", tmp_path)
    return tmp_path


@pytest.fixture(scope="session")
def shop():
    """The seeded-defect demo shop on a background thread."""
    from demo_shop.app import app
    port = 4471
    server = uvicorn.Server(uvicorn.Config(app, host="127.0.0.1", port=port, log_level="warning"))
    t = threading.Thread(target=server.run, daemon=True)
    t.start()
    for _ in range(100):
        if server.started:
            break
        time.sleep(0.05)
    yield f"http://localhost:{port}"
    server.should_exit = True
    t.join(timeout=5)
