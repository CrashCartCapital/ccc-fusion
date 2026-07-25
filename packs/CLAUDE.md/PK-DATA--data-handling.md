# Data handling

Pack ID: `PK-DATA`.

Read this generated pack only after the compact root catalog identifies a strong trigger.

### Data Handling

- For analytics, market-data, backtesting, or data-pipeline work, prefer the project-local data stack first.
- When no project-specific data stack is declared, default to DuckDB for analytics queries, Parquet for columnar persistence, and Polars for DataFrame operations.
- Prefer lazy evaluation and streaming over loading full datasets into memory.
- For market data imports: use the runtime-injected finance or market-data skill when present; otherwise use the project-declared data source/API and record source, freshness, and licensing constraints instead of ad-hoc scraping.
- Data validation: assert shape, dtypes, and NaN/null counts before analytical operations on unfamiliar or freshly loaded data.
- Time series: always be explicit about timezone. Default US/Eastern for market data display, UTC for storage and computation.
- File formats: Parquet for columnar analytics, CSV only for human inspection or cross-tool interop.
- When writing data pipeline code: make the source → transform → sink stages explicit and independently testable.

> **Extension point:** Project-specific data conventions, storage paths, or schema constraints go here.
