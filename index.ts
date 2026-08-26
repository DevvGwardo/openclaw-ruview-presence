import type { OpenClawPluginApi } from "openclaw/plugin-sdk";

declare const process: { env: Record<string, string | undefined> } | undefined;

// --- Types (matching actual RuView API responses) ---
type PresenceState = "present" | "away" | "returned";

type RuViewKeypoint = {
  name: string;
  confidence: number;
  x: number;
  y: number;
  z: number;
};

type RuViewBbox = {
  x: number;
  y: number;
  width: number;
  height: number;
};

type RuViewPerson = {
  id: number;
  confidence: number;
  zone?: string;
  bbox?: RuViewBbox;
  keypoints?: RuViewKeypoint[];
};

type RuViewPoseResponse = {
  timestamp: number;
  source: string; // "simulate" | "simulated" | "csi" | "esp32"
  total_persons: number;
  persons: RuViewPerson[];
};

type RuViewZoneInfo = {
  person_count: number;
  status: string; // "monitored" | "clear"
};

type RuViewZoneSummary = {
  zones: Record<string, RuViewZoneInfo>;
};

type RuViewVitalSigns = {
  vital_signs: {
    breathing_rate_bpm: number | null;
    breathing_confidence: number;
    heart_rate_bpm: number | null;
    heartbeat_confidence: number;
    signal_quality: number;
  };
  source: string;
  tick: number;
  buffer_status: {
    breathing_samples: number;
    breathing_capacity: number;
    heartbeat_samples: number;
    heartbeat_capacity: number;
  };
};

type RuViewSensingClassification = {
  presence: boolean;
  motion_level: string; // "present_still" | "present_moving" | "active" | "absent"
  confidence: number;
};

type RuViewSensingLatest = {
  timestamp: number;
  source: string;
  type: string;
  tick: number;
  estimated_persons: number;
  classification: RuViewSensingClassification;
  persons: RuViewPerson[];
  vital_signs: RuViewVitalSigns["vital_signs"];
  features: {
    mean_rssi: number;
    variance: number;
    spectral_power: number;
    dominant_freq_hz: number;
    breathing_band_power: number;
    motion_band_power: number;
    change_points: number;
  };
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
  apiKey?: string;
  pollIntervalMs: number;
  confidenceThreshold: number;
  debounceCount: number;
  enableDigest: boolean;
  enableZoneAwareness: boolean;
  maxQueueSize: number;
  staleThresholdMs: number;
};

// --- State ---
let currentState: PresenceState = "present";
let previousState: PresenceState = "present";
let awaySince: number | null = null;
let emptyCheckCount = 0;
let currentZone: string | null = null;
let lastDetectedPersons = 0;
let lastSource: string | null = null;
let eventQueue: QueuedEvent[] = [];
let lastPollTime = 0;
let consecutiveErrors = 0;
let lastErrorAt: number | null = null;

const MAX_QUEUE_DEFAULT = 100;
const STALE_THRESHOLD_MS = 30_000;

// --- Helpers ---

function normalizeUrl(url: string): string {
  return url.replace(/\/+$/, "");
}

function resolveConfig(input: unknown): PluginConfig {
  const cfg = (input ?? {}) as Partial<PluginConfig>;
  const env = (typeof process !== "undefined" ? (process as unknown as { env: Record<string, string | undefined> }).env : {}) ?? {};
  const rawUrl = cfg.ruviewUrl ?? env.RUVIEW_API_URL ?? "http://localhost:3000";
  return {
    ruviewUrl: normalizeUrl(rawUrl),
    apiKey: cfg.apiKey ?? env.RUVIEW_API_KEY ?? undefined,
    pollIntervalMs: cfg.pollIntervalMs ?? 10000,
    confidenceThreshold: cfg.confidenceThreshold ?? 0.3,
    debounceCount: cfg.debounceCount ?? 2,
    enableDigest: cfg.enableDigest ?? true,
    enableZoneAwareness: cfg.enableZoneAwareness ?? false,
    maxQueueSize: cfg.maxQueueSize ?? MAX_QUEUE_DEFAULT,
    staleThresholdMs: cfg.staleThresholdMs ?? STALE_THRESHOLD_MS,
  };
}

function buildHeaders(apiKey?: string): Record<string, string> {
  if (!apiKey) return {};
  return { Authorization: `Bearer ${apiKey}` };
}

