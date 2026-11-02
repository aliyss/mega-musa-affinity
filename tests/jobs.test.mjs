import assert from "node:assert/strict";
import test from "node:test";

import { JobQueue } from "../lib/jobs.mjs";

function waitFor(predicate, timeout = 2000) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const tick = () => {
      if (predicate()) return resolve();
      if (Date.now() - started > timeout) return reject(new Error("Timed out waiting for the queue."));
      setTimeout(tick, 10);
    };
    tick();
  });
}

test("runs jobs with the configured concurrency", async () => {
  let active = 0;
  let peak = 0;
  const completed = [];
  const queue = new JobQueue({
    concurrency: 2,
    run: async (job) => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 10));
      active -= 1;
      completed.push(job.id);
      job.state = "done";
    },
  });

  for (let index = 0; index < 5; index += 1) queue.add({ id: index + 1, prompt: `p${index}` });
  await waitFor(() => completed.length === 5);
  assert.equal(peak, 2);
  assert.deepEqual(completed, [1, 2, 3, 4, 5]);
});

test("cancels queued jobs without running them", async () => {
  const started = [];
  const queue = new JobQueue({
    concurrency: 1,
    run: async (job) => {
      started.push(job.id);
      await new Promise((resolve) => setTimeout(resolve, 20));
      job.state = "done";
    },
  });

  queue.add({ id: 1, prompt: "first" });
  queue.add({ id: 2, prompt: "second" });
  assert.equal(queue.cancel(2), true);
  await waitFor(() => started.includes(1) && queue.get(1)?.state === "done");
  assert.deepEqual(started, [1]);
  assert.equal(queue.get(2).state, "cancelled");
  assert.equal(queue.cancel(2), false);
});

test("aborts a running job and reports cancellation", async () => {
  let aborted = false;
  const queue = new JobQueue({
    concurrency: 1,
    run: (job, signal) =>
      new Promise((resolve) => {
        signal.addEventListener("abort", () => {
          aborted = true;
          resolve();
        });
      }),
  });

  queue.add({ id: 1, prompt: "hangs" });
  await waitFor(() => queue.get(1).state === "running");
  queue.cancel(1);
  await waitFor(() => aborted);
  assert.equal(queue.get(1).state, "cancelled");
});

test("snapshot exposes the fields the panel needs", async () => {
  const queue = new JobQueue({ concurrency: 1, run: async (job) => { job.state = "done"; } });
  queue.add({ id: 1, prompt: "sunset", model: "gemini-3-pro-image", estimateUSD: 0.144 });
  await waitFor(() => queue.get(1).state === "done");
  const [job] = queue.snapshot();
  assert.equal(job.prompt, "sunset");
  assert.equal(job.state, "done");
  assert.equal(job.estimateUSD, 0.144);
  assert.equal(job.error, null);
});
