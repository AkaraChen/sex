import { channel } from "node:diagnostics_channel";

/**
 * Every channel a published sex package publishes on, one per package. The names and the message shape are a public
 * contract. This is the one list: `diagnostics()` only takes a name from it, `subscribeAll` listens to all of it, and a
 * test fails when a package publishes on a name that is not here.
 */
export const CHANNELS = [
  "searxng-js:sex:browser",
  "searxng-js:sex:docs",
  "searxng-js:sex:jobs",
  "searxng-js:sex:llm",
  "searxng-js:sex:map",
  "searxng-js:sex:page",
  "searxng-js:sex:scrape",
  "searxng-js:sex:search",
  "searxng-js:sex:searxng",
  "searxng-js:sex:store",
] as const;

export type ChannelName = (typeof CHANNELS)[number];
export type Level = "debug" | "info" | "warn" | "error";

/** What is published on a channel. `fields` is a plain object, absent when the call had none. */
export interface DiagnosticMessage {
  level: Level;
  msg: string;
  fields?: Record<string, unknown>;
}

/** Console-shaped: `log.warn("something", { key: value })`. */
export interface Diagnostics {
  debug(msg: string, fields?: Record<string, unknown>): void;
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
}

/** A logger bound to one channel. Without a subscriber a call builds nothing and publishes nothing. */
export function diagnostics(name: ChannelName): Diagnostics {
  // Held for the life of the module: node keeps channel objects weakly, and a collected one would drop its subscribers.
  const ch = channel(name);
  const at =
    (level: Level) =>
    (msg: string, fields?: Record<string, unknown>): void => {
      if (!ch.hasSubscribers) return;
      const message: DiagnosticMessage = fields === undefined ? { level, msg } : { level, msg, fields };
      ch.publish(message);
    };
  return { debug: at("debug"), info: at("info"), warn: at("warn"), error: at("error") };
}

const subscriptions = new Set<unknown>();

/** Listens to every channel in `CHANNELS`; returns a function that stops listening. */
export function subscribeAll(onMessage: (message: DiagnosticMessage, name: ChannelName) => void): () => void {
  // The channel objects are held (module level) until the caller stops: some runtimes keep a channel with subscribers only weakly, and a
  // collected one would silently drop them.
  const held = CHANNELS.map((name) => {
    const handler = (message: unknown) => onMessage(message as DiagnosticMessage, name);
    const ch = channel(name);
    ch.subscribe(handler);
    return { ch, handler };
  });
  subscriptions.add(held);
  return () => {
    for (const { ch, handler } of held) ch.unsubscribe(handler);
    subscriptions.delete(held);
  };
}
