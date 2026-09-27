import type { OpenClawPluginApi } from "openclaw/plugin-sdk";

type GatewayMethodHandler = Parameters<OpenClawPluginApi["registerGatewayMethod"]>[1];
type GatewayRespond = Parameters<GatewayMethodHandler>[0]["respond"];

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
let lastDataAgeMs: number | null = null;
let lastZoneSummary: RuViewZoneSummary | null = null;

const MAX_QUEUE_DEFAULT = 100;
let maxQueueSize = MAX_QUEUE_DEFAULT;
const QUEUE_EVENT_TYPES: ReadonlySet<string> = new Set(["message", "task", "notification", "error"]);
const STALE_THRESHOLD_MS = 30_000;

// --- Helpers ---

function normalizeUrl(url: string): string {
  return url.replace(/\/+$/, "");
}

function resolveConfig(input: unknown): PluginConfig {
  const cfg = (input ?? {}) as Partial<PluginConfig>;
  const env = typeof process !== "undefined" ? process.env : {};
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
  ageMs: number | null;
} | null> {
  const data = await fetchJson<RuViewPoseResponse>(
    `${config.ruviewUrl}/api/v1/pose/current`,
    config.apiKey,
  );
  if (!data) {
    // null means unreachable / error — caller must NOT transition to away
    return null;
  }

  const validPersons = (data.persons ?? []).filter((p) => p.confidence >= config.confidenceThreshold);
  const detected = validPersons.length > 0;
  const zone = detected ? (validPersons[0]?.zone ?? null) : null;
  const topConfidence = detected ? Math.max(...validPersons.map((p) => p.confidence)) : null;

  // RuView timestamps are epoch seconds
  const ageMs = data.timestamp ? Date.now() - data.timestamp * 1000 : null;

  return { detected, zone, persons: validPersons.length, source: data.source ?? null, topConfidence, timestamp: data.timestamp ?? null, ageMs };
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
    // Urgent items were already delivered; count them separately from held ones
    if (event.priority === "urgent") {
      urgentCount++;
      continue;
    }
    byType[event.type] = (byType[event.type] ?? 0) + 1;
    if (event.channel) {
      byChannel[event.channel] = (byChannel[event.channel] ?? 0) + 1;
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

  const pending = eventQueue.filter((e) => e.priority !== "urgent");
  if (pending.length > 0) {
    lines.push("", "Queued items:");
    for (const event of pending.slice(-10)) {
      lines.push(`- [${event.type}${event.channel ? ` · ${event.channel}` : ""}] ${event.summary}`);
    }
    if (pending.length > 10) lines.push(`- …and ${pending.length - 10} more`);
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
  zones: RuViewZoneSummary["zones"] | null;
} {
  return {
    state: currentState,
    zone: currentZone,
    awaySince,
    queuedEvents: eventQueue.length,
    detectedPersons: lastDetectedPersons,
    source: lastSource,
    zones: lastZoneSummary?.zones ?? null,
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
  lastDataAgeMs: number | null;
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
    lastDataAgeMs,
    isLive: lastSource !== null && lastSource !== "simulate" && lastSource !== "simulated",
  };
}

/**
 * Returns true when the caller should hold the event (user away, non-urgent).
 * Urgent events are never held: they return false so the caller delivers them
 * now, but while away they are still recorded for the welcome-back digest.
 */
export function queueEvent(event: Omit<QueuedEvent, "timestamp">): boolean {
  if (currentState !== "away") return false;
  if (eventQueue.length >= maxQueueSize) {
    // drop oldest non-urgent to cap memory
    const idx = eventQueue.findIndex((e) => e.priority !== "urgent");
    if (idx !== -1) eventQueue.splice(idx, 1);
    else eventQueue.shift();
  }
  eventQueue.push({ ...event, timestamp: Date.now() });
  return event.priority !== "urgent";
}

function parseQueueEvent(params: Record<string, unknown>): Omit<QueuedEvent, "timestamp"> | string {
  const { type, summary, channel, priority } = params;
  if (typeof type !== "string" || !QUEUE_EVENT_TYPES.has(type)) {
    return `type must be one of: ${[...QUEUE_EVENT_TYPES].join(", ")}`;
  }
  if (typeof summary !== "string" || !summary.trim()) return "summary must be a non-empty string";
  if (channel !== undefined && typeof channel !== "string") return "channel must be a string";
  if (priority !== undefined && priority !== "normal" && priority !== "urgent") {
    return 'priority must be "normal" or "urgent"';
  }
  return {
    type: type as QueuedEvent["type"],
    summary: summary.trim().slice(0, 500),
    ...(channel ? { channel } : {}),
    ...(priority ? { priority } : {}),
  };
}

function respondError(respond: GatewayRespond, code: "INVALID_REQUEST" | "UNAVAILABLE", message: string): void {
  respond(false, undefined, { code, message });
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
  lastDataAgeMs = null;
  lastZoneSummary = null;
  maxQueueSize = MAX_QUEUE_DEFAULT;
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
    if (!Number.isInteger(config.debounceCount) || config.debounceCount < 1) {
      api.logger.warn?.(`ruview-presence: debounceCount ${config.debounceCount} invalid, using 2`);
      config.debounceCount = 2;
    }
    if (!Number.isInteger(config.maxQueueSize) || config.maxQueueSize < 1 || config.maxQueueSize > 500) {
      api.logger.warn?.(`ruview-presence: maxQueueSize ${config.maxQueueSize} invalid, using ${MAX_QUEUE_DEFAULT}`);
      config.maxQueueSize = MAX_QUEUE_DEFAULT;
    }
    maxQueueSize = config.maxQueueSize;

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

      // Log source changes once (e.g. simulated -> esp32) rather than every poll
      if (presence.source !== lastSource) {
        const simulated = presence.source === "simulate" || presence.source === "simulated";
        api.logger.info?.(
          `ruview-presence: source=${presence.source}` +
            (simulated ? " (synthetic data — presence will not reflect the real room)" : ""),
        );
      }

      // Warn once when data goes stale, not on every poll
      const isStale = presence.ageMs !== null && config.staleThresholdMs > 0 && presence.ageMs > config.staleThresholdMs;
      const wasStale = lastDataAgeMs !== null && config.staleThresholdMs > 0 && lastDataAgeMs > config.staleThresholdMs;
      if (isStale && !wasStale) {
        api.logger.warn?.(`ruview-presence: RuView data is stale (${formatDuration(presence.ageMs ?? 0)} old)`);
      }

      // Track metadata for RPC queries
      lastDetectedPersons = presence.persons;
      lastSource = presence.source;
      lastDataAgeMs = presence.ageMs;

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

      // Zone data is exposed via ruview.presence; refresh it on empty reads too so it never goes stale
      if (config.enableZoneAwareness) {
        lastZoneSummary = (await checkZones(config)) ?? lastZoneSummary;
      }

      if (currentState !== "returned") return undefined;

      // On return: build the digest (if enabled) and always clear the queue so
      // events from this absence don't leak into the next one
      const digest = config.enableDigest ? buildDigest() : "";
      flushQueue();
      currentState = "present";
      awaySince = null;

      return digest ? { prependContext: digest } : undefined;
    });

    // Gateway RPC methods so agents can query presence. Handlers reply via
    // respond(); return values are ignored by the gateway.
    api.registerGatewayMethod(
      "ruview.presence",
      ({ respond }) => respond(true, getPresenceState()),
      { scope: "operator.read" },
    );

    api.registerGatewayMethod(
      "ruview.diagnostics",
      ({ respond }) => respond(true, getPresenceDiagnostics()),
      { scope: "operator.read" },
    );

    api.registerGatewayMethod(
      "ruview.health",
      async ({ respond }) => {
        // live probe — bypasses the heartbeat throttle
        const probe = await checkPresence(config);
        if (probe === null) {
          respondError(respond, "UNAVAILABLE", `RuView unreachable at ${config.ruviewUrl}`);
          return;
        }
        respond(true, {
          ok: true,
          source: probe.source,
          detected: probe.detected,
          persons: probe.persons,
          zone: probe.zone,
          dataAgeMs: probe.ageMs,
        });
      },
      { scope: "operator.read" },
    );

    api.registerGatewayMethod(
      "ruview.queueEvent",
      ({ params, respond }) => {
        const event = parseQueueEvent(params ?? {});
        if (typeof event === "string") {
          respondError(respond, "INVALID_REQUEST", event);
          return;
        }
        const queued = queueEvent(event);
        respond(true, { queued, total: eventQueue.length });
      },
      { scope: "operator.write" },
    );
  },
};

export default ruviewPresencePlugin;
