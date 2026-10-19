import assert from "node:assert/strict";
import test from "node:test";

import { COMPOSIO_API, COMPOSIO_USER_ID, CURATED_APPS, createComposioClient, disconnectedApps } from "../connections.mjs";

/** A fake fetch that answers from `routes` ("METHOD /path" → payload | [status, payload]) and records every call. */
function fakeFetch(routes) {
  const calls = [];
  const fetch = async (url, init = {}) => {
    const parsed = new URL(url);
    const method = init.method ?? "GET";
    calls.push({ method, path: parsed.pathname.replace("/api/v3.1", ""), params: parsed.searchParams, headers: init.headers, body: init.body ? JSON.parse(init.body) : undefined });
    const route = routes[`${method} ${parsed.pathname.replace("/api/v3.1", "")}`];
    if (route === undefined) return new Response(JSON.stringify({ error: { message: "no route" } }), { status: 404 });
    if (route instanceof Error) throw route;
    const [status, payload] = Array.isArray(route) ? route : [200, route];
    return new Response(JSON.stringify(payload), { status });
  };
  return { fetch, calls };
}

const account = (slug, status, id = `ca_${slug}_${status}`) => ({ id, status, toolkit: { slug } });

test("lists the curated apps in order with their connection state", async () => {
  const { fetch, calls } = fakeFetch({
    "GET /connected_accounts": {
      items: [account("gmail", "INITIATED"), account("gmail", "ACTIVE"), account("slack", "EXPIRED"), account("hubspot", "ACTIVE")],
    },
  });
  const apps = await createComposioClient({ apiKey: "ck_secret", fetch }).listApps();
  assert.deepEqual(apps.map((app) => app.slug), ["gmail", "googlecalendar", "slack", "twitter", "github", "notion", "googledrive", "linkedin"]);
  assert.equal(apps.find((app) => app.slug === "twitter").name, "X");
  assert.deepEqual(apps[0], { slug: "gmail", name: "Gmail", connected: true, status: "connected" }, "an abandoned sign-in never hides a working one");
  assert.deepEqual(apps[2], { slug: "slack", name: "Slack", connected: false, status: "expired" });
  assert.equal(apps[1].status, "not connected");
  assert.equal(calls[0].method, "GET");
  assert.equal(calls[0].headers["x-api-key"], "ck_secret");
  assert.equal(calls[0].params.get("user_ids"), COMPOSIO_USER_ID);
  assert.equal(calls[0].params.get("toolkit_slugs"), CURATED_APPS.map((app) => app.slug).join(","));
});

test("connect reuses an enabled auth config, preferring the user's own, and returns the Connect Link", async () => {
  const { fetch, calls } = fakeFetch({
    "GET /auth_configs": {
      items: [
        { id: "ac_managed", status: "ENABLED", is_composio_managed: true, toolkit: { slug: "gmail" } },
        { id: "ac_off", status: "DISABLED", is_composio_managed: false, toolkit: { slug: "gmail" } },
        { id: "ac_mine", status: "ENABLED", is_composio_managed: false, toolkit: { slug: "gmail" } },
      ],
    },
    "POST /connected_accounts/link": [201, { redirect_url: "https://connect.composio.dev/link/ln_1", connected_account_id: "ca_1" }],
  });
  const result = await createComposioClient({ apiKey: "ck", fetch }).connect("gmail");
  assert.deepEqual(result, { url: "https://connect.composio.dev/link/ln_1" });
  assert.equal(calls[0].params.get("toolkit_slug"), "gmail");
  assert.deepEqual(calls[1].body, { auth_config_id: "ac_mine", user_id: COMPOSIO_USER_ID });
  assert.equal(calls.some((call) => call.method === "POST" && call.path === "/auth_configs"), false);
});

