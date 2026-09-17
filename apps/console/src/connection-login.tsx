import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  Alert,
  Button,
  Group,
  Image,
  PasswordInput,
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
};
export const connectionTerminal = (flow: ConnectionFlow) =>
  ["connected", "cancelled", "expired", "failed"].includes(flow.state);
export function ConnectionLogin({
  channel,
  authenticated,
  onFlowChange,
  onBusyChange,
}: {
  channel: "telegram" | "whatsapp";
  authenticated: boolean;
  onFlowChange?: (flow: ConnectionFlow | null) => void;
  onBusyChange?: (busy: boolean) => void;
}) {
  const [flow, setFlow] = useState<ConnectionFlow | null>(null);
  const [phone, setPhone] = useState("");
  const [code, setCode] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const [qrImage, setQrImage] = useState<string | null>(null);
  const poll = useQuery({
    queryKey: ["connection-flow", flow?.id],
    queryFn: ({ signal }) =>
      api<ConnectionFlow>(
        `/connections/flows/${encodeURIComponent(flow!.id)}`,
        {
          signal,
          cache: "no-store",
        },
      ),
    enabled: !!flow && !connectionTerminal(flow),
    refetchInterval: 2000,
    retry: false,
  });
  useEffect(() => {
    if (poll.data) {
      setFlow(poll.data);
      if (connectionTerminal(poll.data))
        void queryClient.invalidateQueries({ queryKey: ["/connections"] });
      if (poll.data.state === "connected")
        void queryClient.invalidateQueries({
          queryKey: ["/connections/whatsapp/setup"],
        });
    }
  }, [poll.data]);
  useEffect(() => {
    let active = true;
    setQrImage(null);
    if (flow?.qr && flow.state === "qr_required")
      void QRCode.toDataURL(flow.qr, { width: 260, margin: 2 })
        .then((image) => {
          if (active) setQrImage(image);
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
  }, [flow?.qr, flow?.state]);
  async function act(path: string, body: object = {}) {
    setBusy(true);
    setError(null);
    try {
      const result = await api<ConnectionFlow | undefined>(path, {
        method: "POST",
        body: JSON.stringify(body),
        cache: "no-store",
      });
      setFlow(result?.id ? result : null);
      setCode("");
      setPassword("");
      await queryClient.invalidateQueries({ queryKey: ["/connections"] });
      await queryClient.invalidateQueries({
        queryKey: ["/connections/whatsapp/setup"],
      });
    } catch (error) {
      setError(error as Error);
    } finally {
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
                Open WhatsApp on your phone, go to Linked devices, and scan this
                code.
              </Text>
              {qrImage && (
                <Image
                  src={qrImage}
                  alt="WhatsApp device pairing QR code"
                  w={260}
                  maw="100%"
                />
              )}
              <Text size="xs" c="dimmed">
                Keep this page open until your account is connected.
              </Text>
            </>
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
          onClick={() => void act(`/connections/${channel}/disconnect`)}
        >
          Disconnect account
        </Button>
      ) : channel === "telegram" ? (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void act("/connections/telegram/login", { phone });
          }}
        >
          <Stack gap="sm">
            <TextInput
              label="Phone number"
              description="Include the country code, for example +81."
              type="tel"
              autoComplete="tel"
              value={phone}
              onChange={(event) => setPhone(event.currentTarget.value)}
              required
            />
            <Group>
              <Button type="submit" loading={busy}>
                Connect Telegram
              </Button>
            </Group>
          </Stack>
        </form>
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
