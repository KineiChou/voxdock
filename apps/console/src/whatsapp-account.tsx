import { Alert, Badge, Button, Group, Paper, Stack, Text } from "@mantine/core";

export function WhatsAppAccount({
  phone,
  connected,
  disabled,
  confirming,
  busy,
  onConfirmChange,
  onUnlink,
}: {
  phone: string | null;
  connected: boolean;
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
            <Text fw={600}>{phone ?? "Linked WhatsApp account"}</Text>
          </div>
          <Badge color={connected ? "teal" : "gray"} variant="light">
            {connected ? "Connected" : "Offline"}
          </Badge>
        </Group>
        {!connected && (
          <Text size="sm" c="dimmed">
            This server is still linked to your account. Reconnect to continue
            setting up calls, or unlink to start again with a QR code.
          </Text>
        )}
        {confirming ? (
          <Alert color="red" title="Unlink this WhatsApp account?">
            <Stack gap="sm">
              <Text size="sm">
                This signs out this server device and turns off your receiving
                number. Your call history stays available. To use WhatsApp again,
                scan a new QR code and verify your receiving number.
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
                  Confirm unlink
                </Button>
              </Group>
            </Stack>
          </Alert>
        ) : (
          <Group justify="space-between" align="center">
            <Text size="sm" c="dimmed">Start over or change the calling account.</Text>
            <Button
              color="red"
              variant="outline"
              size="xs"
              disabled={disabled}
              onClick={() => onConfirmChange(true)}
            >
              Unlink account
            </Button>
          </Group>
        )}
      </Stack>
    </Paper>
  );
}
