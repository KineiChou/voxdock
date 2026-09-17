import React, { lazy, Suspense, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { QueryClientProvider } from "@tanstack/react-query";
import {
  BrowserRouter,
  NavLink,
  Route,
  Routes,
  useLocation,
} from "react-router-dom";
import {
  AppShell,
  Burger,
  Button,
  Center,
  Group,
  MantineProvider,
  Paper,
  PasswordInput,
  Stack,
  Text,
  Title,
  createTheme,
} from "@mantine/core";
import {
  IconAdjustmentsHorizontal,
  IconArrowRight,
  IconChartBar,
  IconLogout,
  IconPhone,
  IconPlugConnected,
} from "@tabler/icons-react";
import type { ConsoleSession } from "../../../packages/contracts/src/console";
import { api, configureSession, queryClient } from "./api";
import { Failure, Loading } from "./shared";
const Overview = lazy(() =>
  import("./overview").then((m) => ({ default: m.Overview })),
);
const Calls = lazy(() => import("./calls").then((m) => ({ default: m.Calls })));
const CallDetail = lazy(() =>
  import("./calls").then((m) => ({ default: m.CallDetail })),
);
const Connections = lazy(() =>
  import("./configuration").then((m) => ({ default: m.Connections })),
);
const Settings = lazy(() =>
  import("./configuration").then((m) => ({ default: m.Settings })),
);
import "@mantine/core/styles.css";
import "@mantine/charts/styles.css";
import "./style.css";
const theme = createTheme({
  primaryColor: "teal",
  defaultRadius: "md",
  fontFamily:
    'Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
  headings: {
    fontFamily: "inherit",
    fontWeight: "600",
    sizes: {
      h1: { fontSize: "30px", lineHeight: "1.2" },
      h2: { fontSize: "26px" },
      h3: { fontSize: "16px" },
    },
  },
  colors: {
    teal: [
      "#edf9f5",
      "#d7f0e7",
      "#afe1d0",
      "#83d2b8",
      "#5ac3a1",
      "#3db78f",
      "#2aae85",
      "#1c9872",
      "#148661",
      "#087351",
    ],
  },
});
function Logo() {
  return (
    <Group gap={10}>
      <span className="brand-mark" aria-hidden="true">
        <i />
        <i />
        <i />
        <i />
        <i />
      </span>
      <Text size="xl" fw={700} lts={-0.6}>
        VoxDock
      </Text>
    </Group>
  );
}
function App() {
  const [session, setSession] = useState<ConsoleSession | null>(null);
  const [checking, setChecking] = useState(true);
  const [initialError, setInitialError] = useState<Error | null>(null);
  const clear = () => {
    configureSession(null, clear);
    queryClient.clear();
    setSession(null);
  };
  const accept = (value: ConsoleSession) => {
    configureSession(value, clear);
    setSession(value);
  };
  useEffect(() => {
    let active = true;
    api<ConsoleSession>("/session")
      .then((value) => {
        if (active) accept(value);
      })
      .catch((error) => {
        if (active && error.status !== 401) setInitialError(error);
      })
      .finally(() => {
        if (active) setChecking(false);
      });
    return () => {
      active = false;
    };
  }, []);
  if (checking) return <Loading />;
  return session ? (
    <Shell
      onLogout={async () => {
        await api("/session", { method: "DELETE" });
        clear();
      }}
    />
  ) : (
    <Login onLogin={accept} initialError={initialError} />
  );
}
function Login({
  onLogin,
  initialError,
}: {
  onLogin: (session: ConsoleSession) => void;
  initialError: Error | null;
}) {
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Error | null>(initialError);
  return (
    <div className="login">
      <div className="login-story">
        <Logo />
        <div>
          <Text className="eyebrow" c="teal.2" mb="lg">
            YOUR AGENT. ONE CALL AWAY.
          </Text>
          <h1>
            Keep the conversation
            <br />
            moving.
          </h1>
          <Text c="gray.4" maw={390} lh={1.8}>
            Your calls, conversations, and delegated work — together in one
            place.
          </Text>
        </div>
        <Text size="sm" c="gray.5">
          Let your agent call you.
        </Text>
      </div>
      <Center className="login-form">
        <Paper p="xl" w={410}>
          <Title order={1}>Welcome back</Title>
          <Text c="dimmed" mt="sm" mb="xl">
            Sign in to your VoxDock console.
          </Text>
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              setBusy(true);
              setError(null);
              try {
                const value = await api<ConsoleSession>("/session", {
                  method: "POST",
                  body: JSON.stringify({ password }),
                });
                setPassword("");
                onLogin(value);
              } catch (e) {
                setError(
                  new Error(
                    (e as { status?: number }).status === 401
                      ? "The password was not accepted. Try again."
                      : (e as Error).message,
                  ),
                );
              } finally {
                setBusy(false);
              }
            }}
          >
            <Stack>
              <PasswordInput
                label="Console password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete="current-password"
                required
                autoFocus
              />
              {error && <Failure error={error} />}
              <Button
                type="submit"
                loading={busy}
                rightSection={<IconArrowRight size={17} />}
                mt="sm"
              >
                Sign in
              </Button>
            </Stack>
          </form>
        </Paper>
      </Center>
    </div>
  );
}
const navigation = [
  { to: "/", label: "Overview", icon: IconChartBar },
  { to: "/calls", label: "Calls", icon: IconPhone },
  { to: "/connections", label: "Connections", icon: IconPlugConnected },
  { to: "/settings", label: "Settings", icon: IconAdjustmentsHorizontal },
];
function Shell({ onLogout }: { onLogout: () => Promise<void> }) {
  const [opened, setOpened] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const location = useLocation();
  useEffect(() => setOpened(false), [location.pathname]);
  return (
    <AppShell
      navbar={{ width: 230, breakpoint: "sm", collapsed: { mobile: !opened } }}
      header={{ height: 64 }}
      padding={{ base: 18, sm: 30, lg: 40 }}
    >
      <AppShell.Header className="topbar">
        <Group justify="space-between" h="100%" px="lg">
          <Group>
            <Burger
              opened={opened}
              onClick={() => setOpened((v) => !v)}
              hiddenFrom="sm"
              size="sm"
              aria-label="Toggle navigation"
            />
            <Text size="sm" fw={600}>
              Workspace
            </Text>
            <Text c="dimmed" size="sm">
              /
            </Text>
            <Text c="dimmed" size="sm">
              Console
            </Text>
          </Group>
          <Group gap={9}>
            <span className="avatar">V</span>
            <Text size="sm" fw={500}>
              Administrator
            </Text>
          </Group>
        </Group>
      </AppShell.Header>
      <AppShell.Navbar className="sidebar" p="md">
        <div className="brand">
          <Logo />
        </div>
        <Text className="eyebrow nav-caption">WORKSPACE</Text>
        <nav aria-label="Main navigation">
          {navigation.map(({ to, label, icon: Icon }) => (
            <NavLink
              key={to}
              to={to}
              end={to === "/"}
              className={({ isActive }) =>
                `nav-item ${isActive ? "active" : ""}`
              }
            >
              <Icon size={19} stroke={1.7} />
              {label}
            </NavLink>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <Text size="sm" fw={500}>
            Let your agent call you.
          </Text>
          <Text size="xs" c="gray.5" mt={5} mb="lg">
            VoxDock Console
          </Text>
          <Button
            variant="subtle"
            color="gray"
            fullWidth
            justify="flex-start"
            leftSection={<IconLogout size={17} />}
            onClick={() => {
              void onLogout().catch(setError);
            }}
          >
            Sign out
          </Button>
        </div>
      </AppShell.Navbar>
      <AppShell.Main>
        <div className="page">
          {error && <Failure error={error} />}
          <Suspense fallback={<Loading />}>
            <Routes>
              <Route path="/" element={<Overview />} />
              <Route path="/calls" element={<Calls />} />
              <Route
                path="/calls/:id"
                element={<CallDetail key={location.pathname} />}
              />
              <Route path="/connections" element={<Connections />} />
              <Route path="/settings" element={<Settings />} />
              <Route
                path="*"
                element={
                  <Center py={100}>
                    <Stack>
                      <Title order={2}>Page not found</Title>
                      <Button component={NavLink} to="/">
                        Go to overview
                      </Button>
                    </Stack>
                  </Center>
                }
              />
            </Routes>
          </Suspense>
        </div>
      </AppShell.Main>
    </AppShell>
  );
}
createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <MantineProvider theme={theme}>
      <QueryClientProvider client={queryClient}>
        <BrowserRouter basename="/console">
          <App />
        </BrowserRouter>
      </QueryClientProvider>
    </MantineProvider>
  </React.StrictMode>,
);
