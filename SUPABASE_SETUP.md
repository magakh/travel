# Supabase setup for the travel app

One-time setup. After this, all current and future trips use the same Supabase project.

**Time required:** about 20 minutes.

**What you'll end up with:**
- A free Supabase project hosting your trip data
- A cloud function that proxies AI search (so friends don't need their own Anthropic keys)
- Two config values you'll paste into the app's Settings

---

## Part 1 — Create the Supabase project

1. Go to https://supabase.com and click **Start your project**
2. Sign in with GitHub or email (no credit card needed)
3. Click **New project**. Fill in:
   - **Name:** `travel-apps`
   - **Database password:** generate a strong one and save it in your password manager
   - **Region:** closest to where your group lives
   - **Pricing plan:** Free
4. Click **Create new project** and wait ~2 minutes

---

## Part 2 — Create the database tables

1. Sidebar → **SQL Editor** → **+ New query**
2. Paste this entire block:

```sql
create table trips (
  id          text primary key,
  title       text not null,
  subtitle    text,
  config      jsonb not null default '{}'::jsonb,
  data        jsonb not null default '{"days":[],"completed":[],"hotel":null}'::jsonb,
  edit_password_hash text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create table changes (
  id         bigserial primary key,
  trip_id    text not null references trips(id) on delete cascade,
  actor      text,
  summary    text not null,
  created_at timestamptz not null default now()
);

create index changes_trip_id_created_at_idx
  on changes (trip_id, created_at desc);

create or replace function touch_updated_at()
returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end;
$$;

create trigger trips_touch_updated_at
  before update on trips
  for each row execute function touch_updated_at();

alter table trips enable row level security;
alter table changes enable row level security;

create policy "public read trips"   on trips   for select using (true);
create policy "public read changes" on changes for select using (true);
create policy "public insert trips"  on trips   for insert with check (true);
create policy "public update trips"  on trips   for update using (true) with check (true);
create policy "public insert changes" on changes for insert with check (true);

alter publication supabase_realtime add table trips;
```

3. Click **Run**. Expect "Success. No rows returned."

If you see `relation is already member of publication` on the last line, that's fine — Realtime was already watching the table.

---

## Part 3 — Copy your config values

1. Sidebar → **Project Settings** (gear icon) → **API**
2. Copy these two, keep them handy:
   - **Project URL** (looks like `https://abcdefgh.supabase.co`)
   - **anon / public key** (long string starting with `eyJ`)

**Don't copy the `service_role` key** — that one's a secret, never goes into browser code.

---

## Part 4 — Deploy the AI proxy (Edge Function)

This lets everyone in your group use AI search without each of them needing their own Anthropic key.

### 4a — Get an Anthropic API key

1. https://console.anthropic.com → sign up (new accounts get free credits)
2. **API Keys** → **Create Key**, copy the `sk-ant-...` value

### 4b — Store it as a Supabase secret

1. Sidebar → **Edge Functions** → **Manage secrets** (or **Add new secret**)
2. Name: `ANTHROPIC_API_KEY`
3. Value: paste your `sk-ant-...` key
4. Save

### 4c — Create the Edge Function

1. **Edge Functions** → **Deploy a new function**
2. Name: `ai-proxy`
3. Paste this entire block into the code editor:

```typescript
const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY");
const RATE_LIMIT_PER_HOUR = 60;
const rateLimitMap = new Map<string, { count: number; resetAt: number }>();

function checkRateLimit(ip: string): boolean {
  const now = Date.now();
  const e = rateLimitMap.get(ip);
  if (!e || now > e.resetAt) {
    rateLimitMap.set(ip, { count: 1, resetAt: now + 3600_000 });
    return true;
  }
  if (e.count >= RATE_LIMIT_PER_HOUR) return false;
  e.count++;
  return true;
}

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type, x-client-info, apikey",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST")
    return new Response("Method not allowed", { status: 405, headers: CORS });
  if (!ANTHROPIC_API_KEY)
    return new Response(JSON.stringify({ error: "Server not configured" }),
      { status: 500, headers: { ...CORS, "Content-Type": "application/json" } });

  const ip = req.headers.get("x-forwarded-for")?.split(",")[0].trim() ?? "unknown";
  if (!checkRateLimit(ip))
    return new Response(JSON.stringify({ error: "Rate limit exceeded" }),
      { status: 429, headers: { ...CORS, "Content-Type": "application/json" } });

  let body: any;
  try { body = await req.json(); }
  catch { return new Response("Bad JSON", { status: 400, headers: CORS }); }

  try {
    const resp = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: body.model ?? "claude-sonnet-4-5",
        max_tokens: Math.min(body.max_tokens ?? 1500, 2000),
        messages: body.messages ?? [],
      }),
    });
    const txt = await resp.text();
    return new Response(txt, {
      status: resp.status,
      headers: { ...CORS, "Content-Type": "application/json" },
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: "Upstream error: " + String(e) }),
      { status: 502, headers: { ...CORS, "Content-Type": "application/json" } });
  }
});
```

4. Click **Deploy**. Wait for the green check.

The function URL will be `https://<your-project>.supabase.co/functions/v1/ai-proxy`. The app constructs this automatically from your project URL — you don't need to copy it.

---

## Part 5 — Paste config into the app

1. Open `https://magakh.github.io/travel/Trip.html`
2. Tap ⚙ **Settings**
3. Scroll to the **Supabase** section
4. Paste:
   - **Supabase URL** (from Part 3)
   - **Supabase anon key** (from Part 3)
5. Tap **Save Settings**

The app reloads. On first load, it detects no `london2026` trip exists in Supabase yet and offers to **import** from `sync_london2026.json`. Accept — it migrates your data.

---

## Part 6 — Set a password for the London trip

1. Tap the 🔒 in the top-right
2. Enter a password (8+ chars — share this with your group)
3. Tap **Set & unlock**

You're now in editor mode. Share the URL + password with your group.

---

## Part 7 — Add a new trip

1. Tap ⚙ **Settings** → **Trips** → **+ New trip**
2. Slug (e.g., `tokyo2027`), title, number of days
3. Save
4. Share the URL: `https://magakh.github.io/travel/Trip.html?trip=tokyo2027`
5. Set a password for the new trip via 🔒 (can be different from London's)

---

## Group share message template

> Our **London** trip planner — live collaborative.
> Link: `https://magakh.github.io/travel/Trip.html?trip=london2026`
> Password to edit: `(whatever you set)`
> Everyone can view. Tap 🔒 to edit. Changes sync instantly.

---

## Troubleshooting

**"Failed to load trip":** Check your Supabase URL and anon key in Settings.

**"Password doesn't work":** Reset it from Supabase dashboard → Table Editor → `trips` → edit row → set `edit_password_hash` to null → reopen app and set a new password.

**AI search: "Rate limit exceeded":** 60 calls per hour per IP. Wait an hour or raise the limit in the Edge Function code.

**Edits not syncing live:** Make sure the `alter publication supabase_realtime add table trips;` line from Part 2 ran. Re-run it — it's idempotent.

**Mobile shows old data:** Settings → Danger zone → Reset all data. Clears the device's local cache.

---

## Free tier limits (reference)

- 500 MB database (thousands of trips)
- 2 GB egress/month (plenty)
- 500K Edge Function invocations/month
- 200 concurrent realtime connections
- Projects pause after 1 week of no activity, un-pause automatically on next request

No credit card needed. For a group travel planner you'll never hit any limit.
