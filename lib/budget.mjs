/*
 * Copyright (C) 2026 Sphericals
 * SPDX-License-Identifier: GPL-3.0-only WITH GPL-3.0-linking-exception
 * Affinity edition: see LICENSE-EXCEPTION.
 *
 * USD spending totals. Generation and Describe counters are disjoint; a null price
 * counts as unpriced, and a request cancelled after dispatch keeps its estimate.
 */

export function addToBudget(store, usd, cancelled = false) {
  const value = { ...store.budget() };
  if (usd !== null) value.usd += usd;
  if (cancelled) value.cancelled += 1;
  else if (usd === null) value.unpriced += 1;
  else value.images += 1;
  return store.saveBudget(value);
}

export function addDescriptionToBudget(store, usd, imageCount, cancelled = false, estimated = false) {
  const value = { ...store.budget() };
  if (usd !== null) value.usd += usd;
  else value.unpriced += 1;
  value.imagesAnalyzed += imageCount;
  if (cancelled) value.analysisCancelled += imageCount;
  if (estimated) value.analysisEstimates += imageCount;
  return store.saveBudget(value);
}

const MONTHS = "Jan Feb Mar Apr May Jun Jul Aug Sep Oct Nov Dec".split(" ");

export function formatDate(iso) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "—";
  return `${date.getDate()} ${MONTHS[date.getMonth()]} ${date.getFullYear()}`;
}

// Counts stay separate from the formatted total so the panel can lay them out.
export function budgetCounts(budget) {
  const analysisDetails = [];
  if (budget.analysisCancelled) analysisDetails.push(`${budget.analysisCancelled} canceled`);
  if (budget.analysisEstimates) analysisDetails.push(`${budget.analysisEstimates} estimated`);
  const analyzed =
    `${budget.imagesAnalyzed} image${budget.imagesAnalyzed === 1 ? "" : "s"} described` +
    (analysisDetails.length ? ` (${analysisDetails.join(", ")})` : "");
  const counts = [`${budget.images} images`, analyzed];
  if (budget.unpriced) counts.push(`${budget.unpriced} unpriced`);
  if (budget.cancelled) counts.push(`${budget.cancelled} image requests canceled after dispatch`);
  return `(${counts.join(", ")})`;
}
