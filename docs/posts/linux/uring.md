# io_uring

## What's this

`io_uring` 是 Linux 内核自 **5.1（2019年3月）** 引入的高性能异步 I/O 框架，由 Jens Axboe 设计。它通过**共享内存环形缓冲区（shared ring buffers）**取代传统的系统调用模型，从根本上解决了 Linux 长期以来的异步 I/O 痛点——`epoll` 不支持文件 I/O，`linux-aio` 不支持网络 I/O 且可能阻塞。

Key benefits:

- **统一的异步 API** — 文件 I/O、网络 I/O、文件系统操作全部使用同一接口。
- **零/极少系统调用** — 正常路径仅需内存读写，无需陷入内核；配合 SQPOLL 可实现完全零系统调用。
- **批量提交与收割** — 一次 `io_uring_enter()` 可提交多个 SQE、收割多个 CQE。
- **真正的非阻塞** — 配合正确标志，io_uring 永远不会在内核中阻塞调用线程。

## Architecture

io_uring 的核心设计是通过 **mmap 共享的两个环形缓冲区** 实现用户态与内核态的零拷贝通信：

```
                User Space                          Kernel Space
        ┌───────────────────────┐          ┌───────────────────────┐
        │  Submission Queue     │  写入    │                       │
        │  ┌───┬───┬───┬───┐    │ ──────→  │  从 SQ head 读取 SQE  │
        │  │ 0 │ 1 │ 2 │ 3 │    │   SQE    │                       │
        │  └───┴───┴───┴───┘    │          │  执行 I/O 操作        │
        │     tail ↑            │          │                       │
        └───────────────────────┘          │  写入 CQE 到 CQ tail  │
                                           │                       │
        ┌───────────────────────┐          │                       │
        │  Completion Queue     │  读取    │                       │
        │  ┌───┬───┬───┬───┐    │ ←──────  │                       │
        │  │ 0 │ 1 │ 2 │ 3 │    │   CQE    │                       │
        │  └───┴───┴───┴───┘    │          └───────────────────────┘
        │  head ↑               │
        └───────────────────────┘
```

### 关键数据结构

| 组件 | 方向 | 描述 |
|------|------|------|
| **SQ** (Submission Queue) | 用户 → 内核 | 用户向 tail 写入 SQE，内核从 head 消费 |
| **CQ** (Completion Queue) | 内核 → 用户 | 内核向 tail 写入 CQE，用户从 head 消费 |
| **SQE** (Submission Queue Entry) | — | 描述一次 I/O 操作：opcode、fd、buffer、offset、user_data |
| **CQE** (Completion Queue Entry) | — | 包含结果：user_data（用于关联 SQE）、res（返回值或 -errno）、flags |

### 请求生命周期

1. **Setup** — 调用 `io_uring_setup()` 创建并 mmap 环形缓冲区
2. **Prepare** — 从 SQ 获取一个空闲 SQE，填充 opcode、fd、buffer 等字段
3. **Submit** — 调用 `io_uring_enter()` 通知内核消费 SQE（或由 SQPOLL 内核线程自动轮询）
4. **Process** — 内核分发 SQE 到对应 handler（inline、async worker 或硬件直通）
5. **Complete** — 内核将 CQE 写入 CQ tail
6. **Reap** — 用户从 CQ head 读取 CQE，处理结果

## How to Use

以下示例使用 `liburing`（推荐）；也可直接使用 raw 系统调用。

### 基本读操作

```c
#include <liburing.h>
#include <stdio.h>
#include <fcntl.h>
#include <string.h>

int main() {
    struct io_uring ring;
    struct io_uring_sqe *sqe;
    struct io_uring_cqe *cqe;
    char buf[4096];

    // 1. 初始化 io_uring，队列深度 32
    io_uring_queue_init(32, &ring, 0);

    int fd = open("/tmp/test.txt", O_RDONLY);
    if (fd < 0) { perror("open"); return 1; }

    // 2. 获取一个空闲 SQE 并准备读操作
    sqe = io_uring_get_sqe(&ring);
    io_uring_prep_read(sqe, fd, buf, sizeof(buf), 0);
    sqe->user_data = 42;  // 自定义 tag，用于关联 CQE

    // 3. 提交 SQE 到内核
    io_uring_submit(&ring);

    // 4. 等待至少一个完成事件
    io_uring_wait_cqe(&ring, &cqe);

    // 5. 检查结果
    if (cqe->res < 0) {
        fprintf(stderr, "I/O error: %s\n", strerror(-cqe->res));
    } else {
        printf("Read %d bytes, user_data=%llu\n", cqe->res, cqe->user_data);
    }

    // 6. 标记 CQE 已消费
    io_uring_cqe_seen(&ring, cqe);

    close(fd);
    io_uring_queue_exit(&ring);
    return 0;
}
```

