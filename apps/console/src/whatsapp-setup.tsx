import { useEffect, useState } from "react";
import { useQuery, type Query } from "@tanstack/react-query";
import {
  Alert,
  Button,
  Code,
  CopyButton,
  Group,
  Modal,
  SegmentedControl,
  Stack,
  Stepper,
  Text,
} from "@mantine/core";
import { api, ApiError, queryClient, useResource } from "./api";
import {
  ConnectionLogin,
  connectionTerminal,
  type ConnectionFlow,
} from "./connection-login";
import { Failure, Fields, Loading } from "./shared";
import { WhatsAppAccount } from "./whatsapp-account";
import type {
  WhatsAppSetup as Setup,
  TargetPairing as Pairing,
} from "../../../packages/contracts/src/console-pairing";
const activePairing = (pairing: Pairing | null) =>
  !!pairing && ["waiting", "candidate"].includes(pairing.state);
const setupPath = "/connections/whatsapp/setup";
const pairingPath = "/connections/whatsapp/target-pairings";
export function WhatsAppSetup() {
  const setup = useResource<Setup>(setupPath);
  const [opened, setOpened] = useState(false);
  const [confirmUnlink, setConfirmUnlink] = useState(false);
  const [unlinked, setUnlinked] = useState(false);
  const [loginKey, setLoginKey] = useState(0);
  const [method, setMethod] = useState<"message" | "call">("message");
  const [pairing, setPairing] = useState<Pairing | null>(null);
  const [connection, setConnection] = useState<ConnectionFlow | null>(null);
  const [connectionBusy, setConnectionBusy] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const poll = useQuery({
    queryKey: ["target-pairing", pairing?.id],
    queryFn: ({ signal }) =>
      api<Pairing>(`${pairingPath}/${encodeURIComponent(pairing!.id)}`, {
        signal,
        cache: "no-store",
      }),
    enabled: activePairing(pairing),
    refetchInterval: 2000,
    retry: false,
  });
  useEffect(() => {
    if (!poll.data) return;
    setPairing(poll.data);
    if (poll.data.state === "completed") void refresh();
  }, [poll.data]);
  async function refresh() {
    await Promise.all(
      [setupPath, "/connections", "/settings/configuration", "/settings"].map(
        (path) => queryClient.invalidateQueries({ queryKey: [path] }),
      ),
    );
  }
  async function act(path: string, body: object) {
    setBusy(true);
    setError(null);
    try {
      await queryClient.cancelQueries({
        queryKey: ["target-pairing", pairing?.id],
      });
      const next = await api<Pairing>(path, {
        method: "POST",
        body: JSON.stringify(body),
        cache: "no-store",
      });
      queryClient.setQueryData(["target-pairing", next.id], next);
      setPairing(next);
      if (next.state === "completed") await refresh();
    } catch (cause) {
      setError(cause as Error);
    } finally {
      setBusy(false);
    }
  }
  async function unlink() {
    if (
      !setup.data?.linked || busy || connectionBusy || activePairing(pairing) ||
      (connection && !connectionTerminal(connection))
    ) return;
    setBusy(true);
    setError(null);
    try {
      const result = await api<{ unlinked: boolean }>("/connections/whatsapp/unlink", {
        method: "POST",
        body: "{}",
      });
      if (!result.unlinked) throw new ApiError(409, "whatsapp_unlink_unconfirmed");
      await queryClient.cancelQueries({ queryKey: ["target-pairing"] });
      queryClient.removeQueries({ queryKey: ["target-pairing"] });
      const whatsappFlows = {
        predicate: (query: Query) =>
          query.queryKey[0] === "connection-flow" &&
          ((query.state.data as ConnectionFlow | undefined)?.channel === "whatsapp" ||
            query.queryKey[1] === connection?.id),
      };
      await queryClient.cancelQueries(whatsappFlows);
      queryClient.removeQueries(whatsappFlows);
      setPairing(null);
      setConnection(null);
      setLoginKey((key) => key + 1);
      setConfirmUnlink(false);
      setUnlinked(true);
      queryClient.setQueryData<Setup>([setupPath], (previous) => previous && ({
        ...previous,
        linked: false,
        connected: false,
        account_phone: null,
        target: previous.target ? { ...previous.target, enabled: false } : null,
      }));
    } catch (cause) {
      setError(cause as Error);
      setConfirmUnlink(false);
    } finally {
      await refresh();
      setBusy(false);
    }
  }
  async function close() {
    setBusy(true);
    setError(null);
    try {
      await queryClient.cancelQueries({ queryKey: ["target-pairing"] });
      if (activePairing(pairing)) {
        const result = await api<Pairing>(
          `${pairingPath}/${encodeURIComponent(pairing!.id)}/cancel`,
          {
            method: "POST",
            body: "{}",
          },
        );
        queryClient.setQueryData(["target-pairing", result.id], result);
        setPairing(result);
        if (result.state === "failed" || result.error) {
          setError(new ApiError(409, result.error));
          return;
        }
      }
      if (connection && !connectionTerminal(connection)) {
        await queryClient.cancelQueries({
          queryKey: ["connection-flow", connection.id],
        });
        const result = await api<ConnectionFlow>(
          `/connections/flows/${encodeURIComponent(connection.id)}/cancel`,
          { method: "POST", body: "{}" },
        );
        queryClient.setQueryData(["connection-flow", result.id], result);
        setConnection(result);
        if (result.state === "failed" || result.error) {
          setError(new ApiError(409, result.error));
          return;
        }
      }
      await queryClient.cancelQueries({ queryKey: ["target-pairing"] });
      queryClient.removeQueries({ queryKey: ["target-pairing"] });
      setPairing(null);
      setConnection(null);
      setOpened(false);
      setConfirmUnlink(false);
      setUnlinked(false);
      await refresh();
    } catch (cause) {
      setError(cause as Error);
    } finally {
      setBusy(false);
    }
  }
  const current = setup.data;
  const linking =
    !current?.connected || !!(connection && connection.state !== "connected");
  return (
    <Stack mt="lg" gap="sm">
      {setup.error && (
        <Failure error={setup.error} retry={() => void setup.refetch()} />
      )}
      {current && (
        <Fields
          rows={[
            ["Calling account", current.account_phone ?? "Not linked"],
            [
              "Connection",
              current.connected ? "Connected" : current.linked ? "Offline · account linked" : "Not linked",
            ],
            [
              current.target && !current.target.enabled
                ? "Previously used receiving number" : "Receive calls at",
              current.target?.phone ?? "Not paired",
            ],
            [
              "Receiving number enabled",
              current.target?.enabled ? "Yes" : "No",
            ],
          ]}
        />
      )}
      {current && !current.available && (
        <Alert color="orange">
          WhatsApp is not available. Set up the WhatsApp service on your server
          first.
        </Alert>
      )}
      <Button disabled={!current?.available} onClick={() => setOpened(true)}>
        Configure WhatsApp
      </Button>
      <Modal
        opened={opened}
        onClose={() => {
          if (!busy && !connectionBusy) void close();
        }}
        title="Configure WhatsApp"
        closeOnClickOutside={false}
        closeOnEscape={!busy && !connectionBusy}
        withCloseButton={!busy && !connectionBusy}
        size="lg"
      >
        <Stack>
          {error && <Failure error={error} />}
          {!current ? (
            <Loading />
          ) : (
            <>
              <Stepper
                active={linking ? 0 : pairing?.state === "completed" ? 2 : 1}
                size="sm"
              >
                <Stepper.Step label="Link account" />
                <Stepper.Step label="Pair your number" />
              </Stepper>
              {current.linked && (
                <WhatsAppAccount
                  phone={current.account_phone}
                  connected={current.connected}
                  disabled={busy || connectionBusy || activePairing(pairing) ||
                    !!(connection && !connectionTerminal(connection))}
                  confirming={confirmUnlink}
                  busy={busy}
                  onConfirmChange={setConfirmUnlink}
                  onUnlink={() => void unlink()}
                />
              )}
              {unlinked && !current.linked && (
                <Alert color="teal">
                  Account unlinked. Scan a new QR code, then verify the number
                  where you want to receive calls. Your call history is saved.
                </Alert>
              )}
              {!confirmUnlink && (linking ? (
                <>
                  <Text>
                    {current.linked
                      ? "Reconnect your linked account to continue."
                      : "Link the WhatsApp account VoxDock will use to call you."}{" "}
                    Your receiving phone must use a different WhatsApp account.
                  </Text>
                  <ConnectionLogin
                    key={loginKey}
                    channel="whatsapp"
                    authenticated={false}
                    onFlowChange={setConnection}
                    onBusyChange={setConnectionBusy}
                  />
                </>
              ) : (
                <>
                  {current.target && (
                    <Text size="sm">
                      {current.target.enabled ? "Current receiving number: " : "Previously used receiving number: "}
                      <strong>{current.target.phone}</strong>.
                      {current.target.enabled
                        ? " It stays in place until you confirm a replacement."
                        : " Verify your receiving number to enable calls again."}
                    </Text>
                  )}
                  {!current.pairing_available && (
                    <Alert color="orange">
                      Receiving-number pairing is unavailable. Check the
                      WhatsApp service on your server.
                    </Alert>
                  )}
                  {pairing?.state === "completed" ? (
                    <Alert color="teal">
                      Call target connected. Calling readiness will update
                      automatically.
                    </Alert>
                  ) : activePairing(pairing) ? (
                    <>
                      {pairing?.error && (
                        <Failure error={new ApiError(409, pairing.error)} />
                      )}
                      {poll.error && (
                        <Failure
                          error={poll.error}
                          retry={() => void poll.refetch()}
                        />
                      )}
                      {pairing?.state === "waiting" && (
                        <>
                          {pairing.method === "message" ? (
                            <>
                              <Text>
                                From the WhatsApp account where you want to
                                receive calls, send this exact code to{" "}
                                <strong>{pairing.account_phone}</strong>.
                              </Text>
                              <Group>
                                <Code>{pairing.code}</Code>
                                {pairing.code && (
                                  <CopyButton value={pairing.code}>
                                    {({ copied, copy }) => (
                                      <Button variant="light" onClick={copy}>
                                        {copied ? "Copied" : "Copy code"}
                                      </Button>
                                    )}
                                  </CopyButton>
                                )}
                              </Group>
                            </>
                          ) : (
                            <Text>
                              From the WhatsApp account where you want to
                              receive calls, call{" "}
                              <strong>{pairing.account_phone}</strong>. You do
                              not need to wait for an answer.
                            </Text>
                          )}
                          <Text size="sm" c="dimmed">
                            Waiting for your{" "}
                            {pairing.method === "message" ? "message" : "call"}…
                            Use a different account from the linked account.
                          </Text>
                        </>
                      )}
                      {pairing?.state === "candidate" && pairing.candidate && (
                        <Alert title="Is this your receiving number?">
                          <Stack gap="sm">
                            <Text fw={600}>{pairing.candidate.phone}</Text>
                            <Text size="sm">
                              Confirm only if this is the account where you want
                              VoxDock to call you.
                            </Text>
                            <Button
                              loading={busy}
                              disabled={!!pairing.error || !!poll.error}
                              onClick={() =>
                                void act(
                                  `${pairingPath}/${encodeURIComponent(pairing.id)}/confirm`,
                                  { candidate_id: pairing.candidate!.id },
                                )
                              }
                            >
                              Confirm this number
                            </Button>
                          </Stack>
                        </Alert>
                      )}
                      <Text size="xs" c="dimmed">
                        Expires{" "}
                        {new Date(pairing!.expires_at).toLocaleTimeString()}.
                        Closing this window cancels pairing. If you leave this
                        page, pairing remains open until it expires.
                      </Text>
                      <Button
                        variant="default"
                        disabled={busy}
                        onClick={() =>
                          void act(
                            `${pairingPath}/${encodeURIComponent(pairing!.id)}/cancel`,
                            {},
                          )
                        }
                      >
                        Cancel pairing
                      </Button>
                    </>
                  ) : (
                    <>
                      {pairing?.state === "expired" && (
                        <Alert color="orange">
                          Pairing expired. Start again for a new code.
                        </Alert>
                      )}
                      {pairing?.state === "cancelled" && (
                        <Text size="sm">
                          Pairing cancelled. Your saved receiving number has not
                          changed.
                        </Text>
                      )}
                      {pairing?.state === "failed" && (
                        <Failure error={new ApiError(409, pairing.error)} />
                      )}
                      <Text>
                        Verify the WhatsApp account where you want to receive
                        calls.
                      </Text>
                      <SegmentedControl
                        value={method}
                        onChange={(value) =>
                          setMethod(value as "message" | "call")
                        }
                        data={[
                          { value: "message", label: "Send a code" },
                          { value: "call", label: "Make a call" },
                        ]}
                      />
                      <Button
                        loading={busy}
                        disabled={!current.pairing_available}
                        onClick={() => void act(pairingPath, { method })}
                      >
                        {method === "message"
                          ? "Get pairing code"
                          : "Start call pairing"}
                      </Button>
                      <Text size="xs" c="dimmed">
                        You will review the detected number before saving it.
                      </Text>
                    </>
                  )}
                </>
              ))}
            </>
          )}
          <Button
            variant="subtle"
            disabled={busy || connectionBusy}
            onClick={() => void close()}
          >
            {activePairing(pairing) ||
            (connection && !connectionTerminal(connection))
              ? "Cancel and close"
              : "Close"}
          </Button>
        </Stack>
      </Modal>
    </Stack>
  );
}
