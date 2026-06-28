# RETURNING

## What's this

`RETURNING` 是 SQL 标准的 DML 子句，由 PostgreSQL 最早实现并推广，可在 `INSERT`、`UPDATE`、`DELETE` 和 `MERGE` 中**在同一个查询里**返回被修改行的数据。它消除了"先写再查"的两次往返，一次查询即可拿到结果，尤其适合依赖服务端计算值（默认值、序列、触发器）的场景——这些值原本需要额外查询才能取回。

- **减少数据库往返**：一次查询替代"写入 + 查询"两次交互。
- **原子读回**：返回的数据反映触发器、默认值和实际提交后的最终状态。
- **代码更简洁**：无需为获取生成 ID 或计算列再写一遍查询逻辑。

## How to Use

`RETURNING` 子句接受与 `SELECT` 相同的输出表达式：列名、`*`、表达式，以及（PostgreSQL 18 起）显式的 `OLD` / `NEW` 引用。

### INSERT

最常用于获取自增 ID 和服务端默认值：

```sql
INSERT INTO users (firstname, lastname)
VALUES ('Joe', 'Cool')
RETURNING id, created_at;
```

也支持 `INSERT ... SELECT` 批量操作：

```sql
INSERT INTO archived_orders (order_id, customer_id, total)
SELECT id, customer_id, total
FROM orders
WHERE status = 'archived'
RETURNING order_id, archived_at;
```

### UPDATE

返回**更新后**的每行数据：

```sql
UPDATE products
SET price = price * 1.10
WHERE price <= 99.99
RETURNING name, price AS new_price;
```

**PostgreSQL 18+：`OLD` / `NEW` 引用**

PG 18 引入 `OLD` 和 `NEW` 关键字，可在 `RETURNING` 中同时引用更新前后的行数据，实现一次查询拿到完整的变化对比：

```sql
UPDATE products
SET price = price * 1.10
WHERE price <= 99.99
RETURNING name,
    OLD.price AS old_price,
    NEW.price AS new_price,
    NEW.price - OLD.price AS price_change;
```

| 关键字 | 含义       | UPDATE 中  | DELETE 中  | INSERT 中  |
| ------ | ---------- | ---------- | ---------- | ---------- |
| `NEW`  | 操作后的行 | 更新后的值 | `NULL`     | 插入的新行 |
| `OLD`  | 操作前的行 | 更新前的值 | 被删除的行 | `NULL`     |

典型场景：

```sql
-- 审计：记录字段变更
UPDATE accounts
SET balance = balance - 100
WHERE id = $1
RETURNING id,
    OLD.balance AS before,
    NEW.balance AS after,
    NEW.balance - OLD.balance AS delta;

-- 乐观锁：返回新旧版本号，应用层可检测并发冲突
UPDATE documents
SET content = $2, version = version + 1
WHERE id = $1
RETURNING OLD.version AS old_version, NEW.version AS new_version;

-- 条件判断：区分 INSERT 和 UPDATE（ON CONFLICT）
INSERT INTO webhook (id, data)
VALUES ($1, $2)
ON CONFLICT (id) DO UPDATE SET id = webhook.id
RETURNING webhook.*, (OLD IS NULL)::boolean AS is_new;
```

### DELETE

返回**删除前**的行数据——适合审计日志和归档模式：

```sql
DELETE FROM sessions
WHERE expires_at < now()
RETURNING id, user_id, created_at;
```

PG 18 起，DELETE 中 `OLD` 即被删除的行，`NEW` 为 `NULL`：

```sql
DELETE FROM users
WHERE id = $1
RETURNING OLD.id, OLD.name, OLD.email;
-- 等价于 RETURNING id, name, email，但 OLD 显式表达了"旧行"语义
```

配合 CTE 实现原子归档：

```sql
WITH deleted AS (
    DELETE FROM orders
    WHERE status = 'cancelled' AND updated_at < now() - INTERVAL '30 days'
    RETURNING *
)
INSERT INTO orders_archive (id, customer_id, total, status, deleted_at)
SELECT id, customer_id, total, status, now()
FROM deleted;
```

### MERGE（PostgreSQL 15+）

