import logging

import uvicorn

if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    # 沒有登入驗證，所以只綁定本機，不可改成 0.0.0.0
    uvicorn.run("app.main:create_app", factory=True, host="127.0.0.1", port=8000)
