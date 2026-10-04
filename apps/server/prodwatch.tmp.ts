// Read-only production check: secret layout (names only) and SuperScan's notifications. No values printed.
import postgres from "../../packages/db/node_modules/postgres/src/index.js";
const s = postgres(process.env.CLOUD_DATABASE_URL!, { max: 1, connection: { default_transaction_read_only: true } as never });
const apps = await s`select a.id, a.type,
  array(select k from jsonb_object_keys(a.credentials) k where k = any(array['subscription_private_key','private_key','app_store_connect_api_key','shared_secret','play_service_account_credentials_json','service_account'])) as plain,
  coalesce(split_part(a.secrets, ':', 1), '-') as fmt, array(select jsonb_object_keys(a.secret_hints)) as hinted,
  a.credentials_status as status, a.last_notification_at as last
  from apps a where a.id in ('appc1fvs5wg','app23wjl8cb','appe8dyp6dl')`;
for (const r of apps) console.log(JSON.stringify(r));
const since = process.argv[2] ?? new Date(Date.now() - 3600_000).toISOString();
const n = await s`select count(*)::int as total, count(*) filter (where error is not null)::int as errors, count(*) filter (where processed_at is null and error is null)::int as unprocessed, max(created_at) as last
  from store_notifications where app_id = 'appc1fvs5wg' and created_at >= ${since}`;
console.log("superscan notifications since", since, JSON.stringify(n[0]));
const errs = await s`select left(error, 160) as error, created_at from store_notifications where app_id = 'appc1fvs5wg' and created_at >= ${since} and error is not null order by created_at desc limit 5`;
for (const e of errs) console.log("error:", JSON.stringify(e));
await s.end();
