import type { OpenClawPluginApi } from "openclaw/plugin-sdk";

// --- Types ---

type PresenceState = "present" | "away" | "returned";

type RuViewPerson = {
  id: number;
  confidence: number;
  zone?: string;
  bbox?: Record<string, number>;
};

type RuViewPoseResponse = {
  timestamp: number;
  source: string;
  total_persons: number;
  persons: RuViewPerson[];
};

type RuViewZoneSummary = {
  zones: Record<string, { person_count: number; status: string }>;
};

type QueuedEvent = {
  type: "message" | "task" | "notification" | "error";
  summary: string;
  channel?: string;
  priority?: "normal" | "urgent";
  timestamp: number;
};

type PluginConfig = {
  ruviewUrl: string;
  pollIntervalMs: number;
  confidenceThreshold: number;
  debounceCount: number;
  enableDigest: boolean;
  enableZoneAwareness: boolean;
};

// --- State ---

let currentState: PresenceState = "present";
let previousState: PresenceState = "present";
let awaySince: number | null = null;
let emptyCheckCount = 0;
let currentZone: string | null = null;
let eventQueue: QueuedEvent[] = [];
let lastPollTime = 0;

// --- Helpers ---

function resolveConfig(input: unknown): PluginConfig {
  const cfg = (input ?? {}) as Partial<PluginConfig>;
  return {
    ruviewUrl: cfg.ruviewUrl ?? process.env.RUVIEW_API_URL ?? "http://localhost:3000",
    pollIntervalMs: cfg.pollIntervalMs ?? 10000,
    confidenceThreshold: cfg.confidenceThreshold ?? 0.3,
    debounceCount: cfg.debounceCount ?? 2,
    enableDigest: cfg.enableDigest ?? true,
    enableZoneAwareness: cfg.enableZoneAwareness ?? false,
  };
}

async function fetchJson<T>(url: string, timeoutMs = 5000): Promise<T | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function checkPresence(config: PluginConfig): Promise<{
  detected: boolean;
  zone: string | null;
  persons: number;
}> {
  const data = await fetchJson<RuViewPoseResponse>(`${config.ruviewUrl}/api/v1/pose/current`);
  if (!data) {
    return { detected: false, zone: null, persons: 0 };
  }

  const validPersons = data.persons.filter((p) => p.confidence >= config.confidenceThreshold);
  const detected = validPersons.length > 0;
  const zone = detected ? (validPersons[0]?.zone ?? null) : null;

  return { detected, zone, persons: validPersons.length };
}

async function checkZones(config: PluginConfig): Promise<RuViewZoneSummary | null> {
  if (!config.enableZoneAwareness) return null;
  return fetchJson<RuViewZoneSummary>(`${config.ruviewUrl}/api/v1/pose/zones/summary`);
}

function formatDuration(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return remainingMinutes > 0 ? `${hours}h ${remainingMinutes}m` : `${hours}h`;
}

function buildDigest(): string {
  if (eventQueue.length === 0) {
    return "";
  }

  const byType: Record<string, number> = {};
  const byChannel: Record<string, number> = {};
  let urgentCount = 0;

  for (const event of eventQueue) {
    byType[event.type] = (byType[event.type] ?? 0) + 1;
    if (event.channel) {
      byChannel[event.channel] = (byChannel[event.channel] ?? 0) + 1;
    }
    if (event.priority === "urgent") {
      urgentCount++;
    }
  }

  const duration = awaySince ? formatDuration(Date.now() - awaySince) : "unknown";
  const lines: string[] = [`Welcome back! You were away for ${duration}.`, "", "While you were away:"];

  if (byType.message) {
    const channels = Object.entries(byChannel)
      .map(([ch, n]) => `${ch}: ${n}`)
      .join(", ");
    lines.push(`- ${byType.message} message(s) queued${channels ? ` (${channels})` : ""}`);
  }
  if (byType.task) {
    lines.push(`- ${byType.task} task(s) updated`);
  }
  if (byType.notification) {
    lines.push(`- ${byType.notification} notification(s)`);
  }
  if (byType.error) {
    lines.push(`- ${byType.error} error(s) encountered`);
  }
  if (urgentCount > 0) {
    lines.push(`- ${urgentCount} urgent item(s) were sent immediately`);
  }

  lines.push("", "Ready when you are.");
  return lines.join("\n");
}

// --- Public API for skill/agent use ---

export function getPresenceState(): {
  state: PresenceState;
  zone: string | null;
  awaySince: number | null;
  queuedEvents: number;
} {
  return {
    state: currentState,
    zone: currentZone,
    awaySince,
    queuedEvents: eventQueue.length,
  };
}

export function queueEvent(event: Omit<QueuedEvent, "timestamp">): void {
  if (currentState === "away") {
    eventQueue.push({ ...event, timestamp: Date.now() });
  }
}

export function flushQueue(): QueuedEvent[] {
  const flushed = [...eventQueue];
  eventQueue = [];
  return flushed;
}

// --- Plugin ---

const ruviewPresencePlugin = {
  id: "ruview-presence",
  name: "RuView Presence",
  description:
    "Presence-aware agent behavior powered by RuView WiFi sensing. Detects user presence via WiFi CSI and adapts agent behavior.",

  register(api: OpenClawPluginApi) {
    const config = resolveConfig(api.pluginConfig);

    api.logger.info?.(`ruview-presence: initialized (url=${config.ruviewUrl}, threshold=${config.confidenceThreshold})`);

    // Hook into each heartbeat cycle
    api.on("before_prompt_build", async () => {
      const now = Date.now();
      if (now - lastPollTime < config.pollIntervalMs) {
        return; // throttle — skip if polled recently
      }
      lastPollTime = now;

      const presence = await checkPresence(config);
      previousState = currentState;

      if (!presence.detected) {
        // No one detected
        emptyCheckCount++;
        if (emptyCheckCount >= config.debounceCount && currentState !== "away") {
          currentState = "away";
          awaySince = Date.now();
          api.logger.info?.(`ruview-presence: user away since ${new Date(awaySince).toISOString()}`);
        }
      } else {
        // Person detected
        emptyCheckCount = 0;
        currentZone = presence.zone;

        if (currentState === "away") {
          currentState = "returned";
          api.logger.info?.(
            `ruview-presence: user returned (was away for ${formatDuration(Date.now() - (awaySince ?? now))})`,
          );
        } else {
          currentState = "present";
        }
      }

      // Fetch zone data if enabled
      if (config.enableZoneAwareness && presence.detected) {
        await checkZones(config);
      }

      // On return, inject digest into context
      if (currentState === "returned" && config.enableDigest && eventQueue.length > 0) {
        const digest = buildDigest();
        flushQueue();
        currentState = "present";
        awaySince = null;

        if (digest) {
          return {
            prependContext: digest,
          };
        }
      }

      // On return with no queued events, just reset
      if (currentState === "returned") {
        currentState = "present";
        awaySince = null;
      }

      return undefined;
    });

    // Register a gateway RPC method so agents can query presence
    api.registerGatewayMethod?.("ruview.presence", async () => {
      return getPresenceState();
    });

    // Register a gateway RPC method to queue events
    api.registerGatewayMethod?.("ruview.queueEvent", async (params: unknown) => {
      const event = params as Omit<QueuedEvent, "timestamp">;
      queueEvent(event);
      return { queued: true, total: eventQueue.length };
    });
  },
};

export default ruviewPresencePlugin;
