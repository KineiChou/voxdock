import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  Alert,
  Button,
  Group,
  Image,
  PasswordInput,
  SegmentedControl,
  Stack,
  Text,
  TextInput,
} from "@mantine/core";
import QRCode from "qrcode";
import { api, ApiError, queryClient } from "./api";
import { Failure, Status } from "./shared";

export type ConnectionFlow = {
  id: string;
  channel: string;
  state:
    | "starting"
    | "code_required"
    | "password_required"
    | "qr_required"
    | "connected"
    | "cancelled"
    | "expired"
    | "failed";
  expires_at: string;
  error?: string;
  qr?: string;
  qr_expires_at?: string;
};
export const connectionTerminal = (flow: ConnectionFlow) =>
  ["connected", "cancelled", "expired", "failed"].includes(flow.state);
export function ConnectionLogin({
  channel,
  authenticated,
  onFlowChange,
  onBusyChange,
  disabled = false,
}: {
  channel: "telegram" | "whatsapp";
  authenticated: boolean;
  disabled?: boolean;
  onFlowChange?: (flow: ConnectionFlow | null) => void;
  onBusyChange?: (busy: boolean) => void;
}) {
  const [flow, setFlow] = useState<ConnectionFlow | null>(null);
  const [method, setMethod] = useState("qr");
  const [phone, setPhone] = useState("");
  const [code, setCode] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const [qrImage, setQrImage] = useState<{ qr: string; image: string } | null>(null);
  const [now, setNow] = useState(Date.now);
  const [generation, setGeneration] = useState(0);
  const actionActive = useRef(false);
  const queryGeneration = useRef(0);
  const qrExpiresAt = flow?.qr_expires_at ?? flow?.expires_at;
  const qrExpired = !!qrExpiresAt && Date.parse(qrExpiresAt) <= Math.max(now, Date.now());
  useEffect(() => {
    if (flow?.state !== "qr_required") return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [flow?.state]);
  const poll = useQuery({
    queryKey: ["connection-flow", flow?.id, generation],
    queryFn: ({ signal }) =>
      api<ConnectionFlow>(
        `/connections/flows/${encodeURIComponent(flow!.id)}`,
        {
          signal,
          cache: "no-store",
        },
      ),
    enabled: !!flow && !connectionTerminal(flow) && !busy,
    gcTime: 0,
    refetchInterval: 2000,
    retry: false,
  });
  useEffect(() => {
    if (poll.data && poll.data.id === flow?.id && !actionActive.current) {
      setFlow(poll.data);
      if (connectionTerminal(poll.data))
        void queryClient.invalidateQueries({ queryKey: ["/connections"] });
      if (poll.data.state === "connected")
        void queryClient.invalidateQueries({
          queryKey: [`/connections/${channel}/setup`],
        });
    }
  }, [poll.data]);
  useEffect(() => {
    let active = true;
    setQrImage(null);
    const qr = flow?.qr;
    if (qr && flow.state === "qr_required" && !qrExpired && !busy)
      void QRCode.toDataURL(qr, { width: 260, margin: 2 })
        .then((image) => {
          if (active) setQrImage({ qr, image });
        })
        .catch(() => {
          if (active)
            setError(
              new Error(
                "The pairing code could not be displayed. Restart pairing.",
              ),
            );
        });
    return () => {
      active = false;
    };
  }, [flow?.qr, flow?.state, qrExpired, busy]);
  async function act(path: string, body: object = {}) {
    if (actionActive.current) return;
    actionActive.current = true;
    setBusy(true);
    setError(null);
    setQrImage(null);
    // A new query generation isolates mutation results from earlier polling.
    const nextGeneration = ++queryGeneration.current;
    setGeneration(nextGeneration);
    if (flow) setFlow({ ...flow, qr: undefined, qr_expires_at: undefined });
    try {
      if (flow) {
        const queryKey = ["connection-flow", flow.id];
        await queryClient.cancelQueries({ queryKey });
        queryClient.removeQueries({ queryKey });
      }
      const result = await api<ConnectionFlow | undefined>(path, {
        method: "POST",
        body: JSON.stringify(body),
        cache: "no-store",
      });
      if (result?.id)
        queryClient.setQueryData(
          ["connection-flow", result.id, nextGeneration],
          result,
        );
      setFlow(result?.id ? result : null);
      setNow(Date.now());
      setCode("");
      setPassword("");
      await queryClient.invalidateQueries({ queryKey: ["/connections"] });
      await queryClient.invalidateQueries({
        queryKey: [`/connections/${channel}/setup`],
      });
    } catch (error) {
      setError(error as Error);
    } finally {
      actionActive.current = false;
      setBusy(false);
    }
  }
  useEffect(() => {
    onFlowChange?.(flow);
  }, [flow, onFlowChange]);
  useEffect(() => {
    onBusyChange?.(busy);
    return () => onBusyChange?.(false);
  }, [busy, onBusyChange]);
  const active = flow && !connectionTerminal(flow);
  return (
    <Stack mt="lg" gap="sm">
      {error && <Failure error={error} />}
      {poll.error && (
        <Failure error={poll.error} retry={() => void poll.refetch()} />
      )}
      {flow && <Status value={flow.state} />}
      {flow?.error && <Failure error={new ApiError(409, flow.error)} />}
      {flow?.state === "expired" && (
        <Alert color="orange">
          Pairing expired. Start again to get a new code.
        </Alert>
      )}
      {active ? (
        <>
          {flow.state === "starting" && (
            <Text size="sm" c="dimmed">
              Waiting for the connection…
            </Text>
          )}
          {flow.state === "code_required" && (
            <form
              onSubmit={(event) => {
                event.preventDefault();
                void act(`/connections/flows/${flow.id}/code`, { code });
              }}
            >
              <Stack gap="sm">
                <TextInput
                  label="Telegram verification code"
                  autoComplete="one-time-code"
                  value={code}
                  onChange={(event) => setCode(event.currentTarget.value)}
                  required
                />
                <Button type="submit" loading={busy}>
                  Verify code
                </Button>
              </Stack>
            </form>
          )}
          {flow.state === "password_required" && (
            <form
              onSubmit={(event) => {
                event.preventDefault();
                void act(`/connections/flows/${flow.id}/password`, {
                  password,
                });
              }}
            >
              <Stack gap="sm">
                <PasswordInput
                  label="Telegram two-step verification password"
                  value={password}
                  onChange={(event) => setPassword(event.currentTarget.value)}
                  required
                />
                <Button type="submit" loading={busy}>
                  Verify password
                </Button>
              </Stack>
            </form>
          )}
          {flow.state === "qr_required" && (
            <>
              <Text size="sm">
                {channel === "telegram"
                  ? "Open Telegram on the phone with your calling account. Go to Settings → Devices → Link Desktop Device, then scan this code."
                  : "Open WhatsApp using the account you want the server to use, go to Linked devices, and scan this code."}
              </Text>
              {qrExpired && !busy && (
                <Alert color="orange">
                  {channel === "telegram"
                    ? "This QR code has expired. Waiting for a new code…"
                    : "This QR code has expired. Refresh it to continue pairing."}
                </Alert>
              )}
              {!busy && !qrExpired && qrImage?.qr === flow.qr && qrImage && (
                <Image
                  src={qrImage.image}
                  alt={
                    channel === "telegram"
                      ? "Telegram login QR code"
                      : "WhatsApp device pairing QR code"
                  }
                  w={260}
                  maw="100%"
                />
              )}
              <Text size="xs" c="dimmed">
                Keep this page open until your account is connected.
              </Text>
            </>
          )}
          {channel === "whatsapp" &&
            ["starting", "qr_required"].includes(flow.state) && (
              <Button
                variant="light"
                loading={busy}
                onClick={() => void act(`/connections/flows/${flow.id}/refresh`)}
              >
                Refresh QR code
              </Button>
            )}
          <Button
            variant="default"
            disabled={busy}
            onClick={() => void act(`/connections/flows/${flow.id}/cancel`)}
          >
            Cancel pairing
          </Button>
        </>
      ) : authenticated || flow?.state === "connected" ? (
        <Button
          variant="light"
          color="red"
          loading={busy}
          disabled={disabled}
          onClick={() => void act(`/connections/${channel}/disconnect`)}
        >
          Disconnect account
        </Button>
      ) : channel === "telegram" ? (
        <Stack gap="sm">
          <SegmentedControl
            aria-label="Telegram login method"
            value={method}
            onChange={setMethod}
            disabled={disabled || busy}
            data={[
              { value: "qr", label: "QR code" },
              { value: "phone", label: "Phone number" },
            ]}
          />
          {method === "qr" ? (
            <Button
              disabled={disabled}
              loading={busy}
              onClick={() => void act("/connections/telegram/qr")}
            >
              Get Telegram QR code
            </Button>
          ) : (
            <form
              onSubmit={(event) => {
                event.preventDefault();
                if (!disabled) void act("/connections/telegram/login", { phone });
              }}
            >
              <Stack gap="sm">
                <TextInput
                  label="Phone number"
                  description="Include the country code, for example +81."
                  type="tel"
                  autoComplete="tel"
                  value={phone}
                  disabled={disabled || busy}
                  onChange={(event) => setPhone(event.currentTarget.value)}
                  required
                />
                <Group>
                  <Button type="submit" disabled={disabled} loading={busy}>
                    Connect Telegram
                  </Button>
                </Group>
              </Stack>
            </form>
          )}
        </Stack>
      ) : (
        <Button
          loading={busy}
          onClick={() => void act("/connections/whatsapp/connect")}
        >
          Connect WhatsApp
        </Button>
      )}
    </Stack>
  );
}
