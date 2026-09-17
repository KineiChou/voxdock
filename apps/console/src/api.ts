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
  whatsapp_unlink_unconfirmed:
    "Sign-out could not be confirmed. WhatsApp calling and your receiving number are disabled. Check the connection and retry unlinking.",
  account_unlink_unavailable:
    "Account unlinking is unavailable. Check the WhatsApp service on your server and try again.",
  target_pairing_not_found:
    "This pairing attempt is no longer available. Start again.",
  target_pairing_active:
    "A receiving-number pairing attempt is already active. Cancel it or wait for it to expire.",
  invalid_pairing_method: "Choose message or call pairing and try again.",
  whatsapp_account_required: "Link your WhatsApp calling account first.",
  target_pairing_cleanup_required:
    "Pairing could not be closed safely. Restart VoxDock before trying again.",
  target_pairing_unavailable:
    "Receiving-number pairing is unavailable. Check the WhatsApp service on your server.",
  target_pairing_changed:
    "The detected account changed. Review the latest number before confirming.",
  target_pairing_stale:
    "This pairing attempt has expired or changed. Start again.",
  target_must_differ:
    "Use a different WhatsApp account to receive calls from the linked account.",
  connection_cleanup_required:
    "The connection could not be closed safely. Restart VoxDock before trying again.",
  connection_operation_active:
    "Finish or cancel the current connection attempt first.",
  telegram_credentials_required:
    "Save your Telegram API ID and API hash before connecting.",
  whatsapp_service_required:
    "Configure the WhatsApp service before connecting.",
  telegram_already_connected:
    "Disconnect the current Telegram account before signing in again.",
  telegram_sign_in_failed:
    "Telegram sign-in failed. Check your account details and try again.",
  connection_challenge_stale:
    "This verification step has expired or already been used. Start again.",
  connection_operation_unavailable:
    "This connection operation is unavailable. Check the saved settings and current call status.",
  connection_disconnect_unconfirmed:
    "The account could not be disconnected safely. Check its status before trying again.",
  whatsapp_status_unavailable: "WhatsApp status is temporarily unavailable.",
  runtime_stop_failed:
    "Calling is paused because the previous connection did not close safely. Restart VoxDock before trying again.",
  remote_management_disabled:
    "Remote management is disabled. Open Settings and Connections locally on the server. Calls and call history remain available.",
  revision_conflict:
    "Settings changed elsewhere. Reload saved settings, review your changes, and save again.",
  account_revision_conflict:
    "Account settings changed elsewhere. Refresh this page and try again.",
  active_or_uncertain_call:
    "A call is still active or its outcome is uncertain. Resolve it before changing settings or resuming calls.",
  management_busy:
    "Another configuration or connection change is in progress. Try again shortly.",
  calling_disabled:
    "Calling is turned off. Enable it in Settings before resuming.",
  adapter_not_ready:
    "Connect and enable a channel with an enabled call target before resuming calls.",
  invalid_configuration: "Check the settings and call targets, then try again.",
  credentials_required:
    "Add the required credentials before enabling this connection.",
  runtime_apply_failed:
    "Settings could not be applied. Calling remains paused. Review the configuration and try again.",
  invalid_current_password:
    "The current password was not accepted. Check it and try again.",
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
