"use client";

import axios, { type InternalAxiosRequestConfig } from "axios";

import { createApiFailureError, isApiFailureEnvelope } from "@/lib/api/api-error-handler";
import { WEB_CLIENT_HEADER, WEB_CLIENT_VALUE } from "@/lib/auth/web-session";
import { getApiBaseUrl } from "@/lib/config/api-base-url";
import { setServerNow } from "@/lib/format";
import { useAuthStore } from "@/lib/store/auth-store";

const REFRESH_PATH = "/vendor/auth/refresh";
/** Renew the access token this long before it expires, so requests never race the expiry. */
const RENEW_BEFORE_MS = 60_000;

/**
 * Vendor (wash owner/manager) client. GAP-063: the session is in httpOnly cookies set by the
 * same-origin API, so no token is handled here; `X-Washup-Client: web` asks the API to use them
 * (and to keep the tokens out of login/refresh responses).
 */
const WEB_HEADERS = {
  "Content-Type": "application/json",
  Accept: "application/json",
  [WEB_CLIENT_HEADER]: WEB_CLIENT_VALUE,
};

export const apiClient = axios.create({
  baseURL: getApiBaseUrl(),
  headers: WEB_HEADERS,
});

const isAuthCall = (url: string) =>
  url.includes("/auth/login") || url.includes("/auth/refresh") || url.includes("/auth/forgot-password") || url.includes("/auth/reset-password");

const isSignedIn = () => useAuthStore.getState().account !== null;

let refreshing: Promise<boolean> | null = null;

async function requestNewSession(): Promise<boolean> {
  const { setSessionExpiry, clearAuth } = useAuthStore.getState();
  try {
    // Plain axios: the refresh call must not go through these interceptors. The refresh token is the cookie.
    const { data } = await axios.post<{ status: boolean; data: { expires_in?: number | null } | null }>(
      `${getApiBaseUrl()}${REFRESH_PATH}`,
      {},
      { headers: WEB_HEADERS },
    );
    if (!data?.status) throw new Error("refresh failed");
    setSessionExpiry(data.data?.expires_in);
    return true;
  } catch (error) {
    // A rejected refresh token ends the session; a network error keeps it for the next try.
    if (!axios.isAxiosError(error) || error.response) clearAuth();
    return false;
  }
}

/** Renews the session once for every caller waiting on it; false when it can't be renewed. */
function refreshSession(): Promise<boolean> {
  if (!refreshing) refreshing = requestNewSession().finally(() => (refreshing = null));
  return refreshing;
}

apiClient.interceptors.request.use(async (config) => {
  config.baseURL = getApiBaseUrl();
  const { expiresAt } = useAuthStore.getState();
  if (!isAuthCall(String(config.url ?? "")) && isSignedIn() && expiresAt && Date.now() > expiresAt - RENEW_BEFORE_MS) {
    await refreshSession();
  }
  return config;
});

apiClient.interceptors.response.use(
  (response) => {
    // Calibrate relative times/timers against the server clock.
    setServerNow(response.headers["x-demo-now"] as string | undefined);
    // Laravel can answer 200 with `{ status: false }` — treat it as a failure.
    if (isApiFailureEnvelope(response.data)) {
      return Promise.reject(createApiFailureError(response.data));
    }
    return response;
  },
  async (error) => {
    const status = error?.response?.status;
    const config = error?.config as (InternalAxiosRequestConfig & { _retried?: boolean }) | undefined;
    const url = String(config?.url ?? "");
    if (status === 401 && config && !isAuthCall(url) && isSignedIn()) {
      // An expired access cookie: renew it once (refresh cookie) and replay the request;
      // otherwise the session is over and the portal gate sends the user to /login.
      if (!config._retried && (await refreshSession())) {
        config._retried = true;
        return apiClient(config);
      }
      if (isSignedIn()) useAuthStore.getState().clearAuth();
    }
    return Promise.reject(error);
  },
);
