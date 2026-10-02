/**
 * Advisory lock keys shared by every RevenueDot process on one database (prd/ha-self-host/PRD.md): migrations and the
 * background job (apps/server/src/cluster.ts) take session locks, which need a direct connection, RDS Proxy or PgBouncer
 * in session mode, never PgBouncer in transaction mode. The benchmark aggregates rebuild (apps/server/src/services/
 * benchmarks.ts) takes a transaction lock, so one rebuild runs at a time. Shared with the Workers build (worker.ts).
 */
export const LOCK_KEYS = { migrate: 5_276_440_101, tick: 5_276_440_102, benchmarkAggregates: 5_276_440_103 } as const;
