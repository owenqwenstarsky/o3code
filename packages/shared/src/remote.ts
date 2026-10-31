const PAIRING_APP_LINK_PARAM = "pairingUrl";

/** Wraps a pairing URL in a `t3code://pair` link. */
export const buildPairingAppLink = (pairingUrl: string): string =>
  `t3code://pair?${new URLSearchParams([[PAIRING_APP_LINK_PARAM, pairingUrl]])}`;
