/*
 * Copyright (C) 2026 Sphericals
 * SPDX-License-Identifier: GPL-3.0-only WITH GPL-3.0-linking-exception
 * Affinity edition: see LICENSE-EXCEPTION.
 *
 * Admission, FIFO request slots and cancellation. Jobs run in id order with a
 * fixed number of concurrent provider requests.
 */

export class JobQueue {
  #jobs = new Map();
  #waiting = [];
  #active = 0;
  #sequence = 0;
  #listeners = new Set();

  constructor({ concurrency = 2, run }) {
    this.concurrency = Math.max(1, concurrency);
    this.run = run;
  }

  get size() {
    return this.#jobs.size;
  }

  get active() {
    return this.#active;
  }

  nextId() {
    this.#sequence += 1;
    return this.#sequence;
  }

  subscribe(listener) {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  #changed() {
    for (const listener of this.#listeners) listener();
  }

  add(job) {
    const entry = {
      state: "queued",
      status: "Waiting for a generation slot…",
      cancelRequested: false,
      dispatched: false,
      controller: null,
      error: null,
      result: null,
      ...job,
    };
    this.#jobs.set(entry.id, entry);
    this.#waiting.push(entry.id);
    this.#changed();
    this.pump();
    return entry;
  }

  get(id) {
    return this.#jobs.get(id) || null;
  }

  snapshot() {
    return [...this.#jobs.values()].map((job) => ({
      id: job.id,
      prompt: job.prompt,
      model: job.model,
      label: job.label,
      width: job.width,
      height: job.height,
      state: job.state,
      status: job.status,
      error: job.error,
      cancelRequested: job.cancelRequested,
      dispatched: job.dispatched,
      estimateUSD: job.estimateUSD ?? null,
      result: job.result,
      createdAt: job.createdAt,
    }));
  }

  cancel(id) {
    const job = this.#jobs.get(id);
    if (!job) return false;
    if (["done", "failed", "cancelled"].includes(job.state)) return false;
    job.cancelRequested = true;
    job.state = "cancelled";
    job.status = "Canceled.";
    const waitingIndex = this.#waiting.indexOf(id);
    if (waitingIndex >= 0) this.#waiting.splice(waitingIndex, 1);
    try {
      job.controller?.abort();
    } catch {
      /* The request may already have settled. */
    }
    this.#changed();
    return true;
  }

  cancelAll() {
    for (const id of [...this.#jobs.keys()]) this.cancel(id);
  }

  pump() {
    while (this.#active < this.concurrency && this.#waiting.length) {
      const id = this.#waiting.shift();
      const job = this.#jobs.get(id);
      if (!job || job.state !== "queued") continue;
      this.#active += 1;
      job.controller = new AbortController();
      job.state = "running";
      job.status = "Preparing request…";
      this.#changed();
      Promise.resolve()
        .then(() => this.run(job, job.controller.signal))
        .catch((error) => {
          if (job.state !== "cancelled") {
            job.state = "failed";
            job.error = typeof error?.message === "string" ? error.message : "Unexpected error.";
            job.status = `Error: ${job.error}`;
          }
        })
        .finally(() => {
          this.#active = Math.max(0, this.#active - 1);
          this.#changed();
          this.pump();
        });
    }
    this.#changed();
  }

  remove(id) {
    this.#waiting = this.#waiting.filter((value) => value !== id);
    return this.#jobs.delete(id);
  }
}
