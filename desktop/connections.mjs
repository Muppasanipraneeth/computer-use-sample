/**
 * Gmail, Slack, X and other apps connected through Composio, for the single Jarvis user on this computer.
 *
 * Plain REST (Composio API v3.1, https://docs.composio.dev/reference) so the app carries no SDK. Every request sends the
 * project key in `x-api-key`; the key stays in the main process and never reaches the renderer.
 *   GET    /connected_accounts?user_ids=…&toolkit_slugs=…   list a user's connections and their status
 *   GET    /auth_configs?toolkit_slug=…                      find an existing auth config for a toolkit
 *   POST   /auth_configs                                     create one with Composio-managed OAuth
 *   POST   /connected_accounts/link                          create a Connect Link (hosted sign-in page)
 *   DELETE /connected_accounts/{id}                          remove a connection
 */

export const COMPOSIO_API = "https://backend.composio.dev/api/v3.1";
// Jarvis acts for one person, so every connection lives under one fixed Composio user id. The runner's gateway
// (python-app/app/apps_gateway.py) executes tools as this same user.
export const COMPOSIO_USER_ID = "jarvis-local";
export const COMPOSIO_DASHBOARD = "https://platform.composio.dev";

export const CURATED_APPS = Object.freeze([
  { slug: "gmail", name: "Gmail" },
  { slug: "googlecalendar", name: "Google Calendar" },
  { slug: "slack", name: "Slack" },
  { slug: "twitter", name: "X" },
  { slug: "github", name: "GitHub" },
  { slug: "notion", name: "Notion" },
  { slug: "googledrive", name: "Google Drive" },
  { slug: "linkedin", name: "LinkedIn" },
]);

// Composio removed its managed X app in February 2026 (https://docs.composio.dev/toolkits/twitter), so X connects only
// through an auth config holding the user's own X developer credentials.
const OWN_CREDENTIALS = new Set(["twitter"]);

const STATUS_WORDS = {
  ACTIVE: "connected",
  INITIALIZING: "waiting for sign-in",
  INITIATED: "waiting for sign-in",
  EXPIRED: "expired",
  FAILED: "failed",
  INACTIVE: "turned off",
};
const ACCOUNT_ID = /^[A-Za-z0-9_-]+$/;

function curatedApp(slug) {
  const app = CURATED_APPS.find((item) => item.slug === slug);
  if (!app) throw new Error("That app is not one Jarvis can connect.");
  return app;
}

function ownCredentialsText(app) {
  return (
    `${app.name} has no Composio-managed sign-in, so it needs your own ${app.name} developer app. ` +
    `Add an auth config for ${app.name} with your API credentials at ${COMPOSIO_DASHBOARD}, then press Connect again. ` +
    `Until then Jarvis can use ${app.name} in your signed-in browser.`
  );
}

/** The curated list with nothing connected: what the UI shows without a key or when Composio is unreachable. */
export function disconnectedApps() {
  return CURATED_APPS.map((app) => ({
    ...app,
    connected: false,
    status: "not connected",
    ...(OWN_CREDENTIALS.has(app.slug) ? { hint: ownCredentialsText(app) } : {}),
  }));
}

function query(params) {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params ?? {})) {
    // Composio reads array filters comma-separated (its generated client stringifies with arrayFormat "comma").
    if (value !== undefined) search.set(key, Array.isArray(value) ? value.join(",") : String(value));
  }
  const text = search.toString();
  return text ? `?${text}` : "";
}

function upstreamMessage(payload) {
  const error = payload?.error;
  const message = typeof error === "string" ? error : typeof error?.message === "string" ? error.message : "";
  const fix = typeof error?.suggested_fix === "string" ? error.suggested_fix : "";
  return [message, fix].filter(Boolean).join(" ");
}

/**
 * @param {{ apiKey: string, fetch?: typeof fetch, base?: string, timeoutMs?: number }} options
 * `fetch` is injectable: main passes Electron's net.fetch (system proxy aware) and tests pass a fake.
 */
