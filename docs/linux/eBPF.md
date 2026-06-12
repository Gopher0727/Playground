# eBPF

## 核心价值

eBPF（Extended Berkeley Packet Filter）可以在内核运行时动态插入观测逻辑，获得细粒度运行数据且无需修改应用代码。

最初是网络过滤器，Linux 内核扩展其为内核虚拟机，允许加载一段特殊程序，但是这段程序在内核中执行，不能死循环、不能随便访问内存、不能导致内核崩溃。因此，Linux 引入了 Verifier，加载前 `eBPF Program -> Verifier -> JIT编译 -> Kernel`。

eBPF 不是主动运行，而是类似于事件监听器，负责采集数据。