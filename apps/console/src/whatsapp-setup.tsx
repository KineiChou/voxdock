import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  Accordion,
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
  async function close() {
    setBusy(true);
    setError(null);
    try {
      if (activePairing(pairing))
        await api(`${pairingPath}/${encodeURIComponent(pairing!.id)}/cancel`, {
          method: "POST",
          body: "{}",
        });
      if (
        !setup.data?.connected &&
        connection &&
        !connectionTerminal(connection)
      )
        await api(
          `/connections/flows/${encodeURIComponent(connection.id)}/cancel`,
          { method: "POST", body: "{}" },
        );
      await queryClient.cancelQueries({ queryKey: ["target-pairing"] });
      queryClient.removeQueries({ queryKey: ["target-pairing"] });
      setPairing(null);
      setConnection(null);
      setOpened(false);
      await refresh();
    } catch (cause) {
      setError(cause as Error);
    } finally {
      setBusy(false);
    }
  }
  const current = setup.data;
  return (
    <Stack mt="lg" gap="sm">
      {setup.error && (
        <Failure error={setup.error} retry={() => void setup.refetch()} />
      )}
      {current && (
        <Fields
          rows={[
            ["Connected number", current.account_phone ?? "Not connected"],
            ["Receive calls at", current.target?.phone ?? "Not paired"],
            [
              "Receiving calls",
              current.target?.enabled ? "Enabled" : "Disabled",
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
                active={
                  !current.connected
                    ? 0
                    : pairing?.state === "completed"
                      ? 2
                      : 1
                }
                size="sm"
              >
                <Stepper.Step label="Link account" />
                <Stepper.Step label="Pair your number" />
              </Stepper>
              {!current.connected ? (
                <>
                  <Text>
                    Link the WhatsApp account VoxDock will use to call you. Your
                    receiving phone must use a different WhatsApp account.
                  </Text>
                  <ConnectionLogin
                    channel="whatsapp"
                    authenticated={false}
                    onFlowChange={setConnection}
                    onBusyChange={setConnectionBusy}
                  />
                </>
              ) : (
                <>
                  <Text size="sm">
                    Calling from{" "}
                    <strong>
                      {current.account_phone ?? "your linked account"}
                    </strong>
                  </Text>
                  {current.target && (
                    <Text size="sm">
                      Current receiving number:{" "}
                      <strong>{current.target.phone}</strong>. It stays in place
                      until you confirm a replacement.
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
                  {!activePairing(pairing) && (
                    <Accordion variant="separated">
                      <Accordion.Item value="account">
                        <Accordion.Control>Linked account</Accordion.Control>
                        <Accordion.Panel>
                          <ConnectionLogin
                            channel="whatsapp"
                            authenticated={true}
                            onBusyChange={setConnectionBusy}
                          />
                        </Accordion.Panel>
                      </Accordion.Item>
                    </Accordion>
                  )}
                </>
              )}
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