export function createComposioClient({ apiKey, fetch: fetchImpl = globalThis.fetch, base = COMPOSIO_API, timeoutMs = 15_000 }) {
  const key = String(apiKey ?? "").trim();
  if (!key) throw new Error(`Add your Composio API key first (${COMPOSIO_DASHBOARD} → Settings → API Keys).`);

  async function request(method, path, { params, body } = {}) {
    let response;
    try {
      response = await fetchImpl(`${base}${path}${query(params)}`, {
        method,
        headers: { "x-api-key": key, accept: "application/json", ...(body ? { "content-type": "application/json" } : {}) },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(`Could not reach Composio (${detail}). Check the internet connection and try again.`, { cause: error });
    }
    const text = await response.text();
    let payload = null;
    try {
      payload = text ? JSON.parse(text) : null;
    } catch {
      payload = null;
    }
    if (response.status === 401 || response.status === 403) {
      throw new Error(`Composio rejected the API key. Copy a project API key from ${COMPOSIO_DASHBOARD} (Settings → API Keys) and save it again.`);
    }
    if (!response.ok) {
      const error = new Error(upstreamMessage(payload) || `Composio answered HTTP ${response.status}.`);
      error.status = response.status;
      throw error;
    }
    return payload ?? {};
  }

  async function accountsFor(slugs) {
    const payload = await request("GET", "/connected_accounts", {
      params: { user_ids: [COMPOSIO_USER_ID], toolkit_slugs: slugs, order_by: "updated_at", order_direction: "desc", limit: 100 },
    });
    return Array.isArray(payload.items) ? payload.items : [];
  }

  /** Curated apps in contract order; an app counts as connected only with an ACTIVE account. */
  async function listApps() {
    const accounts = await accountsFor(CURATED_APPS.map((app) => app.slug));
    return disconnectedApps().map((app) => {
      const mine = accounts.filter((account) => account?.toolkit?.slug === app.slug);
      // Newest first (order_by updated_at desc), so an abandoned sign-in never hides a working connection.
      const best = mine.find((account) => account.status === "ACTIVE") ?? mine[0];
      if (!best) return app;
      const status = String(best.status ?? "");
      return { ...app, connected: status === "ACTIVE", status: STATUS_WORDS[status] ?? (status.toLowerCase() || "unknown") };
    });
  }

  async function authConfigId(app) {
    const payload = await request("GET", "/auth_configs", { params: { toolkit_slug: app.slug, limit: 50 } });
    const enabled = (Array.isArray(payload.items) ? payload.items : []).filter(
      (item) => item?.status === "ENABLED" && item?.toolkit?.slug === app.slug && typeof item.id === "string",
    );
    // An auth config the user made in the dashboard (their own OAuth app) wins over Composio's managed one.
    const existing = enabled.find((item) => item.is_composio_managed === false) ?? enabled[0];
    if (existing) return existing.id;
    if (OWN_CREDENTIALS.has(app.slug)) throw new Error(ownCredentialsText(app));
    try {
      const created = await request("POST", "/auth_configs", {
        body: { toolkit: { slug: app.slug }, auth_config: { type: "use_composio_managed_auth", name: `Jarvis ${app.name}` } },
      });
      const id = created?.auth_config?.id;
      if (typeof id !== "string" || !id) throw new Error("Composio did not return an auth config id.");
      return id;
    } catch (error) {
      // 400 here means Composio offers no managed OAuth app for this toolkit.
      if (error?.status === 400) throw new Error(`${ownCredentialsText(app)} (Composio said: ${error.message})`, { cause: error });
      throw error;
    }
  }

  /** Returns the Connect Link to open in the user's browser; the connection turns ACTIVE once they finish there. */
  async function connect(slug) {
    const app = curatedApp(slug);
    const authConfig = await authConfigId(app);
    const link = await request("POST", "/connected_accounts/link", { body: { auth_config_id: authConfig, user_id: COMPOSIO_USER_ID } });
    let url;
    try {
      url = new URL(String(link.redirect_url));
    } catch {
      url = null;
    }
    if (!url || url.protocol !== "https:") throw new Error("Composio did not return a sign-in link.");
    return { url: url.href };
  }

  /** Deletes every connection (active or abandoned) for the app. Deleting does not revoke the grant at the provider:
   * Composio's managed Google app is shared by Gmail, Calendar and Drive, and revoking one grant could cut all three. */
  async function disconnect(slug) {
    const app = curatedApp(slug);
    const accounts = (await accountsFor([app.slug])).filter((account) => account?.toolkit?.slug === app.slug);
    for (const account of accounts) {
      const id = String(account.id ?? "");
      if (!ACCOUNT_ID.test(id)) continue;
      await request("DELETE", `/connected_accounts/${encodeURIComponent(id)}`);
    }
  }

  return { listApps, connect, disconnect };
}