返回源行以及被插入、更新或删除的目标行。由于源和目标常有同名列，用表别名限定以避免歧义：

```sql
MERGE INTO products p
USING new_products n ON p.product_no = n.product_no
WHEN NOT MATCHED THEN
    INSERT (product_no, name, price) VALUES (n.product_no, n.name, n.price)
WHEN MATCHED THEN
    UPDATE SET name = n.name, price = n.price
RETURNING p.*;
```

### ON CONFLICT / Upsert（PostgreSQL 9.5+）

一个常见需求是判断 upsert 究竟插入了一行新数据还是更新了已有行。PostgreSQL 18 之前需要依赖内部的 `xmax` 列；PG 18 用 `OLD`/`NEW` 使其变得干净：

*PG 18 之前（依赖内部实现，脆弱）：*
```sql
INSERT INTO webhook (id, data)
VALUES ($1, $2)
ON CONFLICT (id) DO UPDATE SET id = webhook.id
RETURNING webhook.*, (xmax = 0) AS is_new;
```

*PG 18+（API 层面支持，干净）：*
```sql
INSERT INTO webhook (id, data)
VALUES ($1, $2)
ON CONFLICT (id) DO UPDATE SET id = webhook.id
RETURNING webhook.*, (OLD IS NULL)::boolean AS is_new;
```

插入新行时 `OLD` 为 `NULL`；更新已有行时 `OLD` 包含更新前的值。

### 触发器交互

如果 `BEFORE` / `AFTER` 触发器修改了行数据，`RETURNING` 返回的是**所有触发器执行完毕后**的最终行状态。这使其成为检查触发器计算列（如 `BEFORE UPDATE` 触发器设置的 `updated_at`）的自然方式。

### 性能说明

- `RETURNING` 几乎零额外开销——行数据在 DML 执行后本来就在内存中。
- 与 `SELECT` 一样，`RETURNING` **不保证**返回行的顺序。如需有序结果，显式加 `ORDER BY`。
- 生产环境建议列出具体列名而非 `RETURNING *`，以减少数据传输并避免表结构变更带来的破坏。

## GORM 中使用 RETURNING

GORM 的 PostgreSQL 驱动已注册 `RETURNING` 到 Create / Update / Delete 子句列表中。但 **`Scan` 方法会重新执行一次 SQL**，而非复用回调已返回的结果，因此需要区分场景选择正确用法。

### 查询次数分析

GORM 的 `Scan` → `Rows()` → `RowQuery` 调用链中，`RowQuery` 会拿着 `Statement.SQL` **重新执行一次 `QueryContext`**，不会缓存上次的结果：

```go
// callbacks/row.go
func RowQuery(db *gorm.DB) {
    if isRows, ok := db.Get("rows"); ok && isRows.(bool) {
        db.Statement.Dest, db.Error = db.Statement.ConnPool.QueryContext(
            db.Statement.Context, db.Statement.SQL.String(), db.Statement.Vars...)
    }
}
```

这意味着不同组合的实际查询次数不同：

| 操作   | 写法                                           | 查询次数 | 原因                                  |
| ------ | ---------------------------------------------- | -------- | ------------------------------------- |
| INSERT | `Clauses(Returning{}).Create(&u)`              | **1**    | Create 回调直接回填 struct，无需 Scan |
| UPDATE | `Clauses(Returning{}).Model().Update().Scan()` | 2        | 回调先执行一次，Scan 再执行一次       |
| DELETE | `Clauses(Returning{}).Delete().Scan()`         | 2        | 回调删除后，Scan 再执行时行已不存在   |
| INSERT | `Raw("INSERT ... RETURNING *").Scan(&u)`       | **1**    | Raw 不触发回调，仅 Scan 执行一次      |
| UPDATE | `Raw("UPDATE ... RETURNING *").Scan(&u)`       | **1**    | 同上                                  |
| DELETE | `Raw("DELETE ... RETURNING *").Scan(&u)`       | **1**    | 同上                                  |

### 正确用法：INSERT 用 Clauses，UPDATE/DELETE 用 Raw

