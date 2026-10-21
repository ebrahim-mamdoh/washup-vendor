"use client";

import axios, { type InternalAxiosRequestConfig } from "axios";

import { createApiFailureError, isApiFailureEnvelope } from "@/lib/api/api-error-handler";
import { getApiBaseUrl } from "@/lib/config/api-base-url";
import { setServerNow } from "@/lib/format";
import { getAuthAccessToken, getAuthTokenType, useAuthStore } from "@/lib/store/auth-store";
import type { SessionTokens } from "@/types/auth";

const REFRESH_PATH = "/vendor/auth/refresh";
/** Renew the access token this long before it expires, so requests never race the expiry. */
const RENEW_BEFORE_MS = 60_000;

/** Bearer-authenticated vendor (wash owner/manager) client. Token is read from the auth store per request. */
export const apiClient = axios.create({
  baseURL: getApiBaseUrl(),
  headers: {
    "Content-Type": "application/json",
    Accept: "application/json",
  },
  withCredentials: false,
});

const isAuthCall = (url: string) => url.includes("/auth/login") || url.includes("/auth/refresh");

let refreshing: Promise<string | null> | null = null;

async function requestNewToken(): Promise<string | null> {
  const { refreshToken, setTokens, clearAuth } = useAuthStore.getState();
  if (!refreshToken) return null;
  try {
    // Plain axios: the refresh call must not go through these interceptors.
    const { data } = await axios.post<{ status: boolean; data: SessionTokens | null }>(
      `${getApiBaseUrl()}${REFRESH_PATH}`,
      { refresh_token: refreshToken },
      { headers: { "Content-Type": "application/json", Accept: "application/json" } },
    );
    if (!data?.status || !data.data?.access_token) throw new Error("refresh failed");
    setTokens(data.data);
    return data.data.access_token;
  } catch (error) {
    // A rejected refresh token ends the session; a network error keeps it for the next try.
    if (!axios.isAxiosError(error) || error.response) clearAuth();
    return null;
  }
}

/** Renews the session once for every caller waiting on it; null when it can't be renewed. */
function refreshAccessToken(): Promise<string | null> {
  if (!refreshing) refreshing = requestNewToken().finally(() => (refreshing = null));
  return refreshing;
}

apiClient.interceptors.request.use(async (config) => {
  config.baseURL = getApiBaseUrl();
  const { expiresAt, refreshToken } = useAuthStore.getState();
  if (!isAuthCall(String(config.url ?? "")) && refreshToken && expiresAt && Date.now() > expiresAt - RENEW_BEFORE_MS) {
    await refreshAccessToken();
  }
  const token = getAuthAccessToken();
  if (token) {
    config.headers.Authorization = `${getAuthTokenType()} ${token}`;
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
    const hadAuth = Boolean(config?.headers?.Authorization);
    if (status === 401 && hadAuth && config && !isAuthCall(url)) {
      // An expired token: renew it once and replay the request; otherwise the session is over.
      if (!config._retried && useAuthStore.getState().refreshToken) {
        const token = await refreshAccessToken();
        if (token) {
          config._retried = true;
          config.headers.Authorization = `${getAuthTokenType()} ${token}`;
          return apiClient(config);
        }
      }
      useAuthStore.getState().clearAuth();
    }
    return Promise.reject(error);
  },
);