async function fetchJson<T>(url: string, apiKey?: string, timeoutMs = 5000): Promise<T | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const headers = buildHeaders(apiKey);
    const res = await fetch(url, { signal: controller.signal, headers });
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
  source: string | null;
  topConfidence: number | null;
  timestamp: number | null;
} | null> {
  const data = await fetchJson<RuViewPoseResponse>(
    `${config.ruviewUrl}/api/v1/pose/current`,
    config.apiKey,
  );
  if (!data) {
    // null means unreachable / error — caller must NOT transition to away
    return null;
  }

  // Stale data check — warn if timestamp is too old
  if (data.timestamp && config.staleThresholdMs > 0) {
    const ageMs = Date.now() - data.timestamp * 1000;
    if (ageMs > config.staleThresholdMs) {
      // still use it, but caller could log
    }
  }

  const validPersons = (data.persons ?? []).filter((p) => p.confidence >= config.confidenceThreshold);
  const detected = validPersons.length > 0;
  const zone = detected ? (validPersons[0]?.zone ?? null) : null;
  const topConfidence = detected ? Math.max(...validPersons.map((p) => p.confidence)) : null;

  return { detected, zone, persons: validPersons.length, source: data.source ?? null, topConfidence, timestamp: data.timestamp ?? null };
}

async function checkZones(config: PluginConfig): Promise<RuViewZoneSummary | null> {
  if (!config.enableZoneAwareness) return null;
  return fetchJson<RuViewZoneSummary>(`${config.ruviewUrl}/api/v1/pose/zones/summary`, config.apiKey);
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
  detectedPersons: number;
  source: string | null;
} {
  return {
    state: currentState,
    zone: currentZone,
    awaySince,
    queuedEvents: eventQueue.length,
    detectedPersons: lastDetectedPersons,
    source: lastSource,
  };
}

export function getPresenceDiagnostics(): {
  state: PresenceState;
  previousState: PresenceState;
  zone: string | null;
  awaySince: number | null;
  queuedEvents: number;
  detectedPersons: number;
  source: string | null;
  emptyCheckCount: number;
  consecutiveErrors: number;
  lastErrorAt: number | null;
  isLive: boolean;
} {
  return {
    state: currentState,
    previousState,
    zone: currentZone,
    awaySince,
    queuedEvents: eventQueue.length,
    detectedPersons: lastDetectedPersons,
    source: lastSource,
    emptyCheckCount,
    consecutiveErrors,
    lastErrorAt,
    isLive: lastSource !== null && lastSource !== "simulate" && lastSource !== "simulated",
  };
}

export function queueEvent(event: Omit<QueuedEvent, "timestamp">): boolean {
  if (currentState !== "away") return false;
  if (eventQueue.length >= MAX_QUEUE_DEFAULT) {
    // drop oldest non-urgent to cap memory
    const idx = eventQueue.findIndex((e) => e.priority !== "urgent");
    if (idx !== -1) eventQueue.splice(idx, 1);
    else eventQueue.shift();
  }
  eventQueue.push({ ...event, timestamp: Date.now() });
  // enforce cap strictly
  if (eventQueue.length > MAX_QUEUE_DEFAULT) {
    eventQueue = eventQueue.slice(-MAX_QUEUE_DEFAULT);
  }
  return true;
}

export function flushQueue(): QueuedEvent[] {
  const flushed = [...eventQueue];
  eventQueue = [];
  return flushed;
}

// Test helper — reset all state (not exported as RPC, only for vitest)
export function _resetState(): void {
  currentState = "present";
  previousState = "present";
  awaySince = null;
  emptyCheckCount = 0;
  currentZone = null;
  lastDetectedPersons = 0;
  lastSource = null;
  eventQueue = [];
  lastPollTime = 0;
  consecutiveErrors = 0;
  lastErrorAt = null;
}

export function _setStateForTest(s: Partial<{ currentState: PresenceState; awaySince: number | null; eventQueue: QueuedEvent[] }>): void {
  if (s.currentState) currentState = s.currentState;
  if (s.awaySince !== undefined) awaySince = s.awaySince;
  if (s.eventQueue) eventQueue = s.eventQueue;
}

// --- Plugin ---