```go
package main

import (
    "fmt"

    "gorm.io/driver/postgres"
    "gorm.io/gorm"
    "gorm.io/gorm/clause"
)

type User struct {
    ID    uint `gorm:"primaryKey"`
    Name  string
    Email string
    Age   int
}

func main() {
    dsn := "host=localhost user=gopher password=1900271083 dbname=test port=5432 sslmode=disable TimeZone=Asia/Shanghai"
    db, err := gorm.Open(postgres.Open(dsn), &gorm.Config{})
    if err != nil {
        panic(fmt.Errorf("数据库连接失败: %w", err))
    }
    db.AutoMigrate(&User{})

    // INSERT + RETURNING: 1 次查询
    // Create 回调检测到 RETURNING 子句，执行 QueryContext 后直接回填 struct
    u := User{Name: "Test", Email: "test@test.com", Age: 18}
    db.Clauses(clause.Returning{}).Create(&u)
    fmt.Printf("INSERT: %+v\n", u)
    // 输出: INSERT: {ID:1 Name:Test Email:test@test.com Age:18}

    // UPDATE + RETURNING: 1 次查询（用 Raw 避免回调重复执行）
    var updated User
    db.Raw("UPDATE users SET age = ? WHERE id = ? RETURNING *", 30, u.ID).Scan(&updated)
    fmt.Printf("UPDATE: %+v\n", updated)
    // 输出: UPDATE: {ID:1 Name:Test Email:test@test.com Age:30}

    // DELETE + RETURNING: 1 次查询
    var deleted User
    db.Raw("DELETE FROM users WHERE id = ? RETURNING *", u.ID).Scan(&deleted)
    fmt.Printf("DELETE: %+v\n", deleted)
    // 输出: DELETE: {ID:1 Name:Test Email:test@test.com Age:30}
}
```

### 指定返回列

`clause.Returning` 的 `Columns` 字段可以精确控制返回哪些列，减少数据传输：

```go
// 只返回 id 和 name
db.Clauses(clause.Returning{
    Columns: []clause.Column{{Name: "id"}, {Name: "name"}},
}).Create(&user)
```

不指定 `Columns`（即 `clause.Returning{}`）等价于 `RETURNING *`。

### 源码依据

GORM 的 Create / Update / Delete 回调均通过 `hasReturning` 函数判断是否使用 RETURNING：

```go
// callbacks/helper.go
func hasReturning(tx *gorm.DB, supportReturning bool) (bool, gorm.ScanMode) {
    if supportReturning {
        if c, ok := tx.Statement.Clauses["RETURNING"]; ok {
            returning, _ := c.Expression.(clause.Returning)
            if len(returning.Columns) == 0 || (len(returning.Columns) == 1 && returning.Columns[0].Name == "*") {
                return true, gorm.ScanAll
            }
            return true, gorm.ScanUpdate
        }
    }
    return false, gorm.ScanAll
}
```

- `ScanAll` 模式：扫描全部列到 struct
- `ScanUpdate` 模式：仅扫描 RETURNING 指定的列

PostgreSQL 驱动在注册时将 `"RETURNING"` 加入全部三个子句列表（`postgres.go:80-86`）：

```go
CreateClauses: []string{"INSERT", "VALUES", "ON CONFLICT", "RETURNING"}
UpdateClauses: []string{"UPDATE", "SET", "WHERE", "RETURNING"}
DeleteClauses: []string{"DELETE", "FROM", "WHERE", "RETURNING"}
```

### 为什么不用 Clauses 做 UPDATE/DELETE？

以 DELETE 为例，回调执行链路：

```
db.Clauses(Returning{}).Delete(&u).Scan(&dest)
        │                                        │
        ▼                                        ▼
  Delete 回调执行                          Scan → Rows() →
  QueryContext(DELETE RETURNING)           RowQuery 重新执行
  读取行并关闭                               QueryContext
  行已删除                                   DELETE 再次执行
                                             行不存在，返回空
```

UPDATE 同理，只是 UPDATE 是幂等操作，第二次执行仍能找到行并返回数据，所以表面上"能用"，实际上是两次查询。只有 `Raw` 写法能跳过回调，确保一次查询。

### 各数据库驱动支持情况

`RETURNING` 并非 PostgreSQL 专属，但目前也并非所有数据库都支持。GORM 各驱动的注册情况如下：

