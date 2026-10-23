// Types for @katrinalaszlo/track. Request and response are typed loosely so the package needs no @types/express and
// accountIdOf compiles under strict mode whatever your auth adds to them.
export interface AgentTrafficOptions {
  /** Your customer's id for this request (called after the response), or undefined when there is none. Hashed before it is sent. */
  accountIdOf?: (req: any, res: any) => string | number | null | undefined;
  /** Error text for a failed response (status 400 and above), or undefined. Sent as properties.error, up to 200 characters, so two errors with the same status show separately in Fix next. */
  errorOf?: (req: any, res: any) => string | null | undefined;
  /** Defaults to AGENT_TRAFFIC_KEY from the environment or .env. */
  key?: string;
  /** Defaults to AGENT_TRAFFIC_PROJECT_ID from the environment or .env. Optional: without it, events go to the key's own project. */
  projectId?: string;
  /** Defaults to AGENT_TRAFFIC_ACCOUNT_SALT from the environment or .env. Required when accountIdOf is set. */
  salt?: string;
  /** Defaults to AGENT_TRAFFIC_ENDPOINT, else https://alg.katrinalaszlo.com. */
  endpoint?: string;
  /**
   * Off by default. When true, every response carries the visitor's journey key: the one the request sent (Track-Journey
   * header, ?track_j= query parameter or track_j cookie), else a new "j_" + 32 hex key. It is set as the Track-Journey
   * response header and as `Set-Cookie: track_j=<key>; Path=/; Max-Age=1209600; SameSite=Lax; Secure`, with
   * `Cache-Control: private`. Opt-in because it sets a cookie on your responses and stops shared caches from storing them.
   */
  issueJourneyKeys?: boolean;
}

/** The request and response header that carries a journey key: "Track-Journey". */
export const JOURNEY_HEADER: string;

/** Fields the middleware adds to an event when the request carried a valid journey key; both or neither. */
export interface JourneyFields {
  /** 8 to 128 characters of A-Z, a-z, 0-9, _ and -. */
  journey_id: string;
  /** "issued" when issueJourneyKeys minted the key on this request's response, or a handoff link gave the request the agent's journey. */
  journey_source: "header" | "query" | "cookie" | "issued";
}

/** The query parameter a handoff link carries: "track_h". */
export const HANDOFF_PARAM: string;

export interface HandoffOptions {
  /** A request the middleware saw: its journey key (after any handoff) is the agent's journey to hand off. */
  req?: any;
  /** The agent's journey key, when you have it without a request. Wins over req. */
  journeyId?: string;
}

export interface OutcomeInput {
  /** The same customer id accountIdOf returns for this customer's requests. Hashed with the salt before it is sent. */
  accountId: string | number;
  name: "signup" | "key_created" | "activation" | "paid" | "custom";
  /** Whole minor units: 1999 for $19.99. Required for paid. */
  value?: number;
  /** ISO 4217 code such as "USD". Required when value is set. */
  currency?: string;
  /** Your payment event id or signup id: a retried webhook with the same key is counted once. */
  idempotencyKey: string;
  /** When it happened; defaults to now. */
  occurredAt?: Date | string;
}

export interface AgentTrafficMiddleware {
  (req: any, res: any, next: (err?: unknown) => void): void;
  /** Sends one outcome at once. Throws synchronously on bad input; the returned promise settles when the send finished. */
  recordOutcome(outcome: OutcomeInput): Promise<void>;
  /**
   * Resolves with `link` plus `?track_h=<token>`, a one-time token (24 hours) that puts the person who opens the link
   * on the agent's journey. Throws synchronously when link is not absolute or there is no valid journey key. When Track
   * cannot mint a token, logs it and resolves with `link` unchanged.
   */
  handoffUrl(link: string, options: HandoffOptions): Promise<string>;
  /** The journey key the middleware recorded this request with (the agent's, when a handoff link linked it), or undefined. */
  journeyIdOf(req: any): string | undefined;
}

/**
 * Each event the middleware records carries `path`: the request path as the app received it (router mount prefix
 * included, not percent-decoded), cut at the first "?" or "#", so never the domain or the query. Left out when it does
 * not start with "/" or is longer than 2048 characters. Ids in path segments (/v1/users/123) are sent as they are.
 * A request with a well-formed ?track_h= waits up to 2 seconds for Track to link it, before your routes run.
 */
export function agentTraffic(options?: AgentTrafficOptions): AgentTrafficMiddleware;

/** The event name for a request: its route pattern without router mount prefixes, version and "api" segments dropped, the method added for anything but GET. */
export function eventName(req: any): string;
