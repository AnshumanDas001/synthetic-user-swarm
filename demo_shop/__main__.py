"""python -m demo_shop  (PORT=4400; DEFECTS=all, none or D01,D04; SHOP_HOST=0.0.0.0 to expose it)"""
import os

import uvicorn

from .app import app, enabled_ids

if __name__ == "__main__":
    port = int(os.environ.get("PORT", 4400))
    print(f"Kindling & Co. demo shop on http://localhost:{port}  (defects: {enabled_ids()})", flush=True)
    uvicorn.run(app, host=os.environ.get("SHOP_HOST", "127.0.0.1"), port=port, log_level="warning")
