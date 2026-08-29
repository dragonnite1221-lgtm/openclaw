export * from "./capability-consent-error-details.js";
export * from "./clawhub-trust-error-details.js";
export * from "./install-policy-warning-error-details.js";
export * from "./system-agent-error-details.js";
export {
  ErrorCodes,
  GatewayErrorDetailCodes,
  GatewayRequestEffects,
  buildSkillProposalRevisionChangedErrorDetails,
  isMcpAppViewExpiredError,
  readCronJobNotFoundError,
  readMissingScopeError,
  readMissingScopeErrorDetails,
  readGatewayRequestEffect,
  readSkillProposalRevisionChangedError,
  withGatewayRequestFailedNoEffect,
  withGatewayRequestNotStarted,
} from "./gateway-error-details.js";
export type {
  CronJobNotFoundErrorDetails,
  GatewayErrorDetails,
  McpAppViewExpiredErrorDetails,
  OutboundDeliveryQueuedErrorDetails,
  MissingScopeErrorDetails,
  SkillProposalRevisionChangedErrorDetails,
  UserPrefsLimitExceededErrorDetails,
  ProjectCloneErrorDetails,
  ProjectCloneFailureCause,
  WizardNotFoundErrorDetails,
  SetupAdmissionBusyErrorDetails,
  GatewayRequestEffect,
} from "./gateway-error-details.js";
export {
  CronJobNotFoundErrorDetailsSchema,
  GatewayErrorDetailsSchema,
  MissingScopeErrorDetailsSchema,
  OutboundDeliveryQueuedErrorDetailsSchema,
  UserPrefsLimitExceededErrorDetailsSchema,
  ProjectCloneErrorDetailsSchema,
  SkillProposalRevisionChangedErrorDetailsSchema,
  WizardNotFoundErrorDetailsSchema,
  SetupAdmissionBusyErrorDetailsSchema,
  buildMissingScopeErrorDetails,
  errorShape,
  missingScopeErrorShape,
} from "./schema/error-codes.js";
