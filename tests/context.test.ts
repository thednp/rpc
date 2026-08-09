import { describe, expect, it, vi } from "vitest";
import {
  getRequestContext,
  provideRequestContext,
  redirect,
  type RequestEvent,
} from "../src/context.ts";

describe("provideRequestContext", () => {
  it("should provide the context inside the callback", () => {
    const init: RequestEvent = {
      request: { id: "req1" },
      response: { id: "res1" },
      redirect: () => undefined,
      locals: { user: "alice" },
    };
    provideRequestContext(init, () => {
      expect(getRequestContext()).toBe(init);
    });
    expect(getRequestContext.bind(null)).not.toBe(init);
  });

  it("should propagate locals mutated in the callback", () => {
    provideRequestContext(
      { request: {}, response: {}, redirect: () => undefined, locals: {} },
      () => {
        getRequestContext().locals.user = "bob";
        expect(getRequestContext().locals.user).toBe("bob");
      },
    );
  });

  it("should keep context isolated between nested calls", () => {
    const outer: RequestEvent = {
      request: {},
      response: {},
      redirect: () => undefined,
      locals: {},
    };
    provideRequestContext(outer, () => {
      const inner: RequestEvent = {
        request: {},
        response: {},
        redirect: () => undefined,
        locals: {},
      };
      provideRequestContext(inner, () => {
        expect(getRequestContext()).toBe(inner);
      });
      expect(getRequestContext()).toBe(outer);
    });
  });

  it("should persist across async boundaries within the callback", async () => {
    const init: RequestEvent = {
      request: {},
      response: {},
      redirect: () => undefined,
      locals: {},
    };
    await provideRequestContext(init, async () => {
      await Promise.resolve();
      expect(getRequestContext()).toBe(init);
    });
  });
});

describe("getRequestContext", () => {
  it("should throw outside of a request", () => {
    expect(() => getRequestContext()).toThrowError(
      "RequestEvent is not available outside of a request",
    );
  });
});

describe("redirect", () => {
  it("should delegate to the bound request-context redirect", () => {
    const ctxRedirect = vi.fn();
    provideRequestContext(
      {
        request: {},
        response: {},
        redirect: ctxRedirect,
        locals: {},
      },
      () => {
        redirect("/target");
        redirect("/other", 301);
      },
    );
    expect(ctxRedirect).toHaveBeenCalledWith("/target", 303);
    expect(ctxRedirect).toHaveBeenCalledWith("/other", 301);
  });

  it("should throw when called outside a request", () => {
    expect(() => redirect("/target")).toThrowError(
      "RequestEvent is not available outside of a request",
    );
  });
});