| 驱动               | RETURNING 支持     | 注册方式                                           |
| ------------------ | ------------------ | -------------------------------------------------- |
| **PostgreSQL**     | ✅ 所有版本（8.2+） | 启动时直接注册到 Create / Update / Delete 子句列表 |
| **MariaDB**        | ✅ 10.5+            | 连接时通过 `SELECT VERSION()` 检测，≥10.5 则注册   |
| **SQLite**         | ✅ 3.35.0+          | 启动时直接注册                                     |
| **MySQL** (Oracle) | ❌ 不支持           | 不注册                                             |
| **SQL Server**     | ❌ 不支持           | 不注册（SQL Server 使用 `OUTPUT` 子句替代）        |

> **注意**：驱动注册了 `RETURNING` 意味着 `clause.Returning{}` 可用（`RETURNING *` / `RETURNING col1, col2`）。文档前文提到的 `OLD`/`NEW`、`MERGE ... RETURNING` 等高级特性有独立的版本要求，与 `clause.Returning` 无关：
>
> | 特性 | PostgreSQL | MariaDB | SQLite |
> |------|-----------|---------|--------|
> | 基础 `RETURNING` | 8.2+ | 10.5+ | 3.35.0+ |
> | `ON CONFLICT ... RETURNING` | 9.5+ | 10.5+ (upsert) | 3.35.0+ |
> | `MERGE ... RETURNING` | 15+ | ❌ 不支持 | ❌ 不支持 |
> | `OLD` / `NEW` 引用 | 18+ | ❌ 不支持 | ❌ 不支持 |

**MariaDB 的版本检测逻辑**（`mysql.go:135-140`）：

```go
if strings.Contains(dialector.ServerVersion, "MariaDB") {
    withReturning = checkVersion(dialector.ServerVersion, "10.5")
}
```

MariaDB 10.5（2020 年 6 月发布）引入了 `RETURNING` 语法，GORM 仅在检测到 MariaDB 且版本 ≥10.5 时才注册。标准 MySQL（Oracle 版本）永远不会注册。

**不同写法的跨数据库行为**：

| 写法                     | 支持 RETURNING 的驱动                    | 不支持的驱动                            |
| ------------------------ | ---------------------------------------- | --------------------------------------- |
| `Clauses(Returning{})`   | 生成 `... RETURNING *`，一次查询返回数据 | **静默忽略**，走普通路径，等于没写      |
| `Raw("... RETURNING *")` | 一次查询返回数据                         | **直接报错** `ERROR 1064: syntax error` |

> **跨数据库兼容建议**：如果代码需要同时支持 MySQL 和 PostgreSQL，用 `Clauses` 相对安全——在不支持的数据库上它只是不生效，不会炸。但这也意味着 MySQL 上拿不到 RETURNING 的便利，必须接受"先写再查"的两次往返。`Raw` 语法严格绑定数据库，切换数据库必炸。

**SQL Server 的替代方案**：

SQL Server 不支持 `RETURNING`，而是使用 `OUTPUT` 子句实现类似功能。但 GORM 的 SQL Server 驱动未将 `OUTPUT` 集成到 `clause.Returning` 机制中，需要使用 Raw SQL：

```sql
-- SQL Server 的 OUTPUT 写法
INSERT INTO users (name, email)
OUTPUT INSERTED.id, INSERTED.name
VALUES ('Alice', 'alice@example.com');

DELETE FROM users
OUTPUT DELETED.id, DELETED.name
WHERE id = 1;
```

## Reference

- [PostgreSQL Docs — Returning Data from Modified Rows](https://www.postgresql.org/docs/current/dml-returning.html)
- [RETURNING in PostgreSQL (GeeksforGeeks)](https://www.geeksforgeeks.org/postgresql/returning-in-postgresql/)
- [Postgres 18: OLD and NEW Rows in the RETURNING Clause (Crunchy Data Blog)](https://www.crunchydata.com/blog/postgres-18-old-and-new-in-the-returning-clause)
- [PostgreSQL Wiki — UPSERT](https://wiki.postgresql.org/wiki/UPSERT)
- [GORM — PostgreSQL Driver](https://github.com/go-gorm/postgres)