### 批量提交与收割

io_uring 的核心优势是批处理——一次提交多个 SQE，一次收割多个 CQE：

```c
#define BATCH_SIZE 16

// 批量准备 SQE
for (int i = 0; i < BATCH_SIZE; i++) {
    sqe = io_uring_get_sqe(&ring);
    io_uring_prep_read(sqe, fds[i], bufs[i], BLOCK_SIZE, offsets[i]);
    sqe->user_data = (unsigned long)i;
}
// 一次提交全部
int submitted = io_uring_submit(&ring);

// 批量收割完成事件
struct io_uring_cqe *cqes[BATCH_SIZE];
int completed = io_uring_peek_batch_cqe(&ring, cqes, BATCH_SIZE);
for (int i = 0; i < completed; i++) {
    if (cqes[i]->res >= 0) {
        handle_completion(cqes[i]);
    }
}
io_uring_cq_advance(&ring, completed);
```

### 链式操作（Linked SQEs）

使用 `IOSQE_IO_LINK` 将多个 SQE 串行化为原子链——前一个完成才开始下一个，任一失败则链中断：

```c
// recv 和 send 链式执行 —— 一次 enter，两个操作
sqe = io_uring_get_sqe(&ring);
io_uring_prep_recv(sqe, conn_fd, buf, sizeof(buf), 0);
sqe->flags |= IOSQE_IO_LINK;  // 链到下一个 SQE
sqe->user_data = RX_TAG;

sqe = io_uring_get_sqe(&ring);
io_uring_prep_send(sqe, conn_fd, response, response_len, 0);
// 无 LINK 标志 → 链在此结束
sqe->user_data = TX_TAG;

io_uring_submit(&ring);
```

### 超时控制

```c
struct __kernel_timespec ts = { .tv_sec = 1, .tv_nsec = 0 };

sqe = io_uring_get_sqe(&ring);
io_uring_prep_timeout(sqe, &ts, 0, 0);
// 当超时到期时，CQE 中 res = -ETIME
```

## Key Features

### 轮询模式

| 模式 | 标志 | 行为 | 适用场景 |
|------|------|------|----------|
| **IOPOLL** | `IORING_SETUP_IOPOLL` | 忙轮询等待 I/O 完成（需设备支持，如 NVMe + `O_DIRECT`） | 低延迟存储，牺牲 CPU 换 latency |
| **SQPOLL** | `IORING_SETUP_SQPOLL` | 内核线程持续轮询 SQ，提交无需 `io_uring_enter()` | 高吞吐场景，会占用一个 CPU 核 |
| **Hybrid Poll** | 5.x 后引入 | 延迟一小段时间再轮询，减少无效 CPU 消耗 | IOPOLL 的折中方案 |

### 资源注册

```c
// 注册文件描述符 — 避免每次 I/O 的 fd 查找开销
int fds[] = {fd1, fd2, fd3};
io_uring_register(ring.ring_fd, IORING_REGISTER_FILES, fds, 3);

// 使用固定文件：设置 IOSQE_FIXED_FILE，fd 填数组索引
sqe = io_uring_get_sqe(&ring);
io_uring_prep_read(sqe, 0 /* 索引而非 fd */, buf, size, offset);
sqe->flags |= IOSQE_FIXED_FILE;
```

```c
// 注册缓冲区 — 避免每次 I/O 的页面 pin/unpin 开销
struct iovec iovs[NUM_BUFS];
// ... 填充 iovs ...
io_uring_register(ring.ring_fd, IORING_REGISTER_BUFFERS, iovs, NUM_BUFS);

// 使用固定缓冲区
sqe = io_uring_get_sqe(&ring);
io_uring_prep_read_fixed(sqe, fd, NULL /* addr 可为 NULL */, size, offset, buf_index);
```

### Multishot 操作

单次 SQE 持续生效，无需重复提交——是 "干掉事件循环" 的关键特性：

| 操作 | 引入版本 | 效果 |
|------|---------|------|
| `IORING_OP_ACCEPT` (multishot) | 5.19 | 一个 SQE 处理所有新连接，每个连接产生一个 CQE |
| `IORING_OP_RECV` (multishot) | 6.0 | 一个 SQE 持续接收数据，每到达一次产生一个 CQE |
| `IORING_OP_POLL_ADD` (multishot) | 5.13 | 一个 SQE 持续监控 fd 就绪事件 |

