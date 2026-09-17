import { QueryClient, useQuery } from "@tanstack/react-query";
import type { ConsoleSession } from "../../../packages/contracts/src/console";
export const queryClient = new QueryClient({
  defaultOptions: {
    queries: { retry: false, staleTime: 5_000, refetchOnWindowFocus: true },
  },
});
let session: ConsoleSession | null = null;
let onUnauthorized = () => {};
export function configureSession(
  value: ConsoleSession | null,
  callback: () => void,
) {
  session = value;
  onUnauthorized = callback;
}
export function endSession() {
  onUnauthorized();
}
const friendlyErrors: Record<string, string> = {
  remote_management_disabled:
    "Remote management is disabled. Open the console locally on the server to enable access.",
  revision_conflict:
    "Settings changed elsewhere. Reload saved settings, review your changes, and save again.",
  account_revision_conflict:
    "Account settings changed elsewhere. Refresh this page and try again.",
  active_or_uncertain_call:
    "Wait until all calls have ended before applying settings.",
  management_busy:
    "Another configuration or connection change is in progress. Try again shortly.",
  invalid_configuration: "Check the settings and call targets, then try again.",
  credentials_required:
    "Add the required credentials before enabling this connection.",
  runtime_apply_failed:
    "Settings could not be applied. Calling remains paused. Review the configuration and try again.",
  invalid_current_password:
    "The current password was not accepted. Sign in again and retry.",
};
export class ApiError extends Error {
  constructor(
    public status: number,
    public code?: string,
  ) {
    super(
      friendlyErrors[code ?? ""] ??
        (code === "usage_timezone_conflict"
          ? "Usage records use a different timezone. Restore the matching timezone in your deployment configuration to view this report."
          : status === 401
            ? "Your session has ended. Please sign in again."
            : status === 409
              ? "This action is not available in the current state. Refresh and try again."
              : "We couldn’t complete this request. Please try again."),
    );
  }
}
export async function api<T>(path: string, options?: RequestInit): Promise<T> {
  const response = await fetch(`/admin/v1${path}`, {
    ...options,
    credentials: "same-origin",
    headers: {
      ...(options?.body !== undefined
        ? { "Content-Type": "application/json" }
        : {}),
      ...(session && options?.method && options.method !== "GET"
        ? { "X-CSRF-Token": session.csrf_token }
        : {}),
      ...options?.headers,
    },
  });
  if (!response.ok) {
    if (
      response.status === 401 &&
      (path !== "/session" || options?.method === "DELETE")
    )
      onUnauthorized();
    const body = await response.json().catch(() => null);
    throw new ApiError(
      response.status,
      body?.error?.code ?? body?.code ?? body?.error,
    );
  }
  return response.status === 204
    ? (undefined as T)
    : (response.json() as Promise<T>);
}
export function useResource<T>(path: string) {
  return useQuery({
    queryKey: [path],
    queryFn: ({ signal }) => api<T>(path, { signal }),
    refetchInterval: () =>
      document.visibilityState === "visible" ? 10_000 : false,
    refetchIntervalInBackground: false,
  });
}
export async function exportCall(id: string, format: string, redact: boolean) {
  const response = await fetch(
    `/admin/v1/calls/${encodeURIComponent(id)}/export?format=${format}&redact=${redact}`,
    { credentials: "same-origin" },
  );
  if (!response.ok) {
    if (response.status === 401) onUnauthorized();
    throw new ApiError(response.status);
  }
  const url = URL.createObjectURL(await response.blob());
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `voxdock-call.${format}`;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1_000);
}
