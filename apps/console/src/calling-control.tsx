import { useState } from "react";
import { Button, Group, Modal, Stack, Text } from "@mantine/core";
import { IconPlayerPause, IconPlayerPlay } from "@tabler/icons-react";
import type { ConsoleSettings } from "../../../packages/contracts/src/console";
import { api, queryClient } from "./api";
import { Failure, Status } from "./shared";
export function CallingControl({ settings }: { settings: ConsoleSettings }) {
  const [action, setAction] = useState<"pause" | "resume" | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  async function apply() {
    setBusy(true);
    setError(null);
    try {
      await api(`/control/${action}`, { method: "POST", body: "{}" });
      await queryClient.invalidateQueries();
      setAction(null);
    } catch (e) {
      setError(e as Error);
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <Group gap="sm">
        <Status
          value={
            settings.calling.accepting_calls
              ? "ready"
              : settings.calling.paused
                ? "paused"
                : "disabled"
          }
        />
        <Button
          variant="default"
          leftSection={
            settings.calling.paused ? (
              <IconPlayerPlay size={16} />
            ) : (
              <IconPlayerPause size={16} />
            )
          }
          disabled={settings.calling.paused && !settings.calling.can_resume}
          onClick={() => {
            setError(null);
            setAction(settings.calling.paused ? "resume" : "pause");
          }}
        >
          {settings.calling.paused ? "Resume calling" : "Pause calling"}
        </Button>
      </Group>
      {settings.calling.paused && settings.calling.resume_blocked_reason && (
        <Text size="sm" c="dimmed">
          {settings.calling.resume_blocked_reason}
        </Text>
      )}
      <Modal
        opened={action !== null}
        onClose={() => !busy && setAction(null)}
        title={action === "pause" ? "Pause calling?" : "Resume calling?"}
        centered
      >
        <Stack>
          <Text size="sm">
            {action === "pause"
              ? "New calls will be paused. Calls already in progress are not ended by this action."
              : "Allow new calls using the currently applied settings."}
          </Text>
          {error && <Failure error={error} />}
          <Group justify="flex-end">
            <Button
              variant="default"
              disabled={busy}
              onClick={() => setAction(null)}
            >
              Cancel
            </Button>
            <Button loading={busy} onClick={apply}>
              {action === "pause" ? "Pause calling" : "Resume calling"}
            </Button>
          </Group>
        </Stack>
      </Modal>
    </>
  );
}
