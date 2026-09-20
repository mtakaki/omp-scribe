/**
 * Minimal fake for the oh-my-pi agent SDK: AgentRegistry, AgentSession, and
 * createAgentSession — covering exactly the surface that writer-session.ts touches.
 *
 * Usage:
 *   const { fakeSdk, setScript } = createFakeSdk();
 *   // Inject into the fake ExtensionAPI:
 *   (fakePi.pi as any).pi = fakeSdk;
 *   setScript([
 *     { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "Hello" } },
 *     { type: "message_end", message: { role: "assistant", usage: { input: 10, output: 5, cost: { input: 0.003, output: 0.006, cacheRead: 0, cacheWrite: 0, total: 0.009 } }, provider: "anthropic", model: "claude-haiku" } },
 *     { type: "agent_end", isTerminal: true },
 *   ]);
 *   const result = await expandBlueprintToMarkdown(pi, ctx, "@smol", blueprint);
 */

export type FakeSessionEvent =
  | { type: "message_update"; assistantMessageEvent: { type: "text_delta"; delta: string } }
  | { type: "message_end"; message: { role: string; usage: { input: number; output: number; cost: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number } }; provider: string; model: string } }
  | { type: "agent_end"; isTerminal?: boolean };

export interface FakeAgentSession {
  subscribe(listener: (evt: FakeSessionEvent) => void): () => void;
  prompt(text: string): Promise<void>;
  dispose(): Promise<void>;
  /** Last user message passed to prompt(). */
  lastPrompt: string | undefined;
  disposed: boolean;
}

export function createFakeAgentSession(getScript: () => FakeSessionEvent[]): FakeAgentSession {
  const listeners: Array<(evt: FakeSessionEvent) => void> = [];
  let lastPrompt: string | undefined;
  let disposed = false;

  return {
    get lastPrompt() { return lastPrompt; },
    get disposed() { return disposed; },
    subscribe(listener: (evt: FakeSessionEvent) => void) {
      listeners.push(listener);
      return () => {
        const idx = listeners.indexOf(listener);
        if (idx >= 0) listeners.splice(idx, 1);
      };
    },
    async prompt(text: string): Promise<void> {
      lastPrompt = text;
      const script = getScript();
      for (const evt of script) {
        for (const l of [...listeners]) {
          l(evt);
        }
      }
    },
    async dispose(): Promise<void> {
      disposed = true;
    },
  };
}

export interface FakeSdk {
  AgentRegistry: new () => object;
  SessionManager: { inMemory: (cwd: string) => object };
  createAgentSession: (opts: unknown) => Promise<{ session: FakeAgentSession }>;
}

export interface FakeSdkHandle {
  fakeSdk: FakeSdk;
  /** Replace the event script emitted by the next session. */
  setScript(events: FakeSessionEvent[]): void;
  /** The last session created (undefined before first call). */
  lastSession(): FakeAgentSession | undefined;
  /** Number of sessions created. */
  sessionCount(): number;
  /** Whether the last session was disposed. */
  lastSessionDisposed(): boolean;
}

export function createFakeSdk(): FakeSdkHandle {
  let script: FakeSessionEvent[] = [];
  const sessions: FakeAgentSession[] = [];

  const fakeSdk: FakeSdk = {
    AgentRegistry: class {},
    SessionManager: { inMemory: (_cwd: string) => ({}) },
    async createAgentSession(_opts: unknown): Promise<{ session: FakeAgentSession }> {
      const session = createFakeAgentSession(() => script);
      sessions.push(session);
      return { session };
    },
  };

  return {
    fakeSdk,
    setScript(events: FakeSessionEvent[]) {
      script = events;
    },
    lastSession() {
      return sessions[sessions.length - 1];
    },
    sessionCount() {
      return sessions.length;
    },
    lastSessionDisposed() {
      const s = sessions[sessions.length - 1];
      return s?.disposed ?? false;
    },
  };
}
