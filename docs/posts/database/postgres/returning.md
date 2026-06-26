# Returning

## What's this

`RETURNING` is a PostgreSQL-specific DML clause (available on `INSERT`, `UPDATE`, `DELETE`, and `MERGE`) that returns data from modified rows **in the same query**. It eliminates the need for a follow-up `SELECT` — one round-trip instead of two — and is especially useful when relying on server-computed values (defaults, serials, triggers) that you'd otherwise have to query back manually.

Key benefits:

- **Fewer round-trips** to the database.
- **Atomic readback** — the returned row reflects triggers, defaults, and the actual committed state.
- **Cleaner application code** — no separate fetch logic for generated IDs or computed columns.

## How to Use

The `RETURNING` clause accepts the same output expressions as `SELECT`: column names, `*`, expressions, and (since PostgreSQL 18) explicit `OLD` / `NEW` references.

### INSERT

Most commonly used to retrieve auto-generated IDs and server-side defaults:

```sql
INSERT INTO users (firstname, lastname)
VALUES ('Joe', 'Cool')
RETURNING id, created_at;
```

Also works with `INSERT ... SELECT` for bulk operations:

```sql
INSERT INTO archived_orders (order_id, customer_id, total)
SELECT id, customer_id, total
FROM orders
WHERE status = 'archived'
RETURNING order_id, archived_at;
```

### UPDATE

Returns the **new** (post-update) state of each modified row:

```sql
UPDATE products
SET price = price * 1.10
WHERE price <= 99.99
RETURNING name, price AS new_price;
```

Since PostgreSQL 18, you can also reference the **old** row for before/after comparisons:

```sql
UPDATE products
SET price = price * 1.10
WHERE price <= 99.99
RETURNING name,
    OLD.price AS old_price,
    NEW.price AS new_price,
    NEW.price - OLD.price AS price_change;
```

### DELETE

Returns the row **as it was before deletion** — ideal for audit logging and archival patterns:

```sql
DELETE FROM sessions
WHERE expires_at < now()
RETURNING id, user_id, created_at;
```

Combine with a CTE to archive deleted rows atomically:

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

### MERGE

Returns the source row plus the inserted, updated, or deleted target row. Since source and target often share column names, qualify with the table alias to avoid ambiguity:

```sql
MERGE INTO products p
USING new_products n ON p.product_no = n.product_no
WHEN NOT MATCHED THEN
    INSERT (product_no, name, price) VALUES (n.product_no, n.name, n.price)
WHEN MATCHED THEN
    UPDATE SET name = n.name, price = n.price
RETURNING p.*;
```

### ON CONFLICT (Upsert) — Detecting Insert vs. Update

A common pattern is knowing whether an upsert inserted a new row or updated an existing one. Before PostgreSQL 18 this relied on the internal `xmax` column; PG 18 makes it clean with `OLD`/`NEW` references:

*Pre‑PG 18 (fragile, relies on internals):*
```sql
INSERT INTO webhook (id, data)
VALUES ($1, $2)
ON CONFLICT (id) DO UPDATE SET id = webhook.id
RETURNING webhook.*, (xmax = 0) AS is_new;
```

*PG 18+ (clean, part of the API):*
```sql
INSERT INTO webhook (id, data)
VALUES ($1, $2)
ON CONFLICT (id) DO UPDATE SET id = webhook.id
RETURNING webhook.*, (OLD IS NULL)::boolean AS is_new;
```

When a row is inserted, `OLD` is `NULL`; when an existing row is updated, `OLD` contains the pre-update values.

### Trigger Interaction

If `BEFORE` / `AFTER` triggers modify the row, `RETURNING` yields the **final** row state after all triggers have fired. This makes it a natural way to inspect trigger-computed columns (e.g., `updated_at` set by a `BEFORE UPDATE` trigger).

### Performance Notes

- `RETURNING` adds minimal overhead — the row data is already in memory after the DML.
- Like `SELECT`, `RETURNING` does **not** guarantee row order. Add an explicit `ORDER BY` if you need sorted results.
- Prefer listing specific columns over `RETURNING *` in production to reduce data transfer and avoid breakage from schema changes.

## Reference

- [PostgreSQL Docs — Returning Data from Modified Rows](https://www.postgresql.org/docs/current/dml-returning.html)
- [RETURNING in PostgreSQL (GeeksforGeeks)](https://www.geeksforgeeks.org/postgresql/returning-in-postgresql/)
- [Postgres 18: OLD and NEW Rows in the RETURNING Clause (Crunchy Data Blog)](https://www.crunchydata.com/blog/postgres-18-old-and-new-in-the-returning-clause)
- [PostgreSQL Wiki — UPSERT](https://wiki.postgresql.org/wiki/UPSERT)
