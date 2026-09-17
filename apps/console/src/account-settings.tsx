import { useState } from "react";
import {
  Alert,
  Button,
  PasswordInput,
  Stack,
  Switch,
  TextInput,
} from "@mantine/core";
import { api, endSession, useResource } from "./api";
import { Failure, Loading, Panel } from "./shared";
type Account = {
  username: string;
  revision: number;
  allow_remote_management: boolean;
};
export function AccountSettings() {
  const query = useResource<Account>("/account");
  return (
    <Panel title="Administrator account">
      {query.isPending ? (
        <Loading />
      ) : query.error ? (
        <Failure error={query.error} />
      ) : (
        query.data && <AccountForm initial={query.data} />
      )}
    </Panel>
  );
}
function AccountForm({ initial }: { initial: Account }) {
  const [account, setAccount] = useState(initial);
  const [password, setPassword] = useState("");
  const [nextPassword, setNextPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const [saved, setSaved] = useState(false);
  return (
    <form
      onSubmit={async (event) => {
        event.preventDefault();
        setBusy(true);
        setError(null);
        setSaved(false);
        try {
          const result = await api<{
            account: Account;
            login_required: boolean;
          }>("/account", {
            method: "PUT",
            body: JSON.stringify({
              ...account,
              current_password: password,
              ...(nextPassword ? { new_password: nextPassword } : {}),
            }),
          });
          setAccount(result.account);
          setPassword("");
          setNextPassword("");
          setSaved(true);
          if (result.login_required) endSession();
        } catch (error) {
          setError(error as Error);
        } finally {
          setBusy(false);
        }
      }}
    >
      <Stack>
        <TextInput
          label="Username"
          autoComplete="username"
          value={account.username}
          onChange={(event) => {
            setAccount({ ...account, username: event.currentTarget.value });
            setSaved(false);
          }}
          pattern="[A-Za-z0-9][A-Za-z0-9_.-]{0,63}"
          required
        />
        <PasswordInput
          label="New password"
          description="Leave blank to keep your password. Changing credentials signs you out."
          value={nextPassword}
          onChange={(event) => setNextPassword(event.currentTarget.value)}
          minLength={12}
          maxLength={256}
          autoComplete="new-password"
        />
        <Switch
          label="Allow remote management"
          description="When off, change settings and connections from the server itself. Calls and call history remain available."
          checked={account.allow_remote_management}
          onChange={(event) => {
            setAccount({
              ...account,
              allow_remote_management: event.currentTarget.checked,
            });
            setSaved(false);
          }}
        />
        {!account.allow_remote_management && (
          <Alert color="orange">
            Saving this setting will block Settings and Connections management
            from other devices. You can re-enable it locally on the server.
          </Alert>
        )}
        <PasswordInput
          label="Current password"
          description="Confirm your password to save account settings."
          value={password}
          onChange={(event) => setPassword(event.currentTarget.value)}
          required
          autoComplete="current-password"
        />
        {error && <Failure error={error} />}
        {saved && <Alert color="teal">Account settings saved.</Alert>}
        <Button type="submit" loading={busy}>
          Save account settings
        </Button>
      </Stack>
    </form>
  );
}
