import { useState } from "react";
import { useInfiniteQuery } from "@tanstack/react-query";
import { Link, useParams } from "react-router-dom";
import {
  Alert,
  Anchor,
  Badge,
  Button,
  Group,
  Modal,
  Select,
  SimpleGrid,
  Stack,
  Tabs,
  Text,
  TextInput,
  Timeline,
} from "@mantine/core";
import type {
  ConsoleCallDetail,
  ConsoleCallPage,
  ConsoleTranscriptPage,
} from "../../../packages/contracts/src/console";
import { api, exportCall, queryClient, useResource } from "./api";
import {
  CallsTable,
  date,
  Empty,
  Failure,
  Fields,
  label,
  Loading,
  PageTitle,
  Panel,
  seconds,
  Status,
} from "./shared";
export function Calls() {
  const [filters, setFilters] = useState<Record<string, string>>({});
  const [cursors, setCursors] = useState<string[]>([]);
  const params = new URLSearchParams({
    ...filters,
    limit: "25",
    ...(cursors.length ? { cursor: cursors[cursors.length - 1] } : {}),
  });
  const query = useResource<ConsoleCallPage>(`/calls?${params}`);
  const change = (name: string, value: string | null) => {
    setFilters((current) => {
      const next = { ...current };
      if (value) next[name] = value;
      else delete next[name];
      return next;
    });
    setCursors([]);
  };
  return (
    <>
      <PageTitle
        title="Calls"
        description="Review call outcomes, conversation fragments, and delegated work."
      />
      <Panel
        title="Call history"
        aside={
          <Text size="sm" c="dimmed">
            {query.data?.total.toLocaleString() ?? "—"} calls
          </Text>
        }
      >
        <SimpleGrid cols={{ base: 1, sm: 2, lg: 5 }} mb="lg">
          <Select
            label="Channel"
            placeholder="All channels"
            clearable
            value={filters.channel ?? null}
            onChange={(v) => change("channel", v)}
            data={[
              { value: "telegram", label: "Telegram" },
              { value: "whatsapp", label: "WhatsApp" },
              { value: "unknown", label: "Unknown" },
            ]}
          />
          <Select
            label="Direction"
            placeholder="Any direction"
            clearable
            value={filters.direction ?? null}
            onChange={(v) => change("direction", v)}
            data={["inbound", "outbound"].map((value) => ({
              value,
              label: label(value),
            }))}
          />
          <Select
            label="State"
            placeholder="Any state"
            clearable
            value={filters.state ?? null}
            onChange={(v) => change("state", v)}
            data={[
              "requested",
              "dialing",
              "ringing",
              "connected",
              "ending",
              "ended",
              "uncertain",
            ].map((value) => ({ value, label: label(value) }))}
          />
          <TextInput
            label="From"
            type="datetime-local"
            onChange={(e) =>
              change(
                "from",
                e.target.value ? new Date(e.target.value).toISOString() : null,
              )
            }
          />
          <TextInput
            label="To"
            type="datetime-local"
            onChange={(e) =>
              change(
                "to",
                e.target.value ? new Date(e.target.value).toISOString() : null,
              )
            }
          />
        </SimpleGrid>
        {query.isPending ? (
          <Loading />
        ) : query.error ? (
          <Failure error={query.error} retry={() => void query.refetch()} />
        ) : (
          query.data && <CallsTable calls={query.data.items} />
        )}
        <Group justify="space-between" mt="lg">
          <Text size="xs" c="dimmed">
            Page {cursors.length + 1}
          </Text>
          <Group>
            <Button
              variant="default"
              disabled={!cursors.length || query.isFetching}
              onClick={() => setCursors((c) => c.slice(0, -1))}
            >
              Previous
            </Button>
            <Button
              variant="default"
              disabled={!query.data?.next_cursor || query.isFetching}
              onClick={() => {
                if (query.data?.next_cursor)
                  setCursors((c) => [...c, query.data.next_cursor!]);
              }}
            >
              Next
            </Button>
          </Group>
        </Group>
      </Panel>
    </>
  );
}
function safeUrl(value: string) {
  try {
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol) ? url.href : null;
  } catch {
    return null;
  }
}
export function CallDetail() {
  const { id = "" } = useParams();
  const path = `/calls/${encodeURIComponent(id)}`;
  const query = useResource<ConsoleCallDetail>(path);
  const [endOpen, setEndOpen] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);
  const [format, setFormat] = useState("json");
  const [privacy, setPrivacy] = useState("redacted");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const [accepted, setAccepted] = useState(false);
  async function end() {
    setBusy(true);
    setError(null);
    try {
      await api(`${path}/end`, { method: "POST", body: "{}" });
      setAccepted(true);
      setEndOpen(false);
      await queryClient.invalidateQueries();
    } catch (e) {
      setError(e as Error);
    } finally {
      setBusy(false);
    }
  }
  async function download() {
    setBusy(true);
    setError(null);
    try {
      await exportCall(id, format, privacy === "redacted");
      setExportOpen(false);
    } catch (e) {
      setError(e as Error);
    } finally {
      setBusy(false);
    }
  }
  const data = query.data;
  return (
    <>
      <PageTitle
        title="Call detail"
        description={id}
        action={
          <Group>
            <Button component={Link} to="/calls" variant="default">
              Back to calls
            </Button>
            <Button
              variant="default"
              onClick={() => {
                setPrivacy("redacted");
                setError(null);
                setExportOpen(true);
              }}
            >
              Export
            </Button>
            <Button
              color="red"
              variant="light"
              disabled={!data?.summary.can_end}
              onClick={() => {
                setError(null);
                setEndOpen(true);
              }}
            >
              End call
            </Button>
          </Group>
        }
      />
      {accepted && (
        <Alert color="teal" mb="lg">
          End request accepted. The latest call status below confirms whether
          the call has ended.
        </Alert>
      )}
      {query.isPending ? (
        <Loading />
      ) : query.error ? (
        <Failure error={query.error} />
      ) : (
        data && (
          <Stack gap="lg">
            <Panel
              title="Call record"
              aside={<Status value={data.summary.call.state} />}
            >
              <Fields
                rows={[
                  ["Target", data.summary.call.target_id],
                  ["Channel", label(data.summary.channel ?? "unknown")],
                  ["Direction", label(data.summary.call.direction)],
                  ["Started", date(data.summary.call.created_at)],
                  [
                    "Connected",
                    data.summary.connected_at
                      ? date(data.summary.connected_at)
                      : "Unknown",
                  ],
                  [
                    "Ended",
                    data.summary.ended_at
                      ? date(data.summary.ended_at)
                      : "Not recorded",
                  ],
                  ["Recorded call interval", seconds(data.summary.duration_seconds)],
                  [
                    "Audio",
                    data.summary.call.audio_ready ? "Ready" : "Not ready",
                  ],
                  [
                    "Live",
                    data.summary.call.live_ready ? "Ready" : "Not ready",
                  ],
                  ["Reason", data.summary.call.reason ?? "—"],
                  ["Context reference", data.summary.call.context_ref],
                  ["Correlation reference", data.summary.call.correlation_ref],
                  [
                    "Live usage",
                    data.summary.usage
                      ? `${seconds(data.summary.usage.seconds)} · ${label(data.summary.usage.status)}`
                      : "Unknown",
                  ],
                ]}
              />
            </Panel>
            <Tabs defaultValue="conversation">
              <Tabs.List mb="lg">
                <Tabs.Tab value="conversation">Conversation</Tabs.Tab>
                <Tabs.Tab value="delegations">
                  Delegations ({data.delegations.length})
                </Tabs.Tab>
                <Tabs.Tab value="timeline">Event timeline</Tabs.Tab>
              </Tabs.List>
              <Tabs.Panel value="conversation">
                <Transcripts id={id} />
              </Tabs.Panel>
              <Tabs.Panel value="delegations">
                <Panel title="Delegated work">
                  {!data.delegations.length ? (
                    <Empty
                      title="No delegations"
                      text="Delegated work and returned results appear here."
                    />
                  ) : (
                    <Stack>
                      {data.delegations.map((item) => (
                        <div className="record-block" key={item.delegation_id}>
                          <Group justify="space-between">
                            <Text fw={600} size="sm">
                              {item.delegation_id}
                            </Text>
                            <Status
                              value={item.latest_result?.status ?? "pending"}
                            />
                          </Group>
                          <Text size="xs" c="dimmed" mt={6}>
                            {date(item.occurred_at)} · Context revision{" "}
                            {item.context_revision} · {label(item.completeness)}
                          </Text>
                          <Text mt="sm" size="sm" className="preserve-text">
                            {item.latest_result?.spoken_summary ??
                              "Waiting for a result."}
                          </Text>
                          {item.latest_result?.business_ref && (
                            <Text mt="sm" size="xs">
                              Reference: {item.latest_result.business_ref}
                            </Text>
                          )}
                          {item.latest_result?.evidence_urls?.map(
                            (url, index) => {
                              const safe = safeUrl(url);
                              return safe ? (
                                <Anchor
                                  display="block"
                                  mt={8}
                                  key={index}
                                  href={safe}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                >
                                  Evidence {index + 1}
                                </Anchor>
                              ) : null;
                            },
                          )}
                        </div>
                      ))}
                    </Stack>
                  )}
                </Panel>
              </Tabs.Panel>
              <Tabs.Panel value="timeline">
                <Panel title="Event timeline">
                  {!data.events.length ? (
                    <Empty title="No events recorded" />
                  ) : (
                    <Timeline bulletSize={12} lineWidth={2}>
                      {data.events.map((event) => (
                        <Timeline.Item
                          key={event.event_id}
                          title={label(event.type)}
                        >
                          <Text size="sm" c="dimmed">
                            {date(event.occurred_at)} ·{" "}
                            {label(event.call.state)}
                          </Text>
                          {event.call.reason && (
                            <Text size="sm" mt={5}>
                              {event.call.reason}
                            </Text>
                          )}
                        </Timeline.Item>
                      ))}
                    </Timeline>
                  )}
                </Panel>
              </Tabs.Panel>
            </Tabs>
          </Stack>
        )
      )}
      <Modal
        opened={endOpen}
        onClose={() => !busy && setEndOpen(false)}
        title="Request to end this call?"
        centered
      >
        <Stack>
          <Text size="sm">
            VoxDock will request that this call ends. Review its status
            afterward to confirm the outcome.
          </Text>
          {error && <Failure error={error} />}
          <Group justify="flex-end">
            <Button
              variant="default"
              disabled={busy}
              onClick={() => setEndOpen(false)}
            >
              Cancel
            </Button>
            <Button color="red" loading={busy} onClick={end}>
              Request end
            </Button>
          </Group>
        </Stack>
      </Modal>
      <Modal
        opened={exportOpen}
        onClose={() => !busy && setExportOpen(false)}
        title="Export call record"
        centered
      >
        <Stack>
          <Select
            label="Format"
            value={format}
            allowDeselect={false}
            onChange={(v) => setFormat(v!)}
            data={[
              { value: "json", label: "JSON" },
              { value: "html", label: "HTML report" },
            ]}
          />
          <Select
            label="Privacy"
            value={privacy}
            allowDeselect={false}
            onChange={(v) => setPrivacy(v!)}
            data={[
              { value: "redacted", label: "Redacted export" },
              {
                value: "private",
                label: "Private export — includes sensitive content",
              },
            ]}
          />
          {privacy === "private" && (
            <Alert color="orange">
              This file can include private conversation content and
              identifiers. Share it only with trusted recipients.
            </Alert>
          )}
          {error && <Failure error={error} />}
          <Button onClick={download} loading={busy}>
            Download export
          </Button>
        </Stack>
      </Modal>
    </>
  );
}
function Transcripts({ id }: { id: string }) {
  const query = useInfiniteQuery({
    queryKey: ["transcripts", id],
    initialPageParam: null as string | null,
    queryFn: ({ pageParam, signal }) =>
      api<ConsoleTranscriptPage>(
        `/calls/${encodeURIComponent(id)}/transcripts?limit=100${pageParam ? `&cursor=${encodeURIComponent(pageParam)}` : ""}`,
        { signal },
      ),
    getNextPageParam: (last) => last.next_cursor ?? undefined,
    refetchInterval: () =>
      document.visibilityState === "visible" ? 10_000 : false,
    refetchIntervalInBackground: false,
  });
  return (
    <Panel
      title="Conversation fragments"
      aside={
        <Text size="xs" c="dimmed">
          Each fragment is shown as recorded
        </Text>
      }
    >
      {query.isPending ? (
        <Loading />
      ) : query.error ? (
        <Failure error={query.error} retry={() => void query.refetch()} />
      ) : (
        <Stack>
          {query.data?.pages[0].availability !== "available" && (
            <Empty
              title={
                query.data?.pages[0].availability === "disabled"
                  ? "Conversation capture is disabled"
                  : query.data?.pages[0].availability === "expired"
                    ? "Conversation records have expired"
                    : "No conversation fragments"
              }
              text="Available fragments will appear here according to your retention settings."
            />
          )}
          {query.data?.pages.map((page, pageIndex) => (
            <div key={pageIndex}>
              {page.fragments.map((fragment) => (
                <div
                  className={`fragment ${fragment.speaker}`}
                  key={fragment.id}
                >
                  <Group justify="space-between">
                    <Text size="sm" fw={600}>
                      {fragment.speaker === "user" ? "You" : "Assistant"}
                    </Text>
                    <Group gap={6}>
                      <Text size="xs" c="dimmed">
                        {seconds(fragment.start_ms / 1000)}
                      </Text>
                      <Badge
                        variant="light"
                        color={fragment.final ? "gray" : "orange"}
                        size="xs"
                      >
                        {fragment.final ? "Final fragment" : "Partial fragment"}
                      </Badge>
                    </Group>
                  </Group>
                  <Text size="sm" mt={8} className="preserve-text">
                    {fragment.text}
                  </Text>
                  <Text size="xs" c="dimmed" mt={8}>
                    Context revision {fragment.context_revision} · Fragment{" "}
                    {fragment.seq}
                  </Text>
                </div>
              ))}
            </div>
          ))}
          {query.hasNextPage && (
            <Button
              variant="default"
              loading={query.isFetchingNextPage}
              onClick={() => void query.fetchNextPage()}
            >
              Load more fragments
            </Button>
          )}
        </Stack>
      )}
    </Panel>
  );
}
