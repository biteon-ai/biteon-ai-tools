export class PolicyError extends Error {
  readonly code = "policy";
}

export class WorkflowError extends Error {
  readonly code = "workflow";
}

export class ConfigError extends Error {
  readonly code = "config";
}
