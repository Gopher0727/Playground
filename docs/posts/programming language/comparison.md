# Comparison

## Tech Stack

| 功能       | Go             | Rust            | Python                 | C++                          |
| ---------- | -------------- | --------------- | ---------------------- | ---------------------------- |
| Web框架    | **Echo** / Gin | **Axum**        | **FastAPI** / Django   | Drogon / Crow                |
| HTTP服务器 | net/http       | Hyper           | **Uvicorn** / Gunicorn | Boost.Beast                  |
| 并发模型   | goroutine      | **Tokio Task**  | asyncio Task           | std::thread / asio Coroutine |
| RPC        | grpc-go        | Tonic           | grpcio                 | grpc-cpp                     |
| ORM        | GORM           | SeaORM / Diesel | **SQLAlchemy**         | ODB                          |
| SQL工具    | sqlx           | SQLx            | SQLAlchemy Core        | SOCI                         |
| 桌面应用   | Wails / Fyne   | **Tauri**       | PyQt / PySide          | **Qt**                       |
| Protobuf   | protobuf-go    | Prost           | protobuf               | protobuf-cpp                 |
