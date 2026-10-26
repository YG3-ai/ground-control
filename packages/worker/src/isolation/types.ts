export interface IsolationMount {
  /** Absolute host path */
  hostPath: string;
  /** Absolute container path */
  containerPath: string;
  readOnly: boolean;
}

export type OutputChunkHandler = (chunk: {
  stdout?: string;
  stderr?: string;
}) => void;

export interface IsolationRunSpec {
  image: string;
  command: string[];
  workdir: string;
  env: Record<string, string>;
  mounts: IsolationMount[];
  network: string;
  runAsUser: string;
  readOnlyRootfs: boolean;
  memoryMb: number;
  cpus: number;
  /** Extra docker args that are allowlisted by the runner only */
  name?: string;
  timeoutSec: number;
  /** Incremental log callback so get_task_output is non-empty while running. */
  onOutput?: OutputChunkHandler;
}

export interface IsolationRunResult {
  containerId: string | null;
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  killed: boolean;
}

export interface IsolationHandle {
  containerId: string;
  wait(): Promise<IsolationRunResult>;
  cancel(signal?: "SIGTERM" | "SIGKILL"): Promise<void>;
}

export interface IsolationBackend {
  readonly name: string;
  assertAvailable(): Promise<void>;
  run(spec: IsolationRunSpec): Promise<IsolationHandle>;
  /** Probe that a host path is NOT visible inside a throwaway container. */
  assertHostPathInvisible(hostPath: string): Promise<{ ok: true } | { ok: false; detail: string }>;
}
