import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  Alert,
  Button,
  Code,
  CopyButton,
  Group,
  SegmentedControl,
  Stack,
  Text,
} from "@mantine/core";
import type {
  TelegramPairingIdentity,
  TelegramTargetPairing,
} from "../../../packages/contracts/src/console-pairing";
import { api, ApiError, queryClient } from "./api";
import { Failure } from "./shared";

const pairingPath = "/connections/telegram/target-pairings";
const activePairing = (pairing: TelegramTargetPairing | null) =>
  !!pairing && ["waiting", "candidate"].includes(pairing.state);
async function refresh() {
  await Promise.all(
    [
      "/connections/telegram/setup",
      "/connections",
      "/settings/configuration",
      "/settings",
    ].map((path) => queryClient.invalidateQueries({ queryKey: [path] })),
  );
}
function AccountIdentity({ account }: { account: TelegramPairingIdentity }) {
  return (
    <Stack gap={2}>
      <Text fw={600}>{account.display_name}</Text>
      {account.username && <Text size="sm">@{account.username}</Text>}
      <Text size="sm">Telegram user ID: {account.user_id}</Text>
      {account.phone && <Text size="sm">Phone: {account.phone}</Text>}
    </Stack>
  );
}
export function TelegramTargetPairingForm({
  disabled,
  available,
  onActiveChange,
  onBusyChange,
}: {
  disabled: boolean;
  available: boolean;
  onActiveChange: (active: boolean) => void;
  onBusyChange: (busy: boolean) => void;
}) {
  const [method, setMethod] = useState<"message" | "call">("message");
  const [pairing, setPairing] = useState<TelegramTargetPairing | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const [generation, setGeneration] = useState(0);
  const [now, setNow] = useState(Date.now);
  const actionActive = useRef(false);
  const queryGeneration = useRef(0);
  const active = activePairing(pairing);
  const expired =
    !!pairing && Date.parse(pairing.expires_at) <= Math.max(now, Date.now());
  const poll = useQuery({
    queryKey: ["telegram-target-pairing", pairing?.id, generation],
    queryFn: ({ signal }) =>
      api<TelegramTargetPairing>(
        `${pairingPath}/${encodeURIComponent(pairing!.id)}`,
        { signal, cache: "no-store" },
      ),
    enabled: active && !busy,
    gcTime: 0,
    refetchInterval: 2000,
    retry: false,
  });
  useEffect(() => {
    if (poll.data?.id !== pairing?.id || !poll.data || actionActive.current)
      return;
    setPairing(poll.data);
    if (!activePairing(poll.data)) void refresh();
  }, [poll.data]);
  useEffect(() => {
    onActiveChange(active);
    return () => onActiveChange(false);
  }, [active, onActiveChange]);
  useEffect(() => {
    onBusyChange(busy);
    return () => onBusyChange(false);
  }, [busy, onBusyChange]);
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [active]);
  async function act(path: string, body: object) {
    if (actionActive.current) return;
    actionActive.current = true;
    setBusy(true);
    setError(null);
    const nextGeneration = ++queryGeneration.current;
    setGeneration(nextGeneration);
    try {
      if (pairing) {
        const queryKey = ["telegram-target-pairing", pairing.id];
        await queryClient.cancelQueries({ queryKey });
        queryClient.removeQueries({ queryKey });
      }
      const result = await api<TelegramTargetPairing>(path, {
        method: "POST",
        body: JSON.stringify(body),
        cache: "no-store",
      });
      queryClient.setQueryData(
        ["telegram-target-pairing", result.id, nextGeneration],
        result,
      );
      setPairing(result);
      setNow(Date.now());
      if (!activePairing(result)) await refresh();
    } catch (cause) {
      setError(cause as Error);
    } finally {
      actionActive.current = false;
      setBusy(false);
    }
  }
  return (
    <Stack gap="sm">
      {error && <Failure error={error} />}
      {pairing?.error && <Failure error={new ApiError(409, pairing.error)} />}
      {active && poll.error && (
        <Failure error={poll.error} retry={() => void poll.refetch()} />
      )}
      {active && pairing ? (
        <>
          {expired ? (
            <Alert color="orange">
              This pairing attempt has expired. Waiting for its final status…
            </Alert>
          ) : pairing.state === "waiting" ? (
            <>
              <Text size="sm">
                {pairing.method === "message"
                  ? "From the Telegram account where you want to receive calls, send this exact code to:"
                  : "From the Telegram account where you want to receive calls, call:"}
              </Text>
              <AccountIdentity account={pairing.account} />
              {pairing.method === "message" && pairing.code && (
                <Group>
                  <Code>{pairing.code}</Code>
                  <CopyButton value={pairing.code}>
                    {({ copied, copy }) => (
                      <Button variant="light" onClick={copy} disabled={busy}>
                        {copied ? "Copied" : "Copy code"}
                      </Button>
                    )}
                  </CopyButton>
                </Group>
              )}
              {pairing.method === "call" && (
                <Text size="sm">
                  VoxDock identifies the incoming call and declines it. Seeing
                  the call end without an answer is expected.
                </Text>
              )}
              <Text size="sm" c="dimmed">
                Waiting for your{" "}
                {pairing.method === "message" ? "message" : "call"}…
                Use a different account from the calling account.
              </Text>
            </>
          ) : pairing.candidate ? (
            <Alert title="Is this your receiving account?">
              <Stack gap="sm">
                <AccountIdentity account={pairing.candidate} />
                <Text size="sm">
                  Check the name and Telegram user ID. Confirm only if this is
                  the account where you want VoxDock to call you.
                </Text>
                <Button
                  loading={busy}
                  disabled={disabled || !!pairing.error || !!poll.error}
                  onClick={() =>
                    void act(
                      `${pairingPath}/${encodeURIComponent(pairing.id)}/confirm`,
                      { candidate_id: pairing.candidate!.id },
                    )
                  }
                >
                  Confirm this account
                </Button>
              </Stack>
            </Alert>
          ) : null}
          <Text size="xs" c="dimmed">
            Expires {new Date(pairing.expires_at).toLocaleTimeString()}.
            If you leave this page, pairing remains open until it expires.
          </Text>
          <Button
            variant="default"
            disabled={busy}
            onClick={() =>
              void act(
                `${pairingPath}/${encodeURIComponent(pairing.id)}/cancel`,
                {},
              )
            }
          >
            Cancel receiving-account pairing
          </Button>
        </>
      ) : (
        <>
          {pairing?.state === "completed" && (
            <Alert color="teal">Receiving account confirmed.</Alert>
          )}
          {pairing?.state === "expired" && (
            <Alert color="orange">
              Pairing expired. Start again to verify your account.
            </Alert>
          )}
          {pairing?.state === "cancelled" && (
            <Text size="sm">
              Pairing cancelled. Your saved receiving account has not changed.
            </Text>
          )}
          {pairing?.state === "failed" && !pairing.error && (
            <Alert color="red">Pairing failed. Start again to verify your account.</Alert>
          )}
          <Text size="sm">
            Verify the account where you want to receive calls by sending a code
            or making a call. Use a different account from your calling account.
            Your saved receiving account stays in place until you confirm a
            replacement.
          </Text>
          <SegmentedControl
            aria-label="Telegram receiving-account verification method"
            value={method}
            onChange={(value) => setMethod(value as "message" | "call")}
            disabled={disabled || !available || busy}
            data={[
              { value: "message", label: "Send a code" },
              { value: "call", label: "Make a call" },
            ]}
          />
          <Button
            disabled={disabled || !available}
            loading={busy}
            onClick={() => void act(pairingPath, { method })}
          >
            {method === "message" ? "Get pairing code" : "Start call pairing"}
          </Button>
          <Text size="xs" c="dimmed">
            You will review the detected account before saving it.
          </Text>
        </>
      )}
    </Stack>
  );
}
