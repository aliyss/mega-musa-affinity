/*
 * Copyright (C) 2026 Sphericals
 * SPDX-License-Identifier: GPL-3.0-only WITH GPL-3.0-linking-exception
 * Affinity edition: see LICENSE-EXCEPTION.
 *
 * Display conversion only. All pricing and budget amounts remain USD.
 */

export function formatMoney(usd, { currency = "USD", rate = 1, decimals } = {}) {
  const amount = usd * rate;
  const digits = decimals ?? (amount < 0.01 ? 3 : 2);
  return `${currency} ${amount.toFixed(digits)}`;
}

export function formatMoneyRange(lowUSD, highUSD, options = {}) {
  if (lowUSD === highUSD) return formatMoney(lowUSD, options);
  const high = highUSD * (options.rate ?? 1);
  return `${formatMoney(lowUSD, options)}–${high.toFixed(high < 0.01 ? 3 : 2)}`;
}
