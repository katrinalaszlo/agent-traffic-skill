// Types for @katrinalaszlo/agent-traffic. Request and response are typed loosely so the package needs no @types/express and
// accountIdOf compiles under strict mode whatever your auth adds to them.
export interface AgentTrafficOptions {
  /** Your customer's id for this request (called after the response), or undefined when there is none. Hashed before it is sent. */
  accountIdOf?: (req: any, res: any) => string | number | null | undefined;
  /** Error text for a failed response (status 400 and above), or undefined. Sent as properties.error, up to 200 characters, so two errors with the same status show separately in Fix next. */
  errorOf?: (req: any, res: any) => string | null | undefined;
  /** Defaults to AGENT_TRAFFIC_KEY from the environment or .env. */
  key?: string;
  /** Defaults to AGENT_TRAFFIC_PROJECT_ID from the environment or .env. */
  projectId?: string;
  /** Defaults to AGENT_TRAFFIC_ACCOUNT_SALT from the environment or .env. Required when accountIdOf is set. */
  salt?: string;
  /** Defaults to AGENT_TRAFFIC_ENDPOINT, else https://traffic.katrinalaszlo.com. */
  endpoint?: string;
}

export function agentTraffic(options?: AgentTrafficOptions): (req: any, res: any, next: (err?: unknown) => void) => void;

/** The event name for a request: its route pattern, version and "api" segments dropped, the method added for anything but GET. */
export function eventName(req: any): string;