const ruviewPresencePlugin = {
  id: "ruview-presence",
  name: "RuView Presence",
  description:
    "Presence-aware agent behavior powered by RuView WiFi sensing. Detects user presence via WiFi CSI and adapts agent behavior.",

  register(api: OpenClawPluginApi) {
    const config = resolveConfig(api.pluginConfig);

    // validate
    if (config.pollIntervalMs < 1000) {
      api.logger.warn?.(`ruview-presence: pollIntervalMs ${config.pollIntervalMs} too low, clamping to 1000`);
      config.pollIntervalMs = 1000;
    }
    if (config.confidenceThreshold < 0 || config.confidenceThreshold > 1) {
      api.logger.warn?.(`ruview-presence: confidenceThreshold out of range, clamping to 0.3`);
      config.confidenceThreshold = 0.3;
    }

    const authNote = config.apiKey ? "auth=enabled" : "auth=off";
    api.logger.info?.(
      `ruview-presence: initialized (url=${config.ruviewUrl}, threshold=${config.confidenceThreshold}, debounce=${config.debounceCount}, ${authNote})`,
    );

    // Hook into each heartbeat cycle
    api.on("before_prompt_build", async () => {
      const now = Date.now();
      if (now - lastPollTime < config.pollIntervalMs) {
        return; // throttle — skip if polled recently
      }
      lastPollTime = now;

      const presence = await checkPresence(config);

      // --- Unreachable: keep last known state (fault tolerance) ---
      if (presence === null) {
        consecutiveErrors++;
        lastErrorAt = now;
        if (consecutiveErrors === 1 || consecutiveErrors % 10 === 0) {
          api.logger.warn?.(
            `ruview-presence: RuView unreachable at ${config.ruviewUrl} (errors=${consecutiveErrors}), keeping state=${currentState}`,
          );
        }
        return undefined;
      }

      // reachable — reset error counter
      consecutiveErrors = 0;

      // Track metadata for RPC queries
      lastDetectedPersons = presence.persons;
      lastSource = presence.source;

      // Warn about simulated vs live
      if (presence.source === "simulate" || presence.source === "simulated") {
        // only log once per session to avoid spam — use lastSource transition
        if (previousState === "present" && currentState === "present" && lastDetectedPersons > 0) {
          // no-op, already simulated
        }
      }

      previousState = currentState;

      if (!presence.detected) {
        // No one detected — RuView returned empty persons or all below threshold
        emptyCheckCount++;
        if (emptyCheckCount >= config.debounceCount && currentState !== "away") {
          currentState = "away";
          awaySince = Date.now();
          currentZone = null;
          api.logger.info?.(`ruview-presence: user away since ${new Date(awaySince).toISOString()}`);
        }
      } else {
        // Person detected above confidence threshold
        emptyCheckCount = 0;
        currentZone = presence.zone;

        if (currentState === "away") {
          currentState = "returned";
          api.logger.info?.(
            `ruview-presence: user returned` +
              ` (away for ${formatDuration(Date.now() - (awaySince ?? now))},` +
              ` confidence=${presence.topConfidence?.toFixed(2)}, zone=${presence.zone}, source=${presence.source})`,
          );
        } else {
          currentState = "present";
        }
      }

      // Fetch zone data if enabled (fire-and-forget, result available via RPC if needed)
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

    // Register gateway RPC methods so agents can query presence
    const gw = api as unknown as { registerGatewayMethod?: (name: string, handler: (params?: unknown) => unknown) => void };
    gw.registerGatewayMethod?.("ruview.presence", async () => {
      return getPresenceState();
    });

    gw.registerGatewayMethod?.("ruview.diagnostics", async () => {
      return getPresenceDiagnostics();
    });

    gw.registerGatewayMethod?.("ruview.health", async () => {
      // live probe — bypass throttle
      const probe = await checkPresence({ ...config, pollIntervalMs: 0 } as PluginConfig);
      if (probe === null) {
        return { ok: false, error: "RuView unreachable", lastSource, consecutiveErrors };
      }
      return { ok: true, source: probe.source, detected: probe.detected, persons: probe.persons, zone: probe.zone };
    });

    // Register a gateway RPC method to queue events
    gw.registerGatewayMethod?.("ruview.queueEvent", async (params: unknown) => {
      const event = params as Omit<QueuedEvent, "timestamp">;
      const queued = queueEvent(event);
      return { queued, total: eventQueue.length };
    });
  },
};

export default ruviewPresencePlugin;
