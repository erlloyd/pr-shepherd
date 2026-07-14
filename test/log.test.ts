import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createLogger, setVerbose } from "../src/log.js";

describe("logger", () => {
  const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

  beforeEach(() => {
    logSpy.mockClear();
    errSpy.mockClear();
    setVerbose(false);
  });

  afterEach(() => {
    setVerbose(false);
  });

  it("formats as HH:MM:SS LEVEL [subsystem] message", () => {
    createLogger("review-inbox").info("hello world");
    expect(logSpy).toHaveBeenCalledTimes(1);
    expect(logSpy.mock.calls[0][0]).toMatch(/^\d{2}:\d{2}:\d{2} INFO  \[review-inbox\] hello world$/);
  });

  it("routes warn and error to stderr with level tokens", () => {
    const log = createLogger("daemon");
    log.warn("careful");
    log.error("boom");
    expect(logSpy).not.toHaveBeenCalled();
    expect(errSpy.mock.calls[0][0]).toMatch(/^\d{2}:\d{2}:\d{2} WARN  \[daemon\] careful$/);
    expect(errSpy.mock.calls[1][0]).toMatch(/^\d{2}:\d{2}:\d{2} ERROR \[daemon\] boom$/);
  });

  it("suppresses debug unless verbose", () => {
    const log = createLogger("conductor");
    log.debug("hidden");
    expect(logSpy).not.toHaveBeenCalled();
    setVerbose(true);
    log.debug("visible");
    expect(logSpy).toHaveBeenCalledTimes(1);
    expect(logSpy.mock.calls[0][0]).toMatch(/^\d{2}:\d{2}:\d{2} DEBUG \[conductor\] visible$/);
  });
});