test("connect creates a Composio-managed auth config when the toolkit has none", async () => {
  const { fetch, calls } = fakeFetch({
    "GET /auth_configs": { items: [] },
    "POST /auth_configs": [201, { toolkit: { slug: "slack" }, auth_config: { id: "ac_new", is_composio_managed: true } }],
    "POST /connected_accounts/link": [201, { redirect_url: "https://connect.composio.dev/link/ln_2" }],
  });
  await createComposioClient({ apiKey: "ck", fetch }).connect("slack");
  const create = calls.find((call) => call.method === "POST" && call.path === "/auth_configs");
  assert.equal(create.body.toolkit.slug, "slack");
  assert.equal(create.body.auth_config.type, "use_composio_managed_auth");
  assert.equal(calls.at(-1).body.auth_config_id, "ac_new");
});

test("X without the user's own credentials explains what to do instead of calling Composio", async () => {
  const { fetch, calls } = fakeFetch({ "GET /auth_configs": { items: [] } });
  await assert.rejects(createComposioClient({ apiKey: "ck", fetch }).connect("twitter"), /X has no Composio-managed sign-in.*own X developer app/);
  assert.equal(calls.length, 1);
  assert.match(disconnectedApps().find((app) => app.slug === "twitter").hint, /signed-in browser/);
});

test("a toolkit Composio cannot manage reports that it needs custom credentials", async () => {
  const { fetch } = fakeFetch({
    "GET /auth_configs": { items: [] },
    "POST /auth_configs": [400, { error: { message: "Managed auth is not available for this toolkit", code: 1, slug: "x", status: 400 } }],
  });
  await assert.rejects(createComposioClient({ apiKey: "ck", fetch }).connect("linkedin"), /LinkedIn has no Composio-managed sign-in.*Managed auth is not available/);
});

test("connect refuses apps outside the curated list and non-https links", async () => {
  const { fetch, calls } = fakeFetch({
    "GET /auth_configs": { items: [{ id: "ac", status: "ENABLED", toolkit: { slug: "github" } }] },
    "POST /connected_accounts/link": [201, { redirect_url: "javascript:alert(1)" }],
  });
  const client = createComposioClient({ apiKey: "ck", fetch });
  await assert.rejects(client.connect("../toolkits"), /not one Jarvis can connect/);
  assert.equal(calls.length, 0);
  await assert.rejects(client.connect("github"), /did not return a sign-in link/);
});

test("disconnect deletes every connection for that app, and only that app", async () => {
  const { fetch, calls } = fakeFetch({
    "GET /connected_accounts": { items: [account("notion", "ACTIVE", "ca_a"), account("notion", "INITIATED", "ca_b"), account("gmail", "ACTIVE", "ca_c")] },
    "DELETE /connected_accounts/ca_a": { success: true },
    "DELETE /connected_accounts/ca_b": { success: true },
  });
  await createComposioClient({ apiKey: "ck", fetch }).disconnect("notion");
  assert.equal(calls[0].params.get("toolkit_slugs"), "notion");
  assert.deepEqual(calls.filter((call) => call.method === "DELETE").map((call) => call.path), ["/connected_accounts/ca_a", "/connected_accounts/ca_b"]);
});

test("errors are clear: missing key, rejected key, unreachable, upstream message", async () => {
  assert.throws(() => createComposioClient({ apiKey: " ", fetch: async () => {} }), /Add your Composio API key/);
  const rejected = fakeFetch({ "GET /connected_accounts": [401, { error: { message: "Invalid API key" } }] });
  await assert.rejects(createComposioClient({ apiKey: "bad", fetch: rejected.fetch }).listApps(), /rejected the API key/);
  const offline = fakeFetch({ "GET /connected_accounts": new TypeError("fetch failed") });
  await assert.rejects(createComposioClient({ apiKey: "ck", fetch: offline.fetch }).listApps(), /Could not reach Composio \(fetch failed\)/);
  const broken = fakeFetch({ "GET /connected_accounts": [500, { error: { message: "Database down", suggested_fix: "Retry later." } }] });
  await assert.rejects(createComposioClient({ apiKey: "ck", fetch: broken.fetch }).listApps(), /Database down Retry later\./);
});

test("the default base is Composio's v3.1 REST API", () => {
  assert.equal(COMPOSIO_API, "https://backend.composio.dev/api/v3.1");
});
