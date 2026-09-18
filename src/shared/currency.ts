import type { DisplayCurrency } from "./types";

/** Legacy settings whitelist; currency conversion and usage accounting are not runtime features. */
export const SUPPORTED_CURRENCIES: readonly DisplayCurrency[] = ["USD", "CNY", "EUR"];
