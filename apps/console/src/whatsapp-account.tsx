import { Alert, Badge, Button, Group, Paper, Stack, Text } from "@mantine/core";

export function WhatsAppAccount({
  phone,
  connected,
  unlinkPending,
  disabled,
  confirming,
  busy,
  onConfirmChange,
  onUnlink,
}: {
  phone: string | null;
  connected: boolean;
  unlinkPending: boolean;
  disabled: boolean;
  confirming: boolean;
  busy: boolean;
  onConfirmChange: (value: boolean) => void;
  onUnlink: () => void;
}) {
  return (
    <Paper withBorder p="md" radius="md">
      <Stack gap="sm">
        <Group justify="space-between" align="flex-start">
          <div>
            <Text size="sm" c="dimmed">Calling account</Text>
            <Text fw={600}>{phone ?? "WhatsApp account"}</Text>
          </div>
          <Badge color={unlinkPending ? "orange" : connected ? "teal" : "gray"} variant="light">
            {unlinkPending ? "Needs attention" : connected ? "Connected" : "Offline"}
          </Badge>
        </Group>
        {!connected && !unlinkPending && (
          <Text size="sm" c="dimmed">
            This server is still linked to your account. Reconnect to continue
            setting up calls, or unlink to start again with a QR code.
          </Text>
        )}
        {confirming ? (
          <Alert color="red" title={unlinkPending ? "Finish unlinking this account?" : "Unlink this WhatsApp account?"}>
            <Stack gap="sm">
              <Text size="sm">
                {unlinkPending
                  ? "This completes sign-out and clears this server device’s saved login. Your receiving number stays disabled."
                  : "This signs out this server device and turns off your receiving number."}{" "}
                Your call history stays available. To use WhatsApp again, scan a
                new QR code and verify your receiving number.
              </Text>
              <Group>
                <Button
                  data-autofocus
                  autoFocus
                  variant="default"
                  disabled={busy}
                  onClick={() => onConfirmChange(false)}
                >
                  Cancel
                </Button>
                <Button
                  color="red"
                  variant="outline"
                  disabled={disabled}
                  loading={busy}
                  onClick={onUnlink}
                >
                  {unlinkPending ? "Confirm finish unlinking" : "Confirm unlink"}
                </Button>
              </Group>
            </Stack>
          </Alert>
        ) : (
          <Group justify="space-between" align="center">
            <Text size="sm" c="dimmed">
              {unlinkPending ? "Finish signing out before linking an account again." : "Start over or change the calling account."}
            </Text>
            <Button
              color="red"
              variant="outline"
              size="xs"
              disabled={disabled}
              onClick={() => onConfirmChange(true)}
            >
              {unlinkPending ? "Finish unlinking" : "Unlink account"}
            </Button>
          </Group>
        )}
      </Stack>
    </Paper>
  );
}
