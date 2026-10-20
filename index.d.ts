// Types for agent-traffic. Request and response are typed loosely so the package needs no @types/express and
// accountIdOf compiles under strict mode whatever your auth adds to them.
export interface AgentTrafficOptions {
  /** Your customer's id for this request (called after the response), or undefined when there is none. Hashed before it is sent. */
  accountIdOf?: (req: any, res: any) => string | number | null | undefined;
  /** Defaults to TANSO_KEY from the environment or .env. */
  key?: string;
  /** Defaults to TANSO_PROJECT_ID from the environment or .env. */
  projectId?: string;
  /** Defaults to TANSO_ACCOUNT_SALT from the environment or .env. Required when accountIdOf is set. */
  salt?: string;
  /** Defaults to TANSO_ENDPOINT, else https://traffic.katrinalaszlo.com. */
  endpoint?: string;
}

export function agentTraffic(options?: AgentTrafficOptions): (req: any, res: any, next: (err?: unknown) => void) => void;

/** The event name for a request: its route pattern, version and "api" segments dropped, the method added for anything but GET. */
export function eventName(req: any): string;