### 零拷贝网络

```c
// Zero-copy send — 避免用户空间到内核空间的复制
sqe = io_uring_get_sqe(&ring);
io_uring_prep_send_zc(sqe, sock_fd, buf, len, 0, 0);
```

### 其他优化标志

| 标志 | 引入版本 | 作用 |
|------|---------|------|
| `IORING_SETUP_COOP_TASKRUN` | 5.19 | 协作式任务调度，减少不必要的 IPI |
| `IORING_SETUP_SINGLE_ISSUER` | 6.0 | 告知内核只有单线程提交，启用额外优化 |
| `IORING_SETUP_DEFER_TASKRUN` | 6.1 | 延迟完成处理到显式轮询时，更好的批处理效果 |

## Performance

### 网络场景

TCP echo server 基准测试（AMD EPYC 9474F, 100Gbps, 200K 并发连接）：

| 模型 | 吞吐量 | p50 延迟 | p99 延迟 |
|------|--------|---------|---------|
| epoll | 2.1M req/s (基线) | 110µs | 980µs |
| io_uring | 3.4M req/s (+62%) | 75µs | 520µs |
| io_uring + SQPOLL | 4.8M req/s (+129%) | 52µs | 240µs |

在 Rust/Zig 实现的 HTTP 测试中，io_uring 相比 epoll 在吞吐量上有 **~24% 的提升**，同时 p99 延迟更低。

### 存储场景

NVMe SSD 4K 随机读（fio 基准）：

| 配置 | 相对吞吐量 |
|------|-----------|
| sync read (基线) | ~1x |
| POSIX AIO | ~0.5x（线程池开销巨大） |
| linux-aio (O_DIRECT) | ~2x |
| io_uring (基础) | ~2x（+5% 优于 linux-aio） |
| io_uring + registered buffers/files | ~2.3x |
| io_uring + IOPOLL + SQPOLL | 可达 **>1M IOPS**（单线程饱和 PCIe 5.0 SSD） |

> **关键洞察**：io_uring 在纯存储场景的优势主要来自**消除阻塞风险**和**统一 API**，而非对 linux-aio 的绝对性能碾压（ScyllaDB 实际优化后仅测得 ~5% 提升）。真正拉开差距的场景是**混合 I/O**（文件+网络），这是 io_uring 独有能力。

### 系统调用开销对比

| 模型 | 每次 I/O 的平均系统调用 | 上下文切换 |
|------|------------------------|-----------|
| sync read/write | 1（每次 I/O） | 每次阻塞 |
| epoll | 2（epoll_wait + read/write） | 0（单纯内核穿越） |
| io_uring (默认) | 0–1（仅在队列空时需要 enter） | 0 |
| io_uring (SQPOLL) | **0** | **0** |

## Security Considerations

io_uring 的强大也带来了可观的攻击面：

- Google 2022 年 Bug Bounty 中，**60% 的内核漏洞利用**针对 io_uring。
- io_uring 可以绕过传统的系统调用监控工具（如 Falco、Tetragon），形成安全盲区。
- 已有安全团队展示了基于 io_uring 的 rootkit（如 ARMO 的 "Curing"）。
- Android、ChromeOS 及部分 Google 生产服务器 **默认禁用 io_uring** 或将其限制为受信代码。

**生产环境建议**：
- 使用 `IORING_SETUP_SINGLE_ISSUER` 或 `IORING_SETUP_ATTACH_WQ` 限制 io_uring 实例的权限域。
- 在容器环境中，通过 seccomp 或 `io_uring` cgroup 控制器限制使用。
- 保持内核版本更新——每个新版本都在修复 io_uring 相关漏洞。

## Reference

- [io_uring(7) — Linux manual page](https://www.man7.org/linux/man-pages/man7/io_uring.7.html)
- [Lord of the io_uring — Jens Axboe (Kernel Recipes 2022)](https://kernel.dk/axboe-kr2022.pdf)
- [liburing — Official userspace library](https://github.com/axboe/liburing)
- [Efficient IO with io_uring (PDF)](https://kernel.dk/io_uring.pdf)
- [io_uring Explained: The Future of Linux I/O Performance in 2026](https://dargslan.com/blog/io-uring-explained-future-linux-io-performance-2026)
- [Missing Manuals — io_uring worker pool](https://lwn.net/Articles/815491/)
- [An Introduction to the io_uring Asynchronous I/O Framework (Oracle)](https://blogs.oracle.com/linux/post/an-introduction-to-the-io_uring-asynchronous-io-framework)
