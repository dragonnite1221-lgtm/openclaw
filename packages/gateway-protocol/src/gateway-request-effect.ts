/** Host-owned proof about whether a rejected Gateway request could have produced effects. */
export const GatewayRequestEffects = {
  NOT_STARTED: "not_started",
  FAILED_NO_EFFECT: "failed_no_effect",
} as const;

export type GatewayRequestEffect =
  (typeof GatewayRequestEffects)[keyof typeof GatewayRequestEffects];
